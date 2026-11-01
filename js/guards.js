'use strict';
/* =========================================================================
   guards —— 保安队伍：AI / 警灯 / 通报 / 结局判定
   ---------------------------------------------------------------------
   保安是"打老师的报应"。整局最多派出 GUARD_MAX_TOTAL 名（200），
   每打一个补两个，难度随击杀数缓慢上浮（有上限，不至于变成不可玩）。
   打满 200 名触发隐藏结局。

   警灯刻意只做 2 盏真实点光源并常驻场景 —— 点光源数量直接进光照 shader，
   按保安数无限添加会把帧率拖死；常驻则避免 shader 反复重编译。
   ========================================================================= */

const GUARD_SPEED_MAX_BONUS = 0.35;
const GUARD_SPAWN_DIST = 5.0;
const GUARD_LIGHTS = 2;
/* GUARD_HIT_RADIUS / GUARD_PUNCH_RANGE / GUARD_MAX_TOTAL 在 core.js ——
   被 combat.js 与 interact.js 共用。放在这里会让那些先加载的文件
   在"函数体内引用、却在加载期就被调用"的情形下踩上暂时性死区。 */

const guardLights = [];

/* ---------------------------- 队伍管理 ---------------------------- */
function aliveGuardCount(){
  let n = 0;
  for (const g of securityGuards) if (g.userData.alive) n++;
  return n;
}

function guardPoolRemaining(){
  return Math.max(0, GUARD_MAX_TOTAL - (state.guardsSpawned || 0));
}

/* 死亡的保安立刻摘掉，防止数组随击杀数无限增长 */
function pruneDeadGuards(){
  for (let i = securityGuards.length - 1; i >= 0; i--){
    if (!securityGuards[i].userData.alive) securityGuards.splice(i, 1);
  }
}

/* 同一批保安之间的最小间距 */
const GUARD_MIN_GAP = 2.4;

/* 固定门前刷新：考场门在 +X 墙（x = 8），这里取门口内侧的几个点。
   五个点组成一个很小的扇形，既保证"都从门口进来"，又不至于两个模型完全叠住。
   dx 是相对门口内侧基准的偏移，dz 是绝对 z。 */
const GUARD_DOOR_INSET = 0.7;
const GUARD_DOOR_SPOTS = [
  { dx: 0.0,  dz: -1.2 },
  { dx: 0.0,  dz:  1.2 },
  { dx: -0.8, dz:  0.0 },
  { dx: -1.4, dz: -1.8 },
  { dx: -1.4, dz:  1.8 }
];

/* 门前的固定刷点：优先找没被人占住的，实在挤不下也得给出一个可站的点 ——
   少刷一个会让"打满 200 开门"永远凑不齐。 */
function guardDoorSpot(i, extra){
  const x0 = state.bounds.x - GUARD_DOOR_INSET;
  let fallback = null;
  for (let k = 0; k < GUARD_DOOR_SPOTS.length; k++){
    const o = GUARD_DOOR_SPOTS[(i + k) % GUARD_DOOR_SPOTS.length];
    const x = x0 + o.dx, z = o.dz;
    if (collides(x, z, 0.34)) continue;
    if (!fallback) fallback = { x: x, z: z };
    if (guardSpotClear(x, z, 1.0, extra)) return { x: x, z: z };
  }
  return fallback;
}

/* 电梯间刷新：保安从教学楼入口（电梯间，1F 南端，见 building.js）一路跑进考场。
   电梯间在楼梯间再往南：x≈[8,13]，z≈[-34,-27]，中心 (10.5,-31.5)。 */
const GUARD_ELEVATOR_SPOTS = [
  { x: 9.5,  z: -31.0 },
  { x: 10.5, z: -31.5 },
  { x: 11.5, z: -32.0 },
  { x: 9.5,  z: -32.5 },
  { x: 11.5, z: -30.5 }
];
function guardElevatorSpot(i, extra){
  let fallback = null;
  for (let k = 0; k < GUARD_ELEVATOR_SPOTS.length; k++){
    const o = GUARD_ELEVATOR_SPOTS[(i + k) % GUARD_ELEVATOR_SPOTS.length];
    if (collides(o.x, o.z, 0.34)) continue;
    if (!fallback) fallback = { x: o.x, z: o.z };
    if (guardSpotClear(o.x, o.z, 1.0, extra)) return { x: o.x, z: o.z };
  }
  return fallback;
}

/* 这个点（x, z）离已有的保安够不够远；extra 是本批已经选走的点 */
function guardSpotClear(x, z, gap, extra){
  for (let i = 0; i < securityGuards.length; i++){
    const g = securityGuards[i];
    if (!g.userData || g.userData.alive === false) continue;
    const p = g.group.position;
    if (Math.hypot(x - p.x, z - p.z) < gap) return false;
  }
  if (extra){
    for (let i = 0; i < extra.length; i++){
      if (Math.hypot(x - extra[i].x, z - extra[i].z) < gap) return false;
    }
  }
  return true;
}

/* 找一个站着不卡、而且不和别人挤在一起的位置。

   为什么要这个：保安是"围着玩家撒一圈"刷出来的，撒到桌子/讲台里一样算刷成功 ——
   updateGuards 是逐轴判碰撞地走的，一旦整个人陷在几何体里，两个轴都撞，
   他这一辈子都不会再动。结果是 HUD 上一直挂着「⚠ 保安 1」，
   玩家把考场翻遍也找不到他（打满 200 个才开门，于是他永远开不了门）。

   起始角**必须是随机的**：老实现固定从 k = 0（角度 0）试起，第一个合法点
   永远落在同一个坐标，于是同一批的两个保安、以及之后每一批，
   全叠在同一个点上 —— 玩家看到的就是"保安只刷在一个地方"。
   startAngle 传进来时（同一批的第二个）用 +π，一左一右包抄。
   间距要求从 2.4 逐级放宽到 0：宁可挤一点，也不能因为"没地方站"就不刷 ——
   那会让 200 杀的开门口令永远凑不齐。 */
function guardFreeSpot(startAngle, extra, gapWanted){
  const bd = state.bounds;
  const base = (startAngle === undefined) ? Math.random() * TAU : startAngle;
  const gaps = [gapWanted === undefined ? GUARD_MIN_GAP : gapWanted, 1.4, 0.6, 0];
  const rings = [GUARD_SPAWN_DIST, GUARD_SPAWN_DIST + 1.6, GUARD_SPAWN_DIST + 3.2];

  for (const gap of gaps){
    const ok = [];
    for (const dist of rings){
      for (let k = 0; k < 12; k++){
        const a = base + (k / 12) * TAU;
        const x = clamp(state.pos.x + Math.cos(a) * dist, -bd.x + 0.5, bd.x - 0.5);
        const z = clamp(state.pos.z + Math.sin(a) * dist, bd.zMin + 0.5, bd.zMax - 0.5);
        if (Math.hypot(x - state.pos.x, z - state.pos.z) < 3.4) continue;
        if (collides(x, z, 0.34)) continue;
        if (!guardSpotClear(x, z, gap, extra)) continue;
        ok.push({ x: x, z: z });
      }
    }
    /* 同一条间距下有多个位置时随机取一个，避免每批都挑同一个方向 */
    if (ok.length) return ok[Math.floor(Math.random() * ok.length)];
  }

  const FALLBACK = [
    { x: 0, z: bd.zMin + 1.4 }, { x: 0, z: bd.zMax - 1.4 },
    { x: -bd.x + 1.4, z: 0 },   { x: bd.x - 1.4, z: 0 }
  ];
  for (const f of FALLBACK){
    if (collides(f.x, f.z, 0.34)) continue;
    if (!guardSpotClear(f.x, f.z, 0.6, extra)) continue;
    return f;
  }
  return null;
}

/* 已经在几何体里卡住的保安：每帧试着往外挪一步；挪不出来就先记时，
   超过 1.2 秒直接换个能站的地方。找不到活人比"瞬移了一下"严重得多。

   半径要按圈放大到 2.6m：只试 0.4m 的话，陷在课桌（半宽 0.92）中间的人
   每一个方向都还撞着，于是"每帧往外挪一点"永远不会发生 —— 那不叫修好，
   只是把 1.2 秒的兜底当成主路径。一圈试不通就试下一圈，一帧之内就该出来。 */
const UNSTICK_RINGS = [0.4, 0.8, 1.3, 1.9, 2.6];
function unstickGuard(g, dt){
  const p = g.group.position;
  if (!collides(p.x, p.z, 0.3)){ g.userData.stuckT = 0; return false; }
  for (const r of UNSTICK_RINGS){
    for (let k = 0; k < 16; k++){
      const a = (k / 16) * TAU;
      const nx = p.x + Math.cos(a) * r, nz = p.z + Math.sin(a) * r;
      if (!collides(nx, nz, 0.3)){ p.x = nx; p.z = nz; g.userData.stuckT = 0; return true; }
    }
  }
  g.userData.stuckT = (g.userData.stuckT || 0) + dt;
  if (g.userData.stuckT > 1.2){
    /* 挪到别处时也别踩到同事身上 */
    const sp = guardFreeSpot(undefined, null, 1.2);
    if (sp){ p.x = sp.x; p.z = sp.z; g.userData.stuckT = 0; return true; }
  }
  return false;
}

function spawnTwoGuards(){
  if (state.ended) return;
  pruneDeadGuards();

  const n = Math.min(2, guardPoolRemaining());
  if (n <= 0) return;

  const speedBonus = Math.min(GUARD_SPEED_MAX_BONUS, state.guardKills * 0.04);

  /* 每批换个起始角，同一批的第二个从对面包抄 —— 两个保安不该从同一个点里长出来 */
  const baseAngle = Math.random() * TAU;
  const picked = [];

  for (let i = 0; i < n; i++){
    const sp = guardSpawnMode === 'door' ? guardDoorSpot(i, picked)
             : guardSpawnMode === 'elevator' ? guardElevatorSpot(i, picked)
             : guardFreeSpot(baseAngle + i * Math.PI, picked);
    /* 整个考场都站不下就别刷了 —— 刷出来一个找不着的保安，
       比少刷一个严重得多（打满 200 个才开门，那一个能卡死整局）。 */
    if (!sp) break;
    picked.push(sp);
    const g = buildSecurityGuard(sp.x, sp.z);
    g.userData = { speed: SPRINT_SPEED * guardSpeedScale + speedBonus, alive: true, blink: 0 };
    securityGuards.push(g);
    state.guardsSpawned = (state.guardsSpawned || 0) + 1;
  }
}

function initGuardLights(){
  for (let i = 0; i < GUARD_LIGHTS; i++){
    const l = new THREE.PointLight(0xff2211, 0, 7, 2);
    l.userData.noTensionDim = true;      /* 强度由闪烁驱动，不随紧张值调光 */
    scene.add(l);
    guardLights.push(l);
  }
}

/* near 为按距离排序后的前两名保安（可为 null） */
function updateGuardLights(near, t){
  for (let i = 0; i < guardLights.length; i++){
    const l = guardLights[i];
    const g = near[i];
    if (g && g.userData.alive){
      g.group.add(l);                    /* 自动从上一个父节点摘离 */
      l.position.set(0, 1.84, 0.02);
      l.intensity = (0.9 + 2.4 * (g.userData.blink || 0)) * (1 + 0.5 * t);
    } else {
      l.intensity = 0;                   /* 留在场景里，避免 shader 重编译 */
    }
  }
}

/* ---------------------------- AI 主循环 ---------------------------- */
function updateGuards(realDt, t){
  if (state.ended || state.frozen || state.view !== 'world') return;

  let minDist = Infinity;
  nearestGuardDist = Infinity;
  const near = [null, null], nearD = [Infinity, Infinity];

  for (let i = 0; i < securityGuards.length; i++){
    const g = securityGuards[i];
    if (!g.userData.alive) continue;

    const pos = g.group.position;
    /* 卡进桌子里 / 被推歪到几何体内部：逐轴滑动救不出来，
       这种保安会一直 alive、一直计入「⚠ 保安 N」，玩家永远找不到他。
       放在算距离之前挪，这一帧的追击方向就已经是修正后的了。 */
    unstickGuard(g, realDt);
    const dx = state.pos.x - pos.x, dz = state.pos.z - pos.z;
    const d = Math.hypot(dx, dz);
    if (d < minDist) minDist = d;

    if (d < nearD[0]){ nearD[1] = nearD[0]; near[1] = near[0]; nearD[0] = d; near[0] = g; }
    else if (d < nearD[1]){ nearD[1] = d; near[1] = g; }

    /* 被臭水熏到：站着干呕，不追也不抓。
       staggerUntil 是另一回事：被武器/拳头推得踉跄，时间很短（0.45s）。
       两者共用"站着不动"这一段代码，但各有各的到期时间 ——
       合成一个字段会让"干呕 2.6s"和"踉跄 0.45s"互相覆盖。
       判定挂在世界时钟上（state.worldTime），所以通报弹窗慢放时一起变慢。 */
    const stunned = Math.max(g.userData.stinkUntil || 0,
                             g.userData.staggerUntil || 0) > state.worldTime;

    /* 抓到玩家：有血条就扣血，没有血条直接结局。熏晕期间抓不了。 */
    if (!stunned && d < GUARD_HIT_RADIUS){
      if (!handleGuardCatch(g)) return;
    }

    if (!stunned && d > 0.01){
      const sp = g.userData.speed * realDt;
      const nx = pos.x + (dx / d) * sp;
      const nz = pos.z + (dz / d) * sp;
      if (!collides(nx, pos.z, 0.3)) pos.x = nx;
      if (!collides(pos.x, nz, 0.3)) pos.z = nz;
      g.group.rotation.y = Math.atan2(dx, dz);
    }

    if (stunned){
      /* 弯腰、捂嘴、脑袋上下抖 —— 一眼看得出"这货暂时废了" */
      const jerk = Math.sin(t * 18 + g.phase);
      g.head.rotation.x = 0.45 + jerk * 0.18;
      g.head.rotation.y = 0;
      g.group.rotation.z = jerk * 0.14;
      g.armL.rotation.x = -1.15;
      g.armR.rotation.x = -1.15;
    } else {
      g.head.rotation.x = 0;
      g.group.rotation.z = 0;
      const v = Math.sin(t * 3.5 + g.phase) * 0.25;
      g.armL.rotation.x = -0.25 + v;
      g.armR.rotation.x = -0.25 - v;
      g.head.rotation.y = Math.sin(t * 2 + g.phase) * 0.25;
    }

    if (g.warnLight){
      const blink = 0.5 + 0.5 * Math.sin(t * 6 + g.phase);
      g.warnLight.material.color.setRGB(1, blink * 0.4, blink * 0.4);
      g.userData.blink = blink;
    }
    if (g.glow){
      const b = g.userData.blink || 0;
      const tn = getTension();
      g.glow.material.opacity = 0.16 + 0.42 * b + 0.30 * tn;
      g.glow.scale.setScalar(1 + 0.5 * b + 0.6 * tn);
    }
  }

  updateGuardLights(near, getTension());
  nearestGuardDist = minDist;
}

/* 保安抓住玩家。返回 false 表示本局已结束 */
function handleGuardCatch(g){
  /* 门已开 = 你已经赢了：保安不会再拦你，他们只是让开一条路。
     没有这条，隐藏结局的最后几步会被身后追兵硬生生截胡 —— 打赢了却被抓走，
     既不合逻辑，也让玩家觉得自己被系统坑了。 */
  if (state.doorOpen) return true;

  const now = state.worldTime;           /* 世界时钟：慢放期间无敌帧同步变慢 */
  if (state.hpVisible && state.hp > 0){
    if (now - state.lastDamageAt < PLAYER_HURT_INVULN / 1000) return true;
    state.lastDamageAt = now;
    if (!damagePlayer(g, now)){
      endByGuards();
      return false;
    }
    return true;
  }
  endByGuards();
  return false;
}

function endByGuards(){
  if (state.ended) return;
  state.ended = true;
  hideAllPanels();
  clearGuards();

  audio.beep(110, 0.5, 0.08, 'sawtooth');
  audio.beep(80, 0.7, 0.06, 'sawtooth');

  $('endTitle').textContent = '被 保 安 抓 走';
  $('endSub').textContent = '两名保安一左一右架住了你，你被拖出了考场。';
  showEnding(0,
    '你在考场上公然殴打监考老师，性质恶劣。\n' +
    '本次比赛成绩作废，并记入诚信档案。\n\n' +
    '遵守考场纪律，人人有责。\n下次别再打老师了。');
}

function clearGuards(){
  for (const g of securityGuards) scene.remove(g.group);
  securityGuards.length = 0;
}

/* =========================================================================
   击杀里程碑 + 保安队通报窗
   ---------------------------------------------------------------------
   10 / 20 / 50 / 100 杀各解锁成就；从第 10 杀起，每次击杀有 10% 概率
   触发通报。文案按击杀数分四档，语气逐级升级：
     口头提醒 → 正式警告 → 纪律处理 → 最后通牒
   通报期间世界切到 0.1x 慢放（考试计时不受影响），选项含"配合"与两条
   随机叛逆台词；嘴硬则 defiance +1，直接推高紧张值，并立刻加派人手。
   ========================================================================= */

const GUARD_WARN_MIN_KILLS = 10;
const GUARD_WARN_CHANCE = 0.1;

const GUARD_WARN_LINES = [
  /* 档 0（10-19） */
  [
    '同学，请停止攻击工作人员，配合我们维护考场秩序。',
    '保安同志正在赶来。请你放下拳头，我们可以当作什么都没发生。',
    '考场监控已全程记录。现在停手，还来得及。',
    '同学，打人不能加分。有话好好说，先放下手。'
  ],
  /* 档 1（20-49） */
  [
    '最后一次警告。继续袭击工作人员，我们将按考场纪律处理你。',
    '你的行为已构成扰乱考试秩序，我们有权取消你的成绩。',
    '考场秩序由我们负责，你的拳头不负责。立刻停手。',
    '再说一次：放下拳头。这是通知，不是请求。'
  ],
  /* 档 2（50-99） */
  [
    '拒不配合者，我们有权取消成绩并禁赛三年。这是正式通知。',
    '你已经打倒了足够多的工作人员。收手，或者承担后果。',
    '考场外已经叫好了人。你要继续，我们就只能继续。',
    '《NOI 竞赛纪律》第三十一条：你现在每挥一拳，都在给自己记一笔。'
  ],
  /* 档 3（100+） */
  [
    '现在立刻双手抱头蹲下，放弃抵抗，否则我们将动用物理。',
    '最后一次。抱头，蹲下，别逼我们把这考场拆了。',
    '你是考生，不是选手队。停下，或者我们让你停下。',
    '给你十秒。之后发生的事情，写在通报里会很难看。'
  ]
];

const GUARD_WARN_DEFY = ['那就试试', '我才不呢', '有本事来抓我啊',
                         '等我先把这题写完', '你们人多了不起？'];

/* 纯函数：按击杀数选警告档位（便于单测） */
function guardWarnTier(kills){
  if (kills < 20) return 0;
  if (kills < 50) return 1;
  if (kills < 100) return 2;
  return 3;
}

/* 纯函数：本次是否触发警告窗（rng 注入，便于单测） */
function guardWarnRoll(kills, rng){
  if (kills < GUARD_WARN_MIN_KILLS) return false;
  return rng() < GUARD_WARN_CHANCE;
}

function checkGuardKillMilestones(k){
  if (k >= 5) unlockAch('guard_5');
  if (k >= 10) unlockAch('guard10');
  if (k >= 20) unlockAch('guard20');
  if (k >= 50) unlockAch('guard50');
  if (k >= 100) unlockAch('guard100');
}

function maybeGuardWarning(){
  if (!guardWarnRoll(state.guardKills, Math.random)) return;

  beginSlowMo();

  const lines = GUARD_WARN_LINES[guardWarnTier(state.guardKills)];
  const line = lines[Math.floor(Math.random() * lines.length)];
  const pool = GUARD_WARN_DEFY.slice();
  const defyA = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
  const defyB = pool[Math.floor(Math.random() * pool.length)];

  state.slowMoDlg = openDialog({
    title: '警告 · 保安队 · 第 ' + state.guardKills + ' 次通报',
    text: line,
    options: [
      { label: defyA, cb: dlg => defyGuardWarning(dlg) },
      { label: defyB, cb: dlg => defyGuardWarning(dlg) }
    ]
  });
}

function defyGuardWarning(dlg){
  endSlowMo();
  closeDialog(dlg);
  state.defiance = (state.defiance || 0) + 1;
  toast('对面沉默了两秒 —— 然后更多脚步声涌了进来。', 2200);
  audio.beep(180, 0.25, 0.06, 'sawtooth');
  spawnTwoGuards();
}

/* =========================================================================
   隐藏结局 · 一人军队（击倒全部 200 名保安）
   ========================================================================= */
function endByTotalVictory(){
  if (state.ended) return;
  state.ended = true;
  hideAllPanels();
  clearGuards();
  unlockAch('army');

  $('endTitle').textContent = '无 人 能 挡';
  $('endSub').textContent = '第 200 名保安倒下了。然后，你走进了那片白光。';
  showEnding(state.totalScore,
    '门在身后合上。没有风，没有声音，也没有人追出来。\n\n' +
    '你站在光里回头看：两百具叠在一起的制服，帽檐、徽章、对讲机散了一地。\n' +
    '监考老师不知什么时候已经跑了，教务处的电话打到了天亮。\n' +
    '来的人不认识你，只认识这个考场。他们后来把整层楼封了，\n' +
    '只在记录里写：那个考生赢了，然后走了。\n\n' +
    '《NOI 竞赛纪律》最后一页写着：\n' +
    '“纪律需要人来执行。如果执行纪律的人都不够了，\n' +
    '那考场里就只剩下一条纪律：别惹写代码的人。”\n\n' +
    '隐藏结局 · 一人军队　　击倒保安 200 / 200');
  clearSave();
}

/* 收敛所有面板（结局 / 违纪分支共用） */
function hideAllPanels(){
  dismissDialogs();
  ['hud', 'pauseMenu', 'codeUI', 'paperUI', 'corridorUI',
   'bathroomUI', 'npcComputerUI', 'minimapWrap', 'bagUI', 'hotbar'].forEach(id => {
     const e = $(id);
     if (e) e.classList.add('hidden');
   });
  crosshair.classList.add('hidden');
  promptEl.classList.add('hidden');
}
