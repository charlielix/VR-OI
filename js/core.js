'use strict';
/* =========================================================================
   core —— 基础层
   ---------------------------------------------------------------------
   本文件不做任何渲染准备，只提供：
     · 数学工具与字符串哈希（判题抖动用确定性随机，避免反复提交刷分）
     · 全局 state
     · 几何 / 材质缓存（同尺寸的箱子只建一次几何、同参数的材质只建一次）
     · AABB 障碍碰撞（分轴滑动的极简实现）
     · WebAudio 合成音效（无任何音频资源文件）
     · DOM 引用与视角手感设置（localStorage）
   ========================================================================= */

/* ---------------------------- 数学工具 ---------------------------- */
const $ = id => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : (v > b ? b : v));
const lerp = (a, b, t) => a + (b - a) * t;
const TAU = Math.PI * 2;

function fmtTime(sec){
  sec = Math.max(0, Math.floor(sec));
  const h = String(Math.floor(sec / 3600)).padStart(2, '0');
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return h + ':' + m + ':' + s;
}

/* FNV-1a：稳定、快速、无依赖 */
function hashStr(s){
  let h = 2166136261;
  for (let i = 0; i < s.length; i++){
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/* mulberry32：同种子必得同序列 —— 判题结果的"随机"必须可复现 */
function mulberry32(seed){
  let a = seed >>> 0;
  return function(){
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickFrom(arr, rng){
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

/* ---------------------------- 全局状态 ---------------------------- */
const CONTEST_LEN = 4 * 3600;          /* 比赛时长（虚拟秒） */
const PROBLEM_COUNT = 4;               /* 抽题数 */
const TOTAL_MAX = 400;

/* 玩家座位中心（世界坐标）。紧张值的"坐定了"判定、走动检测、
   洗手间返回的复位点都以它为基准，所以放在 core 而不是散在各处 */
const SEAT_CENTER_X = 0, SEAT_CENTER_Z = -3;

/* ---------------------------- 跨模块共享的交互半径 ----------------------------
   为什么这些数字必须住在 core.js：
     core.js 是 index.html 里第一个逻辑脚本，它的顶层 let/const 在任何其他
     文件被解析之前就已经初始化完毕。而用传统 <script> 共享全局作用域时，
     后加载文件里的 let/const 对先加载的文件而言处于"暂时性死区"——
     一旦先加载文件在加载期就碰了它们，报的是
     ReferenceError: Cannot access 'X' before initialization，
     错误信息指向的位置和真正的病因往往差十万八千里。
     曾经就踩过：combat.js 用了 guards.js 的拳锋常量，而 combat.js 先加载。
     结论：只要一个常量被两个以上文件读写，就把它放在这里。
   不放进来的：只被单一文件使用的私有实现细节（例如守卫的刷怪距离、
   老师的巡逻参数），那些留在各自文件里更利于阅读。 */
const PUNCH_ARC = 0.4;             /* 出拳扇形的半角（弧度，约 23°） */
const GUARD_PUNCH_RANGE = 2.2;     /* 拳锋能打到保安的距离 */
const GUARD_HIT_RADIUS = 0.95;     /* 保安抓到玩家的距离 */
const TEACHER_PUNCH_RANGE = 2.4;   /* 拳锋能打到监考的距离 */
const NPC_DISTURB_RANGE = 0.72;    /* 能伸手干扰同学的距离 */
const GUARD_MAX_TOTAL = 200;       /* 一局最多能派出多少名保安（打满触发隐藏结局） */

/* ---------------------------- 区域（校园 / 考场房间） ----------------------------
   世界里有两块互不相干的空间，靠切换"障碍表 + 移动边界"来回走：
     campus  校园：从校门口出发，走到第三教学楼、过安检、进 404 教室
     room    考场房间：原来的考场（world.js 建的那间）
   两块空间坐标是错开的（校园整体在 +Z 很远处），所以切换时不需要销毁任何
   几何体 —— 代价只是空间开销，换来的是"来回切换零卡顿、零重建风险"。
   障碍表 obstacles 是全局的：切换时清空并按目标区域重建。 */
const AREA_BOUNDS = {
  /* 单位说明 —— 这里踩过一次坑，写清楚：
     state.pos 是【世界坐标】，player.js 用它来钳制移动；
     而房间在原点附近、校园整体平移到 +Z 500（见 campusdata.js 的 CP）。
     所以两张边界表都必须是世界坐标：
       · room   本来就以原点为中心，±6.5 与世​​界坐标重合，直接写就行；
       · campus 必须把 CP.z 加进去，否则 zMin/zMax 只有 -29.2~15.2，
         而玩家在 z≈511 —— 钳制框和玩家根本不在同一段空间里，
         结果是每一步移动都被钳回出生点，人完全走不动。
     校园横向只需覆盖 CAMPUS_HALF_W(13) + 围墙，12.4 的余量刚好够。 */
  campus: { x: 12.4, zMin: CP.z - 29.2, zMax: CP.z + 15.2 },
  /* 房间：+X 放宽到门洞外，好让人真的走出 404（门洞见 registerRoomObstacles） */
  room:   { x: 8.7, zMin: -6.5, zMax: 6.5 },
  /* 楼内走廊：非对称 x（只在东侧），2F 是 +Z 偏移的平行街区。
     用 xMin/xMax 覆盖默认的 ±x 对称钳制（见 player.js 的 updatePlayer） */
  hall1:  { xMin: 7.4, xMax: 30, zMin: -27, zMax: 27 },
  hall2:  { xMin: 7.4, xMax: 30, zMin: 33,  zMax: 87 }
};

const state = {
  started: false, ended: false, frozen: false,
  area: 'campus',                      /* campus | room —— 当前所处区域 */
  bounds: AREA_BOUNDS.campus,          /* player.js 的移动钳制范围，随区域切换 */
  view: 'world',                       /* world | pause | code | paper | corridor | bathroom | npcComputer | launcher | bag */
  elapsed: 0,                          /* 考试时钟：从进入考场开始算（已乘时间流速） */
  admitElapsed: 0,                     /* 入场阶段时钟：从点"开始"到进楼前，考试时钟为 0 */
  examStarted: false,                  /* 考试时钟是否已经启动 */
  entryArrival: 0,                     /* 通过门禁那一刻的入场时间，用于换算迟到 */
  yaw: 0, pitch: 0,
  pos: null,                           /* new THREE.Vector3 —— three 就绪后赋值 */
  keys: {},
  code: {}, score: {},
  /* 同学的题不再共用全局字段 —— 按名字算（见 npc.js 的 npcProblemId） */
  problems: [], curProb: '',
  totalScore: 0,
  warnCount: 0, wanderCount: 0, wanderTimer: 0, wanderPenaltyApplied: false,
  mischief: 0,                         /* 累计干扰外班同学的次数（解锁"串门捣蛋"） */
  leftRoomOnce: false,                 /* 未经许可出门过一次（解锁"开小差"） */
  teacherWarnActive: false, bathroomApproved: false, teacherDown: false,
  hp: 3, hpVisible: false, lastDamageAt: -999,
  doorOpen: false,
  guardKills: 0, guardsSpawned: 0, defiance: 0,
  submitCount: {}, achievements: new Set(),
  /* 对手排名（见 rivals.js）：每个选手被干扰后的交卷延迟，按名字索引 */
  npcDelay: {},
  /* 上一帧的名次。名次一变就播一句通报 —— 否则"谁超过了你"完全不可见，
     玩家只会得出"我一直第一名、别人好像不会得分"。 */
  lastRank: 0,
  worldTime: 0,                        /* 世界时钟：吃顿帧与慢放，受击间隔以它为准 */
  slowMoDlg: null,                     /* 通报弹窗句柄：guards.js 写、main.js 读 */
  bob: 0,
  /* ---- 校园进度 ---- */
  passedSecurity: false,               /* 已过安检（过完才能进楼） */
  enteredRoom: false,                  /* 已经进入 404 教室（进入后老师开始管你） */
  portalUsed: false,                   /* 用过传送圈（解锁一个成就） */
  /* 自动售货机：余额与剩余库存。开局 12 元，商品买齐 20 元 —— 必须取舍。
     库存也跟存档走，不然读档可以把同一台机器刷空两次。 */
  cardBalance: VENDING_START_BALANCE,
  vendingStock: Object.fromEntries(VENDING_GOODS.map(g => [g.id, g.stock])),
  /* 手机：开局就在兜里。过安检会被封存；从员工通道溜进来则还在。
     带进考场之后按 P 能看实时战况 —— 但被监考抓到就没收了。 */
  hasPhone: true,
  phoneUsed: false,                    /* 在考场里用过（解锁"夹带"） */
  phoneTab: 'status',                  /* 手机当前停在哪个软件 */
  calcExpr: '',                        /* 计算器输入串 */
  /* 手机上那个 2048：16 格一维数组 + 分数。纯状态机，没有定时器，
     所以测试可以直接喂一个盘面进去断言合并结果。 */
  g2048: null,
  g2048Best: 0,
  /* 武器耐久：id → 还能抡几下。没键就是满的（第一次抡才记）。
     不放进 bag 里，是因为 bag 只存 {id, n}，数量对武器没有意义。 */
  weaponWear: {},
  /* 手上那件近战武器（'' = 空手）。它**不占快捷栏** ——
     快捷栏留给消耗品（Q），左键永远抡手上这件。
     以前武器要占一格，于是打架时得在"武器 / 水 / 臭水"之间来回切，纯属自找麻烦。 */
  weapon: '',
  sneakedIn: false,                    /* 没走安检，从员工通道进的楼 */
  missedEntry: false,                  /* 入场预留 + 4 小时都没进楼 —— 本场缺考 */
  entryWarned: false,                  /* 入场预留快结束的广播已经响过了 */
  dinoHigh: 0,                         /* 小恐龙最高分 */
  /* ---- 背包 / 物品栏 ---- */
  bag: [],                             /* [{ id, n }] 持有列表（存储层，见 items.js） */
  hotbar: ['', '', '', ''],            /* 快捷栏 4 格，存物品 id（操作层） */
  hotbarIdx: 0,                        /* 当前选中的快捷栏格子 */
  spicyUntil: 0                        /* 辣条加速到期的世界时钟（秒） */
};

/* ---------------------------- 几何 / 材质缓存 ---------------------------- */
const geoCache = new Map();
const matCache = new Map();

function getBoxGeo(w, h, d){
  const k = w + '|' + h + '|' + d;
  let g = geoCache.get(k);
  if (!g){ g = new THREE.BoxGeometry(w, h, d); geoCache.set(k, g); }
  return g;
}
function getSphereGeo(r, sw, sh){
  const k = 'S' + r + '|' + sw + '|' + sh;
  let g = geoCache.get(k);
  if (!g){ g = new THREE.SphereGeometry(r, sw, sh); geoCache.set(k, g); }
  return g;
}
function mat(color, opts){
  const k = color + '|' + JSON.stringify(opts || {});
  let m = matCache.get(k);
  if (!m){
    m = new THREE.MeshStandardMaterial(Object.assign(
      { color: color, roughness: 0.88, metalness: 0.04 }, opts || {}));
    matCache.set(k, m);
  }
  return m;
}
/* 建一个盒子并挂到 parent 上（省掉每处 6 行样板代码） */
function box(w, h, d, color, x, y, z, parent, opts){
  const m = new THREE.Mesh(getBoxGeo(w, h, d), mat(color, opts));
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

/* Canvas 贴图：把 2D 画布变成纹理的统一样式入口 */
const THREE_SRGB = !!(THREE.SRGBColorSpace ||
                      (THREE.sRGBEncoding !== undefined && THREE.sRGBEncoding !== null));
function applySRGB(tex){
  if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;   /* r152+ */
  else if (THREE.sRGBEncoding !== undefined) tex.encoding = THREE.sRGBEncoding;
  return tex;
}
function canvasTex(canvas, srgb){
  const t = new THREE.CanvasTexture(canvas);
  t.anisotropy = 4;
  if (srgb) applySRGB(t);
  return t;
}
function makeCanvas(w, h){
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return { c: c, ctx: c.getContext('2d') };
}

/* ---------------------------- AABB 碰撞 ---------------------------- */
const obstacles = [];                 /* { x, z, hw, hd } */
function addObstacle(x, z, hw, hd){ obstacles.push({ x: x, z: z, hw: hw, hd: hd }); }

function collides(x, z, r){
  for (let i = 0; i < obstacles.length; i++){
    const o = obstacles[i];
    if (Math.abs(x - o.x) < o.hw + r && Math.abs(z - o.z) < o.hd + r) return true;
  }
  return false;
}

/* ---------------------------- 音频（全部现场合成） ---------------------------- */
const audio = {
  ctx: null, master: null, muted: false, volume: 0.6,
  init(){
    if (this.ctx) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : this.volume;
      this.master.connect(this.ctx.destination);
    } catch(e){ this.ctx = null; }
  },
  resume(){
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  },
  setVolume(v){
    this.volume = clamp(v, 0, 1);
    if (this.master) this.master.gain.value = this.muted ? 0 : this.volume;
  },
  setMuted(m){
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : this.volume;
  },
  /* 噪声缓冲：脚步、拳头都靠它 */
  _noise(dur, decay){
    const n = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / decay);
    return buf;
  },
  key(){
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = 'square';
    o.frequency.value = 1400 + Math.random() * 900;
    g.gain.setValueAtTime(0.012, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.035);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + 0.04);
  },
  step(){
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const s = this.ctx.createBufferSource();
    s.buffer = this._noise(0.06, 380);
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 800;
    const g = this.ctx.createGain(); g.gain.value = 0.05;
    s.connect(f); f.connect(g); g.connect(this.master);
    s.start(t);
  },
  punch(){
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const s = this.ctx.createBufferSource();
    s.buffer = this._noise(0.16, 700);
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 520;
    const g = this.ctx.createGain(); g.gain.value = 0.5;
    s.connect(f); f.connect(g); g.connect(this.master);
    s.start(t);
    const o = this.ctx.createOscillator(), g2 = this.ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.25);
    g2.gain.setValueAtTime(0.4, t);
    g2.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    o.connect(g2); g2.connect(this.master);
    o.start(t); o.stop(t + 0.32);
  },
  beep(freq, dur, vol, type){
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(Math.max(0.0001, vol), t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }
};

/* ---------------------------- 全局引用（boot 后填充） ---------------------------- */
let scene = null, camera = null, renderer = null, clock = null;
const raycaster = new THREE.Raycaster();
raycaster.layers.enable(1);           /* 准星/弹窗在 UI 层，射线要能打中 */
const CENTER = new THREE.Vector2(0, 0);
const interactables = [];             /* 桌上可交互物（水杯 / 草稿纸 / 屏幕） */
const deskScreens = [];               /* 每台显示器的 {ctx,tex}，用于刷新贴图 */
let actionE = null, actionF = null, actionSpace = null;
let npcs = [], teacher = null, securityGuards = [];
let achTimer = null, hitStop = 0, nearestGuardDist = Infinity, lastMoveSpeed = 0;

/* 强制重绘一帧。本来声明在 main.js（主循环所在），但 campus.js 的
   switchArea() 也要置位它 —— 而 campus.js 先加载。跨文件读写在加载期
   看着没事，可一旦有人在 init 阶段就调 switchArea，main.js 顶层的 let
   还在暂时性死区里，报出来是 "Cannot access 'forceRedraw' before
   initialization"，指向的位置和病因完全对不上。
   规则很简单：两个以上文件用到的可变句柄，住在 core.js。
   （tools/tdzscan.mjs 就是这么把它揪出来的。） */
let forceRedraw = false;

/* DOM 引用 —— 全部在脚本加载时就取好，避免热路径里反复查 DOM */
const hud = $('hud'), promptEl = $('prompt'), crosshair = $('crosshair');
const hudTimer = $('hudTimer'), hudScore = $('hudScore'), hudProbs = $('hudProbs');
const codeUI = $('codeUI'), codeArea = $('codeArea'), verdictEl = $('verdict');
const codeHighlight = $('codeHighlight');
const paperUI = $('paperUI'), paperCanvas = $('paperCanvas');
/* 手机面板（见 phone.js）—— 只有带手机进考场的人会用到。
   三个"软件"各自一块容器：战况常驻，群聊/计算器按 tab 显隐，不重建节点。 */
const phoneUI = $('phoneUI'), phClock = $('phClock'), phLeft = $('phLeft'),
      phRows = $('phRows'), phRank = $('phRank'), phTotal = $('phTotal'),
      phTabs = $('phTabs'), phStatus = $('phStatus'), phChat = $('phChat'),
      phChatLog = $('phChatLog'), phCalc = $('phCalc'), phCalcOut = $('phCalcOut'),
      phCalcExpr = $('phCalcExpr'), phCalcPad = $('phCalcPad'),
      phGame = $('phGame'), phGameBoard = $('phGameBoard'),
      phGameScore = $('phGameScore'), phGameBest = $('phGameBest'),
      phGameTip = $('phGameTip');
const corridorUI = $('corridorUI'), corrBar = $('corrBar');
const bathroomUI = $('bathroomUI'), bathBar = $('bathBar'),
      bathStepText = $('bathStepText'), bathHint = $('bathHint'),
      bathSub = $('bathSub'), bathDots = $('bathDots');
const endingUI = $('ending'), toastStack = $('toastStack');
const pauseMenu = $('pauseMenu'), npcComputerUI = $('npcComputerUI');
const redFlash = $('redFlash'), minimapWrap = $('minimapWrap');
const minimap = $('minimap'), mmCtx = minimap.getContext('2d');
const achNotify = $('achNotify'), startScreen = $('start');

/* ---------------------------- 视角手感设置 ---------------------------- */
const SENS_MIN = 0.35, SENS_MAX = 3.5;   /* 滑条 1~20 → 灵敏度档位 */
const SENS_SCALE = 0.0011;               /* 档位 → 弧度/像素 */
let mouseSens = 1.925, smoothAmount = 0.35, timeScale = 15;
let shakeEnabled = true;
/* 战斗光影：开 = 紧张值驱动灯光压暗 / 红光雾 / 调色 / 暗角 / 拖影；
   关 = 战斗时画面保持平时的亮度与色调（心跳/镜头抖动不受影响）。 */
let combatLightFx = true;
/* 保安刷新位置：random = 围着玩家随机撒点（默认）；door = 固定从考场门口涌进来；
   elevator = 从电梯间（教学楼入口）一路跑进来。
   保安速度：guardSpeedScale 是相对玩家疾跑速度的比例，默认 0.9（略慢于疾跑）。
   这两个都是玩法选项，不是难度选项 —— 存进视角设置的同一份存档，读档后仍然生效。 */
let guardSpawnMode = 'random';
let guardSpeedScale = 0.9;
let yawTarget = 0, pitchTarget = 0;

function sliderToSens(v){ return SENS_MIN + ((v - 1) / 19) * (SENS_MAX - SENS_MIN); }
function sensToSlider(s){
  return Math.round(clamp((s - SENS_MIN) / (SENS_MAX - SENS_MIN), 0, 1) * 19) + 1;
}

const SETTINGS_KEY = 'oi_room_view_v1';
function loadViewSettings(){
  try {
    const o = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    if (typeof o.sens === 'number')   mouseSens = clamp(o.sens, SENS_MIN, SENS_MAX);
    if (typeof o.smooth === 'number') smoothAmount = clamp(o.smooth, 0, 0.9);
    if (typeof o.time === 'number')   timeScale = clamp(o.time, 1, 60);
    if (typeof o.shake === 'boolean') shakeEnabled = o.shake;
    if (typeof o.combatFx === 'boolean') combatLightFx = o.combatFx;
    if (typeof o.guardSpawn === 'string' && ['random','door','elevator'].includes(o.guardSpawn))
      guardSpawnMode = o.guardSpawn;
    else if (o.guardDoor === true) guardSpawnMode = 'door';   /* 迁移旧布尔 */
    if (typeof o.guardSpeed === 'number') guardSpeedScale = clamp(o.guardSpeed, 0.3, 1.6);
    if (typeof o.vol === 'number')    audio.volume = clamp(o.vol, 0, 1);
    if (typeof o.muted === 'boolean') audio.muted = o.muted;
  } catch(e){}
}
function saveViewSettings(){
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      sens: mouseSens, smooth: smoothAmount, time: timeScale,
      vol: audio.volume, muted: audio.muted, shake: shakeEnabled,
      combatFx: combatLightFx,
      guardSpawn: guardSpawnMode, guardSpeed: guardSpeedScale
    }));
  } catch(e){}
}
/* 拖滑条时防抖写盘 */
let saveSettingsTimer = null;
function scheduleSaveViewSettings(){
  if (saveSettingsTimer) return;
  saveSettingsTimer = setTimeout(() => { saveSettingsTimer = null; saveViewSettings(); }, 400);
}

function syncViewUI(){
  const tv = sensToSlider(mouseSens), smv = Math.round(smoothAmount * 100);
  const volv = Math.round(audio.volume * 100);
  ['turnSliderStart', 'turnSlider'].forEach(id => { const e = $(id); if (e) e.value = tv; });
  ['turnValueStart', 'turnValue'].forEach(id => { const e = $(id); if (e) e.textContent = mouseSens.toFixed(1); });
  ['smoothSliderStart', 'smoothSlider'].forEach(id => { const e = $(id); if (e) e.value = smv; });
  ['smoothValueStart', 'smoothValue'].forEach(id => { const e = $(id); if (e) e.textContent = smv + '%'; });
  ['timeSliderStart', 'timeSlider'].forEach(id => { const e = $(id); if (e) e.value = Math.round(timeScale); });
  ['timeValueStart', 'timeValue'].forEach(id => { const e = $(id); if (e) e.textContent = Math.round(timeScale) + 'x'; });
  ['volSliderStart', 'volSlider'].forEach(id => { const e = $(id); if (e) e.value = volv; });
  ['volValueStart', 'volValue'].forEach(id => { const e = $(id); if (e) e.textContent = volv + '%'; });
  const mt = $('muteToggle');
  if (mt) mt.classList.toggle('on', !audio.muted);
  ['shakeToggle', 'shakeToggleStart'].forEach(id => {
    const e = $(id); if (e) e.classList.toggle('on', shakeEnabled);
  });
  ['combatFxToggle', 'combatFxToggleStart'].forEach(id => {
    const e = $(id); if (e) e.classList.toggle('on', combatLightFx);
  });
  ['guardSpawnSel', 'guardSpawnSelStart'].forEach(id => {
    const e = $(id); if (e) e.value = guardSpawnMode;
  });
  const gs = Math.round(guardSpeedScale * 100);
  ['guardSpeedSlider', 'guardSpeedSliderStart'].forEach(id => {
    const e = $(id); if (e) e.value = gs;
  });
  ['guardSpeedValue', 'guardSpeedValueStart'].forEach(id => {
    const e = $(id); if (e) e.textContent = gs + '%';
  });
}
