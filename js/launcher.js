'use strict';
/* =========================================================================
   launcher —— 桌面 · CSP-S114514 文件夹 · 能玩的小恐龙
   ---------------------------------------------------------------------
   开场那段"别人已经在答题了，你还在玩"的荒诞感，就靠这一块立在教室外面。
   三样东西：

     1) 桌面窗口（DOM）：一个文件夹、四个题目文件、一个 dino.exe
     2) CSP-S114514 文件夹：里面是本次考试的四个题目文件（真文件，点了能开）
     3) 小恐龙：Chromium 断网小恐龙的复刻，用 canvas 手绘，无任何外部资源

   关于小恐龙：
     · 重力 / 跳跃初速 / 冲刺速度都按"手感"调过，不是随便填的数字。
       关键约束是：以初始速度跑，第一次跳跃必须能刚好跨过一个仙人掌，
       而且不能松得可以闭着眼跳 —— 所以要算一遍能跳多远。
     · 三种障碍：小仙人掌、成组仙人掌、飞鸟（低飞要跳、高飞要蹲）。
     · 只有按了跳跃才算"开始"，否则是待机画面 —— 和原版一致。
     · 防作弊：不接受程序化输入（合成 KeyboardEvent 打不进来），
       分数只由本帧的物理状态决定，没有可注入的分数变量。
   ========================================================================= */

/* ---------------------------- DOM ---------------------------- */
const desktopUI = $('desktopUI');
const desktopList = $('desktopList');
const dinoPane = $('dinoPane');
const dinoCanvas = $('dinoCanvas');
const dinoScoreEl = $('dinoScore');
const dinoHighEl = $('dinoHigh');
const dinoHintEl = $('dinoHint');
const dtCtx = dinoCanvas.getContext('2d');

/* ---------------------------- 窗口开合 ---------------------------- */
let launcherOpenedFrom = 'world';

function openDesktop(){
  if (state.ended || state.frozen) return;
  launcherOpenedFrom = state.view;
  state.view = 'launcher';
  crosshair.classList.add('hidden');
  promptEl.classList.add('hidden');
  releaseLock();
  desktopUI.classList.remove('hidden');
  desktopUI.classList.remove('closed');
  desktopList.classList.remove('hidden');
  dinoPane.classList.add('hidden');
  dinoStop();
  renderDesktopList();
}

function closeDesktop(){
  dinoStop();
  desktopUI.classList.add('hidden');
  dinoPane.classList.add('hidden');
  state.view = launcherOpenedFrom === 'code' ? 'code' : 'world';
  if (state.view === 'world'){
    crosshair.classList.remove('hidden');
    requestLock();
  }
}

/* ---------------------------- 文件夹内容 ----------------------------
   文件列表由当前这一局的题目动态生成 —— 所以你在桌面上看到的文件名，
   就是你在 IDE 里要交的那四个文件。不是写死的装饰。 */
function desktopEntries(){
  const list = state.problems.map(p => ({
    kind: 'problem', id: p.id,
    name: p.id + '.cpp',
    sub: p.name,
    score: state.score[p.id] || 0,
    max: p.max
  }));
  list.push({ kind: 'dino', name: 'dino.exe', sub: '休闲 · 可执行' });
  return list;
}

function renderDesktopList(){
  desktopList.innerHTML = '';

  const info = document.createElement('div');
  info.className = 'dl-info';
  info.innerHTML = '<b>CSP-S114514</b>　共 ' + desktopEntries().length +
                   ' 个项目　·　双击打开';
  desktopList.appendChild(info);

  for (const e of desktopEntries()){
    const row = document.createElement('div');
    row.className = 'dl-item' + (e.kind === 'dino' ? ' dino' : '');
    if (e.kind === 'problem'){
      let cls = '未做';
      if (e.score >= e.max) cls = 'AC';
      else if (e.score > 0) cls = '部分分';
      row.innerHTML =
        '<span class="ico">&#128221;</span>' +
        '<span class="nm">' + e.name + '</span>' +
        '<span class="sub">' + e.sub + '</span>' +
        '<span class="tag ' + (cls === 'AC' ? 'ok' : (cls === '未做' ? '' : 'part')) + '">' + cls + '</span>';
    } else {
      row.innerHTML =
        '<span class="ico">&#129430;</span>' +
        '<span class="nm">' + e.name + '</span>' +
        '<span class="sub">' + e.sub + '</span>' +
        '<span class="tag play">▶ 玩</span>';
    }
    row.ondblclick = () => openDesktopEntry(e);
    row.onclick = () => { row.classList.add('sel'); };
    desktopList.appendChild(row);
  }

  const note = document.createElement('div');
  note.className = 'dl-note';
  note.textContent = '提示：别再玩 dino.exe 了，别人都在答题。';
  desktopList.appendChild(note);
}

function openDesktopEntry(e){
  if (e.kind === 'dino'){ dinoOpen(); return; }
  /* 题目文件：先把它设为当前题，再打开 IDE —— 从桌面直接进题 */
  const p = state.problems.find(x => x.id === e.id);
  if (!p) return;
  state.curProb = p.id;
  desktopUI.classList.add('hidden');
  openCode();
  toast('已打开 ' + e.name, 1400);
}

/* ============================ 小恐龙 ============================ */

/* ---- 物理常量 ----
   竖直方向（这条以前是错的，而且是致命的）：
     跳跃顶点 = JUMP_V² / (2 * G)。要清过障碍，判定盒底面必须高过障碍顶面，
     也就是 dinoY 必须 ≥ 障碍高度（判定盒高 24*PX=48，底面 y = GROUND - dinoY）。
     最矮的仙人掌 h=58，最高的 h=74 —— 所以顶点至少要到 74 以上。
     旧值 JUMP_V=440 的顶点只有 50px，**两个仙人掌一个都跳不过去**，
     无论什么时机起跳都是必死。原来的注释只算了水平位移
     （"最宽 57px，留了约 100px 余量"），从头到尾没算过竖直余量。
     JUMP_V=700 → 顶点约 130px，过最高的仙人掌还剩 56px 余量。

   水平方向：
     滞空时间 = 2 * JUMP_V / G ≈ 0.78s；位移 = 速度 × 滞空时间。
     速度越快位移越长，所以障碍间距必须跟着速度走（见 dinoStep 里的 minGap），
     否则会出现"还没落地，下一个已经贴到脸上"的必死局面。 */
const DINO = {
  W: 900, H: 300,              /* 画布内部分辨率 */
  GROUND: 246,                 /* 地面线的 y */
  G: 1800,                     /* 重力 px/s² */
  JUMP_V: 700,                 /* 起跳初速 px/s（顶点约 130px） */
  SPEED0: 320,                 /* 初始速度 px/s */
  SPEED_MAX: 620,              /* 速度上限 */
  ACCEL: 9,                    /* 每秒加速度 */
  PX: 2                        /* 像素放大倍数（900x300 画到 900x300，靠 CSS 放大） */
};

const DINO_FILE = 'dino.exe';

/* 障碍目录：生成器与冒烟测试共用同一份数字。
   以前宽度/高度直接写死在 push 里，测试只好自己再抄一份"最宽 57 / 最高 74"，
   抄错了没人知道 —— 而"竖直余量从来没被检查过"正是这么漏掉的。 */
const DINO_OBS = [
  { id: 'cactusBig',   kind: 'cactus', w: 57, h: 74, extraGap: 160, minScore: 0   },
  { id: 'cactusSmall', kind: 'cactus', w: 19, h: 58, extraGap: 150, minScore: 0   },
  { id: 'bird',        kind: 'bird',   w: 66, h: 30, extraGap: 170, minScore: 260 }
];
/* 翼龙的三种飞行高度（相对地面线的偏移）。抽出来是因为生成器和测试都要读它 ——
   而且这里有个约束：最低那种必须让"扇翅在下的那一帧"也留在地面线以上，
   否则翅膀会画穿地面（GROUND-22 时会穿出 11px）。 */
const DINO_BIRD_HEIGHTS = [-96, -62, -36];

/* 蹲下时身体纵向压扁到的比例。
   抽成常量是因为有三处必须用**同一个**值：身体绘制、腿的纵向基准、
   dinoRender 里的 bodyY。以前 0.58 散在三处、腿那处干脆写的是绝对像素，
   于是蹲下时腿落到身体底下 16px 的地方（悬空 + 戳穿地面线 13px）。 */
const DINO_SQUASH = 0.58;

/* 小恐龙（站姿）。x,y 左上角，s 为放大倍数，1 像素 = s 单位。
   24 行 × 32 列，s=2 时是 64×48 的精灵。

   这张图是照着 Chrome 那只量的（官方 offline 雪碧图 44×47，TREX 在 (848,2)）：
     · 头占全宽 45%（列 22..41 / 44）→ 这里占 50%（列 16..31 / 32）
     · 眼睛 2×2 挖洞，位于头的左后方 20%..30%、高度 1/3 处
     · 嘴是**开在前缘的缺口**（上颚到 41、下颚只到 37），不是头中间一个洞
     · 尾巴只有 6 列宽（44 的 14%）→ 这里 5 列，而且是从背上斜下来的一小截
     · 腿在身体正下方偏中，肚皮必须盖住腿的落点（列 13..20）
   以前那版是用"一个四边形收窄"凑出来的，身体收成 4px 的楔子，腿挂在上面。 */
const DINO_BODY = [
  '..................XXXXXXXXXXXXX.',
  '................XXXXXXXXXXXXXXXX',
  '................XXX..XXXXXXXXXXX',
  '................XXX..XXXXXXXXXXX',
  '................XXXXXXXXXXXXXXXX',
  '................XXXXXXXXXXXXXXXX',
  '................XXXXXXXXXXXXXXXX',
  '................XXXXXXXXXXXXXXXX',
  '................XXXXXXXXX.......',
  '................XXXXXXXXXXXXX...',
  'XX.............XXXXXXXX.........',
  'XXX...........XXXXXXXXX.........',
  'XXXXX......XXXXXXXXXXXXXX.......',
  'XXXXXX...XXXXXXXXXXXXXXXXX......',
  'XXXXXXXXXXXXXXXXXXXXXXX.........',
  'XXXXXXXXXXXXXXXXXXXXXXX.........',
  'XXXXXXXXXXXXXXXXXXXXXXX.........',
  '.XXXXXXXXXXXXXXXXXXXXXX.........',
  '..XXXXXXXXXXXXXXXXXXXXX.........',
  '....XXXXXXXXXXXXXXXXXX..........',
  '......XXXXXXXXXXXXXXXX..........',
  '.......XXXXXXXXXXXXXX...........',
  '.......XXXXXXXXXXXXXX...........',
  '.......XXXXXXXXXXXXXX...........'
];

/* 蹲下：把站姿纵向压扁到约 60%，并把尾巴拉长 —— 用同一份位图变换，
   不另画一张，省 24 行数据且永远不会两张图对不上。 */
function dinoDrawShape(ctx, x, y, s, ducking){
  const sq = ducking ? DINO_SQUASH : 1;
  /* 每一行的上下边界单独取整，而不是"行高 + 0.6 补缝"。
     补缝的写法（hRow + 0.6）在整数行高下会**渗到下一行**，把 1 行高的
     眼白和嘴缝糊死 —— 之前只能另画一个 3x3 白方块顶替眼睛，就是因为它。
     取整之后：任何行高都不会留缝，也不会越界。 */
  const hRow = s * sq;
  ctx.fillStyle = '#535353';
  for (let r = 0; r < DINO_BODY.length; r++){
    const row = DINO_BODY[r];
    const yTop = Math.round(y + r * hRow);
    const yBot = Math.round(y + (r + 1) * hRow);
    let c = 0;
    while (c < row.length){
      if (row[c] === 'X'){
        let run = 1;
        while (c + run < row.length && row[c + run] === 'X') run++;
        ctx.fillRect(x + c * s, yTop, run * s, yBot - yTop);
        c += run;
      } else c++;
    }
  }
}

/* 腿部：两帧交替。原版小恐龙的精髓全在这两条腿上 ——
   身体不动、腿一前一后，读起来就是"在跑"。 */
function dinoDrawLegs(ctx, x, y, s, ducking, frame){
  ctx.fillStyle = '#535353';
  /* 纵向基准 = **压扁后**身体的底部：y + 行数 * s * sq。
     老代码这里写的 22*s / 24*s 是绝对像素，完全没跟着挤压系数走 ——
     站姿下 24*s 恰好等于身体高度所以看不出来，
     蹲姿下身体只剩 24*s*0.58，腿却还按 22*s 落位，于是悬在身体下方 16px，
     并且戳到地面线以下 13px。共用 sq 之后两者再也不会走散。 */
  const sq = ducking ? DINO_SQUASH : 1;
  const base = y + DINO_BODY.length * s * sq;
  if (ducking){
    /* 蹲着：两条短腿一起往后蹬，长的那条踩到地面线 */
    const off = frame ? 0 : 3;
    ctx.fillRect(x + 9 * s, base, 5 * s, 6 * s);
    ctx.fillRect(x + 14 * s, base + off * 0.4, 6 * s, 4 * s);
    return;
  }
  if (frame === 0){
    ctx.fillRect(x + 9 * s, base, 4 * s, 6 * s);
    ctx.fillRect(x + 13 * s, base, 4 * s, 3 * s);
  } else {
    ctx.fillRect(x + 9 * s, base, 4 * s, 3 * s);
    ctx.fillRect(x + 13 * s, base, 4 * s, 6 * s);
  }
}

/* 仙人掌几何：**只算一次**，绘制和碰撞判定都读它。
   老代码两边各算各的 —— 绘制按 o.w 居中、但实际只画出约 25px 宽，
   判定却用 o.w-8：于是 w=57 的"成组仙人掌"凭空多出 12~13px 宽的无形杀伤区，
   恐龙在离它还有 12px 的地方就死了（注释里说要避免的正是"擦过去了却判死"）。
   顺带：o.w 以前对画面几乎没影响（只改主干粗细 10/8、侧枝 2/1），
   所谓"成组"看起来和"单株"几乎一样宽 —— 一并修掉，让 w 真的有视觉含义。 */
function dinoCactusGeom(o){
  const parts = [];
  const G = DINO.GROUND;
  /* 所有坐标、尺寸一律取整。canvas 上一个 404.5 这样的坐标会被抗锯齿
     摊成两列各 50% 灰 —— 像素画最忌这个，看起来就是"边缘发虚"。
     （老代码里顶部的 o.h*0.32、侧枝的 o.h*0.46 全是分数，同样发虚。） */
  if (o.w >= 40){
    /* 成组：三根主干并排铺满 o.w（间距 7px，恐龙判定盒 44px 宽，
       不可能从缝里钻过去，所以判定盒跨整丛是诚实的）。 */
    const tw = 14, n = 3;
    const pitch = Math.floor((Math.round(o.w) - tw * n) / (n - 1));
    const ratio = [1, 0.84, 0.94];
    for (let i = 0; i < n; i++){
      const h = Math.round(o.h * ratio[i]);
      parts.push({ x: Math.round(o.x) + i * (tw + pitch), y: G - h, w: tw, h: h });
    }
  } else {
    const tw = 10;
    const h = Math.round(o.h);
    parts.push({ x: Math.round(o.x + (o.w - tw) / 2), y: G - h, w: tw, h: h });
  }
  let left = Infinity, right = -Infinity, top = Infinity;
  for (const p of parts){
    if (p.x < left) left = p.x;
    if (p.x + p.w > right) right = p.x + p.w;
    if (p.y < top) top = p.y;
  }
  return { parts: parts, left: left, right: right, top: top, bottom: G };
}

/* 翼龙判定盒：只算身体，**不算翅膀** —— 翅膀在不停地扇，
   用整个轮廓判定会变成"一会儿能过、一会儿不能过"，没法玩。
   顶边取 o.y+4 是为了正好压住画出来的头顶（o.y+3 会多出 1px 隐形杀伤区）。 */
function dinoBirdGeom(o){
  return { left: o.x + 4, right: o.x + o.w - 4,
           top: o.y + 4, bottom: o.y + 4 + (o.h - 6) };
}

/* 仙人掌：按上面那份几何画。顶部圆头画在主干**内部**，
   这样"看得见的顶"和"判定盒的顶"是同一个 y（以前圆头戳出判定盒 2px）。
   以前那个"圆头"是 `fillRect(p.x+2, p.y, p.w-4, 3)` —— 同色矩形叠在同色主干上，
   等于什么都没画，所以整株就是一根方柱子。现在改成四角切 1px 的真圆头。 */
function dinoDrawCactus(ctx, o){
  const g = dinoCactusGeom(o);
  ctx.fillStyle = '#535353';
  for (const p of g.parts){
    ctx.fillRect(p.x + 1, p.y, p.w - 2, 1);          /* 顶：两侧各让 1px */
    ctx.fillRect(p.x, p.y + 1, p.w, p.h - 1);        /* 主干预留的圆角 */
  }
  /* 手臂只在单株上画（成组那丛本来就够宽，再加手臂就成了一坨）。
     落位在主干外侧 5px 以内 —— 判死只认主干，所以这是"宽容"方向。 */
  if (o.w < 40){
    const p = g.parts[0];
    const ay = p.y + Math.round(p.h * 0.46);
    const up = Math.round(p.h * 0.24);
    /* 左臂：肩 → 竖段 → 圆头，三段连着画，不再悬空 */
    ctx.fillRect(p.x - 5, ay, 5, 2);
    ctx.fillRect(p.x - 5, ay - up, 4, up + 2);
    ctx.fillRect(p.x - 4, ay - up - 1, 2, 1);
    /* 右臂：比左臂再高一点，别左右对称得像叉子 */
    const ry = ay + Math.round(p.h * 0.14);
    ctx.fillRect(p.x + p.w, ry, 5, 2);
    ctx.fillRect(p.x + p.w + 1, ry - up, 4, up + 2);
    ctx.fillRect(p.x + p.w + 2, ry - up - 1, 2, 1);
  }
}

/* 翼龙：两帧翅膀（上 / 下）。飞得低要跳过去，飞得高要蹲下去 */
function dinoDrawBird(ctx, o, frame){
  ctx.fillStyle = '#535353';
  const bx = o.x, by = o.y, s = 2;
  /* 身体 */
  ctx.fillRect(bx + 8 * s, by + 4 * s, 18 * s, 5 * s);
  /* 头与喙 */
  ctx.fillRect(bx + 24 * s, by + 2 * s, 8 * s, 5 * s);
  ctx.fillRect(bx + 31 * s, by + 4 * s, 6 * s, 2 * s);
  /* 翅：帧 0 向上，帧 1 向下 */
  if (frame === 0){
    ctx.fillRect(bx + 10 * s, by - 3 * s, 14 * s, 7 * s);
    ctx.fillRect(bx + 13 * s, by - 6 * s, 8 * s, 3 * s);
  } else {
    ctx.fillRect(bx + 10 * s, by + 9 * s, 14 * s, 6 * s);
    ctx.fillRect(bx + 13 * s, by + 14 * s, 8 * s, 3 * s);
  }
  /* 尾 */
  ctx.fillRect(bx, by + 5 * s, 8 * s, 3 * s);
}

/* ---------------------------- 游戏状态 ---------------------------- */
let dinoRunning = false, dinoOver = false, dinoRaf = 0;
let dinoScore = 0, dinoHigh = 0, dinoSpeed = DINO.SPEED0;
let dinoDuckKey = false, dinoDuck = false;
let dinoY = 0, dinoVY = 0, dinoOnGround = true;
let dinoObs = [], dinoSpawnAt = 0, dinoDist = 0, dinoLegFrame = 0, dinoLegT = 0;
let dinoBirdFrame = 0, dinoBirdT = 0, dinoClouds = [], dinoGroundX = 0;

function dinoReset(){
  dinoScore = 0; dinoSpeed = DINO.SPEED0;
  dinoY = 0; dinoVY = 0; dinoOnGround = true;
  dinoObs = []; dinoDist = 0; dinoSpawnAt = 90;
  dinoDuck = false; dinoDuckKey = false;
  dinoLegFrame = 0; dinoLegT = 0; dinoBirdFrame = 0; dinoBirdT = 0;
  dinoGroundX = 0;
  dinoOver = false;
  dinoClouds = [];
  for (let i = 0; i < 4; i++){
    dinoClouds.push({ x: Math.random() * DINO.W, y: 30 + Math.random() * 90, s: 0.6 + Math.random() * 0.7 });
  }
}

/* 像素画必须**整数倍**缩放。
   画布内部分辨率是 900×300，以前 CSS 用 width:100% 让它随容器拉伸 ——
   容器给了 910px，于是缩放变成 910/900 = 1.0111。
   非整数缩放配上 image-rendering:pixelated，意味着一个源码像素会映射到
   1.0111 个设备像素：同一张图里有的列摊到 2 个设备像素、有的只摊到 1 个，
   结果是大片纯色出现摩尔纹、所有竖边的粗细不匀（仙人掌主干、恐龙腿最明显）。
   这里取"容器放得下的最大整数倍"，保证永远是 1× / 2× / 3×。 */
function dinoFitCanvas(){
  const box = dinoCanvas.parentElement;
  if (!box) return;
  const avail = box.clientWidth;
  if (!avail) return;
  const k = Math.max(1, Math.floor(avail / DINO.W));
  dinoCanvas.style.width = (DINO.W * k) + 'px';
  dinoCanvas.style.height = (DINO.H * k) + 'px';
}

function dinoOpen(){
  desktopList.classList.add('hidden');
  dinoPane.classList.remove('hidden');
  dinoFitCanvas();
  dinoReset();
  dinoRunning = false;
  dinoHintEl.textContent = '按 空格 / ↑ / W 开始';
  dinoHigh = state.dinoHigh || 0;
  dinoHighEl.textContent = '最高 ' + String(dinoHigh).padStart(5, '0');
  dinoScoreEl.textContent = '00000';
  dinoRender(performance.now() * 0.001);
  try { dinoCanvas.focus(); } catch(e){}
}

function dinoStop(){
  if (dinoRaf){ cancelAnimationFrame(dinoRaf); dinoRaf = 0; }
  dinoRunning = false;
}

function dinoStart(){
  dinoReset();
  dinoRunning = true;
  dinoOver = false;
  dinoHintEl.textContent = '空格 / ↑ 跳跃　↓ / S 蹲下';
  dinoLast = performance.now();
  if (!dinoRaf) dinoRaf = requestAnimationFrame(dinoLoop);
}

/* ---------------------------- 主循环 ---------------------------- */
let dinoLast = 0;
function dinoLoop(now){
  dinoRaf = requestAnimationFrame(dinoLoop);
  /* 切到别的窗口时暂停：不然回来一看恐龙已经撞死了 */
  if (state.view !== 'launcher' || dinoPane.classList.contains('hidden')){
    dinoLast = now;
    return;
  }
  const dt = Math.min((now - dinoLast) / 1000, 0.05);   /* 卡顿时钳制，防穿模 */
  dinoLast = now;
  if (dinoRunning && !dinoOver) dinoStep(dt);
  dinoRender(now / 1000);
}

function dinoStep(dt){
  dinoSpeed = Math.min(DINO.SPEED_MAX, dinoSpeed + DINO.ACCEL * dt);
  dinoDist += dinoSpeed * dt;
  dinoScore = Math.floor(dinoDist / 22);

  /* 跳跃物理 */
  if (!dinoOnGround || dinoVY > 0){
    dinoVY -= DINO.G * dt;
    dinoY += dinoVY * dt;
    if (dinoY <= 0){ dinoY = 0; dinoVY = 0; dinoOnGround = true; }
  }

  /* 腿部动画：速度越快频率越高 */
  dinoLegT += dt * (dinoSpeed / 90);
  if (dinoLegT >= 1){ dinoLegT = 0; dinoLegFrame ^= 1; }
  /* 翼龙扇翅：固定频率，比腿部慢 */
  dinoBirdT += dt * 6;
  if (dinoBirdT >= 1){ dinoBirdT = 0; dinoBirdFrame ^= 1; }

  /* 障碍生成 ------------------------------------------------------------
     间距必须随速度拉长。注释里早就写了这个意图（"保证反应时间不随时间下降"），
     但代码用的是**固定距离** —— 速度越快反应时间越短，正好写反了。
     更硬的下限：间距必须大于一次跳跃的水平跨度，否则第二个障碍会在你还在空中时
     贴上来，而跳跃要求 dinoOnGround，玩家一点操作空间都没有，必死。
     这不是手感问题，是可玩性的硬约束。 */
  const airTime = 2 * DINO.JUMP_V / DINO.G;
  const minGap = dinoSpeed * airTime + 150;
  dinoDist < 0 || (dinoSpawnAt -= dinoSpeed * dt);
  if (dinoSpawnAt <= 0){
    const r = Math.random();
    let spec;
    if (r < 0.28 && dinoScore > 260) spec = DINO_OBS[2];        /* 翼龙 */
    else if (r < 0.62)               spec = DINO_OBS[0];        /* 成组仙人掌 */
    else                             spec = DINO_OBS[1];        /* 单株仙人掌 */

    const obs = { kind: spec.kind, x: DINO.W + 40, w: spec.w, h: spec.h };
    if (spec.kind === 'bird'){
      const i = Math.floor(Math.random() * DINO_BIRD_HEIGHTS.length);
      obs.y = DINO.GROUND + DINO_BIRD_HEIGHTS[i];
    }
    dinoObs.push(obs);
    dinoSpawnAt = minGap + Math.random() * spec.extraGap;
  }

  /* 推进 + 回收 */
  for (let i = dinoObs.length - 1; i >= 0; i--){
    const o = dinoObs[i];
    o.x -= dinoSpeed * dt;
    if (o.x + o.w < -20) dinoObs.splice(i, 1);
  }

  dinoGroundX = (dinoGroundX - dinoSpeed * dt) % 40;

  /* 云：慢速左移，纯装饰，但要能循环 */
  for (const c of dinoClouds){
    c.x -= dinoSpeed * 0.10 * dt;
    if (c.x < -90){ c.x = DINO.W + 60; c.y = 30 + Math.random() * 90; }
  }

  /* 碰撞：判定盒必须和"画出来的东西"对得上。
     仙人掌直接用 dinoCactusGeom() 的横向范围 —— 那一份几何同时喂给绘制，
     所以"看到的"和"会撞到的"不可能再走散。 */
  const s = DINO.PX;
  const dw = dinoDuck ? 34 * s : 22 * s;
  const dh = dinoDuck ? 16 * s : 24 * s;
  const dx = 26 * s, dy = DINO.GROUND - dh - dinoY;
  for (const o of dinoObs){
    let ox, ow, oy, oh;
    if (o.kind === 'bird'){
      const g = dinoBirdGeom(o);
      ox = g.left; ow = g.right - g.left; oy = g.top; oh = g.bottom - g.top;
    } else {
      const g = dinoCactusGeom(o);
      ox = g.left; ow = g.right - g.left;
      oy = g.top;  oh = g.bottom - g.top;
    }
    if (dx < ox + ow && dx + dw > ox && dy < oy + oh && dy + dh > oy){
      dinoDie();
      return;
    }
  }

  dinoScoreEl.textContent = String(dinoScore).padStart(5, '0');
}

function dinoDie(){
  dinoOver = true;
  dinoRunning = false;
  audio.beep(180, 0.18, 0.05, 'square');
  if (dinoScore > dinoHigh){
    dinoHigh = dinoScore;
    state.dinoHigh = dinoHigh;
    dinoHighEl.textContent = '最高 ' + String(dinoHigh).padStart(5, '0');
    unlockAch('dino');
  }
  dinoHintEl.textContent = '撞了。按 空格 再来一局';
}

function dinoJump(){
  if (dinoOver){ dinoStart(); return; }
  if (!dinoRunning){ dinoStart(); return; }
  if (dinoOnGround){
    dinoVY = DINO.JUMP_V;
    dinoOnGround = false;
    audio.beep(700, 0.05, 0.03, 'triangle');
  }
}

/* ---------------------------- 渲染 ---------------------------- */
function dinoRender(t){
  const ctx = dtCtx;
  ctx.save();
  ctx.fillStyle = '#f7f7f7';
  ctx.fillRect(0, 0, DINO.W, DINO.H);

  /* 云 */
  ctx.fillStyle = '#dcdcdc';
  for (const c of dinoClouds){
    const s = c.s;
    ctx.fillRect(c.x, c.y, 34 * s, 6 * s);
    ctx.fillRect(c.x + 7 * s, c.y - 5 * s, 20 * s, 5 * s);
    ctx.fillRect(c.x + 4 * s, c.y + 6 * s, 26 * s, 5 * s);
  }

  /* 地面线 + 滚动的碎石（t 用来让碎石有细微起伏，不然像静止的贴图） */
  ctx.fillStyle = '#535353';
  ctx.fillRect(0, DINO.GROUND, DINO.W, 2);
  ctx.fillStyle = '#9a9a9a';
  for (let i = 0; i < 24; i++){
    const gx = ((i * 40 + dinoGroundX) % (DINO.W + 40)) + (i % 3) * 7;
    const gh = 2 + (i % 3);
    ctx.fillRect(gx, DINO.GROUND + 5 + (i % 4) * 3, 5, gh);
  }

  /* 障碍 */
  for (const o of dinoObs){
    if (o.kind === 'bird') dinoDrawBird(ctx, o, dinoBirdFrame);
    else dinoDrawCactus(ctx, o);
  }

  /* 恐龙 */
  const s = DINO.PX;
  const bodyY = DINO.GROUND - DINO_BODY.length * s * (dinoDuck ? DINO_SQUASH : 1) - dinoY - 6 * s;
  const bodyX = 26 * s;
  dinoDrawShape(ctx, bodyX, bodyY, s, dinoDuck);
  dinoDrawLegs(ctx, bodyX + 4 * s, bodyY, s, dinoDuck, dinoLegFrame);

  /* 待机 / 结束提示 */
  if (!dinoRunning && !dinoOver){
    ctx.fillStyle = 'rgba(83,83,83,0.85)';
    ctx.font = 'bold 22px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('按 空格 开始', DINO.W / 2, 96);
    ctx.textAlign = 'left';
  }
  if (dinoOver){
    ctx.fillStyle = 'rgba(83,83,83,0.9)';
    ctx.font = 'bold 30px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('G A M E   O V E R', DINO.W / 2, 108);
    ctx.font = '17px "Microsoft YaHei", sans-serif';
    ctx.fillText('空格 / ↑ 再来一局', DINO.W / 2, 140);
    ctx.textAlign = 'left';
  }
  ctx.restore();
}

/* ---------------------------- 输入 ----------------------------
   这里刻意不用 KEYMAP：小恐龙的键位和考场里不一样（↓ 蹲下在考场里没意义），
   而且它必须吃掉按键，不让箭头键滚页面。
   另外只认 e.isTrusted 的事件 —— 合成事件打不进来，分数没法从外部注入。 */
function dinoKey(e, down){
  if (state.view !== 'launcher' || dinoPane.classList.contains('hidden')) return false;
  if (!e.isTrusted) return false;
  const k = e.code;
  const jump = (k === 'Space' || k === 'ArrowUp' || k === 'KeyW');
  const duck = (k === 'ArrowDown' || k === 'KeyS');

  if (jump){
    if (down) dinoJump();
    e.preventDefault();
    return true;
  }
  if (duck){
    dinoDuckKey = down;
    /* 空中按蹲 = 快速落地，这是原版就有的手感补偿 */
    if (down && !dinoOnGround){ dinoVY = Math.min(dinoVY, -260); }
    dinoDuck = down && dinoOnGround;
    e.preventDefault();
    return true;
  }
  if (k === 'Escape' && down){
    closeDesktop();
    e.preventDefault();
    return true;
  }
  return false;
}
