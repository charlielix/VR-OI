'use strict';
/* =========================================================================
   player —— FPS 视角 / 指针锁定 / 移动 / 跳跃 / 小地图
   ---------------------------------------------------------------------
   关键约定：键盘与鼠标只写"目标角"，applyLook() 负责插值。
   真实朝向只存在 state.yaw / state.pitch 里；出拳回弹、紧张抖动都是
   纯视觉叠加，不写回 state —— 否则抖几次玩家就真的转歪了。
   ========================================================================= */

/* ---------------------------- 视角 ---------------------------- */
let recoilPitch = 0, recoilYaw = 0;   /* 出拳回弹（纯视觉） */
let shakeT = 0;

function applyLook(dt){
  /* 回弹平滑归零 */
  const kr = 1 - Math.exp(-dt * 11);
  recoilPitch += (0 - recoilPitch) * kr;
  recoilYaw += (0 - recoilYaw) * kr;

  pitchTarget = clamp(pitchTarget, -1.35, 1.35);

  if (smoothAmount < 0.01){
    state.yaw = yawTarget;
    state.pitch = pitchTarget;
  } else {
    const tau = Math.max(smoothAmount * 0.16, 0.001);
    const k = 1 - Math.exp(-dt / tau);
    state.yaw += (yawTarget - state.yaw) * k;
    state.pitch += (pitchTarget - state.pitch) * k;
  }
}

function kickView(pitchAmt, yawAmt){
  recoilPitch = clamp(recoilPitch + pitchAmt, -0.10, 0.10);
  recoilYaw = clamp(recoilYaw + yawAmt, -0.10, 0.10);
}

/* 紧张态镜头抖动：多频正弦叠加，幅度 ∝ 紧张值 × 移动强度。
   上限刻意压得很小 —— 这是"吓到手抖"，不是晕动症模拟器。 */
const SHAKE_MAX = 0.011;
function applyShake(dt){
  const t = getTension();
  if (t < 0.02 || !shakeEnabled) return;
  shakeT += dt;
  const move = clamp(lastMoveSpeed / 5, 0, 1);
  const amp = SHAKE_MAX * t * (0.30 + 0.70 * move);
  const n1 = Math.sin(shakeT * 37.3) * Math.sin(shakeT * 11.7);
  const n2 = Math.sin(shakeT * 23.1 + 1.3) * Math.sin(shakeT * 7.9 + 0.6);
  camera.rotation.x += (n2 * 0.6 - n1 * 0.4) * amp;
  camera.rotation.y += (n1 * 0.7 + n2 * 0.5) * amp;
}

/* ---------------------------- 指针锁定 ---------------------------- */
/* 只有世界视图捕获鼠标：IDE / 草稿纸 / 走廊 / 面板一律释放，
   否则玩家在 IDE 里一动鼠标视角就乱转 */
const LOOK_VIEWS = new Set(['world']);
const MAX_MOUSE_STEP = 80;             /* 单次位移钳制，防异常跳变 */
let pointerLocked = false, lastLockAt = 0;

function lockElement(){ return renderer ? renderer.domElement : document.body; }
function canLockView(){ return LOOK_VIEWS.has(state.view) && state.started && !state.ended; }

function requestLock(){
  if (pointerLocked || !renderer || !canLockView()) return;
  const el = lockElement();
  if (!el.requestPointerLock) return;
  lastLockTryAt = performance.now();
  try {
    /* 新版浏览器返回 Promise；Esc 后短时间内申请会被拒绝，静默即可。
       失败的处理统一交给 pointerlockerror 事件与主循环里的看门狗。 */
    const r = el.requestPointerLock();
    if (r && typeof r.catch === 'function') r.catch(() => {});
  } catch(e){}
}

/* ---- 锁定被拒时的可见反馈 ----
   requestPointerLock() 在刚按过 Esc 之后会被浏览器拒绝（Chrome 约 1.25s
   冷却期），而且失败是**静默**的：Promise reject、pointerlockerror 事件，
   没有任何界面变化。玩家的体验就是"鼠标点了没反应 / 鼠标失灵了"，
   完全无从判断该等一等还是该刷新页面 —— 这个坑必须显式说出来。
   节流是因为菜单的"返回考场"会被连点，不节流会糊满屏幕。 */
let lockHintAt = 0, lockHintArmed = false, lastLockTryAt = 0;
const LOCK_HINT_THROTTLE = 2200;
/* 申请后等多久才判定"这次锁定失败了"。不能一申请就报警：
   requestPointerLock() 是异步的，真正拿到锁要几十毫秒，
   立刻提示会在每次正常点击时都误报一次。 */
const LOCK_SETTLE_MS = 1400;
function flashLockHint(){
  const now = performance.now();
  /* 只有"比赛进行中"才谈得上鼠标锁定：没开始 / 已结束都是死状态，
     提示"再点一次画面"对玩家毫无用处，只会变成噪音。
     这个判定放在这里（而不是 watchLockHint 里）是因为 flashLockHint 有三个
     调用点 —— 点击画面、pointerlockerror、主循环看门狗 —— 每个都各写一遍
     迟早会漏，集中在这里才是唯一正确的做法。 */
  if (!state.started || state.ended) return;
  /* 节流：菜单的"返回考场"会被连点，不节流会把屏幕糊满 */
  if (now - lockHintAt < LOCK_HINT_THROTTLE) return;
  lockHintAt = now;
  if (state.view === 'world'){
    toast('鼠标未锁定 —— 稍等约 1 秒再点一次画面即可', 2000);
  } else {
    /* 还在面板里（Esc 后菜单会盖上来）：等回到世界视图再提示 */
    lockHintArmed = true;
  }
}
/* 从面板回到世界时调用：如果之前申请被拒过，这时补一句提示 */
function flushLockHint(){
  if (!lockHintArmed) return;
  lockHintArmed = false;
  flashLockHint();
}
/* 主循环每帧调用：没锁上、且距上次申请已超过 settle 时间
   → 判定这次锁定真的失败了，提示一次（在面板里就记下来，回世界再提示）。
   两点注意：
   ① 必须等 settle —— requestPointerLock 是异步的，刚点完那一瞬间
      pointerLocked 还是 false，不等待就会在每次正常点击时误报；
   ② **不能**在这里限制 view === 'world'。Esc 之后菜单会盖上来，
      而被拒的那一下正发生在面板里 —— 如果这里把非 world 一律 return，
      就永远不会 arm，flushLockHint 也就永远没东西可补，
      玩家回到考场后依旧是一片沉默。view 的分流交给 flashLockHint 做。 */
function watchLockHint(){
  if (pointerLocked) return;
  if (performance.now() - lastLockTryAt < LOCK_SETTLE_MS) return;
  flashLockHint();
}
function releaseLock(){
  if (!pointerLocked) return;
  try { document.exitPointerLock(); } catch(e){}
}

/* ---------------------------- 玩家移动 ---------------------------- */
const KEYMAP = {
  KeyW: 'w', KeyA: 'a', KeyS: 's', KeyD: 'd',
  ShiftLeft: 'shift', ShiftRight: 'shift'
};

/* 复用临时向量，避免每帧 new Vector3 触发 GC */
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _move = new THREE.Vector3();

const WALK_SPEED = 3.1, SPRINT_SPEED = 5.0, PLAYER_RADIUS = 0.28;
const PLAYER_EYE = 1.65;

/* 移动钳制范围不写死在这里：校园与考场房间是两个不同尺寸的矩形，
   由 state.bounds 随区域切换（见 core.js 的 AREA_BOUNDS）。
   注意 z 不是对称的 —— 校园从校门(z=15)一直伸到教学楼(z=-29)，
   用 ±halfD 那种对称写法会把校门外的出生点直接夹掉。 */

function updatePlayer(dt){
  updateJump(dt);

  /* 辣条只加疾走，走路不变 —— 物品描述里写的就是"疾走快三成"，
     两处说法必须一致，否则玩家会觉得描述在骗他。 */
  const sprinting = !!state.keys['shift'];
  let speed = sprinting ? SPRINT_SPEED : WALK_SPEED;
  if (sprinting && state.worldTime < state.spicyUntil) speed *= SPICY_BOOST;
  _fwd.set(-Math.sin(state.yaw), 0, -Math.cos(state.yaw));
  _right.set(Math.cos(state.yaw), 0, -Math.sin(state.yaw));
  _move.set(0, 0, 0);
  if (state.keys['w']) _move.add(_fwd);
  if (state.keys['s']) _move.sub(_fwd);
  if (state.keys['d']) _move.add(_right);
  if (state.keys['a']) _move.sub(_right);

  const moving = _move.lengthSq() > 0;
  lastMoveSpeed = moving ? speed : 0;

  if (moving){
    _move.normalize().multiplyScalar(speed * dt);
    const bd = state.bounds;
    const x0 = bd.xMin !== undefined ? bd.xMin : -bd.x;
    const x1 = bd.xMax !== undefined ? bd.xMax : bd.x;
    const nx = clamp(state.pos.x + _move.x, x0, x1);
    const nz = clamp(state.pos.z + _move.z, bd.zMin, bd.zMax);
    /* 分轴滑动碰撞：撞到桌子不会整个人卡住，而是顺着边缘滑过去 */
    const air = !onGround;
    if (air || !collides(nx, state.pos.z, PLAYER_RADIUS)) state.pos.x = nx;
    if (air || !collides(state.pos.x, nz, PLAYER_RADIUS)) state.pos.z = nz;

    state.bob += dt * (state.keys['shift'] ? 15 : 11);
    if (Math.sin(state.bob) > 0.96 && Math.random() < 0.4) audio.step();
  } else {
    state.bob += dt * 1.2;
  }

  const bobY = moving ? Math.sin(state.bob) * 0.022 : Math.sin(state.bob) * 0.004;
  camera.position.set(state.pos.x, PLAYER_EYE + jumpY + bobY, state.pos.z);
  camera.rotation.set(state.pitch, state.yaw, 0, 'YXZ');
  camera.rotation.x += recoilPitch;
  camera.rotation.y += recoilYaw;
  applyShake(dt);
}

/* ---------------------------- 跳跃 ---------------------------- */
const JUMP_GRAVITY = 20, JUMP_VELOCITY = 6.4;    /* 跳高约 1.0m */
let jumpY = 0, velY = 0, onGround = true;
let _jumpSafeX = 0, _jumpSafeZ = 0;

function tryJump(){
  if (!onGround || state.view !== 'world' || state.ended) return;
  velY = JUMP_VELOCITY;
  onGround = false;
  _jumpSafeX = state.pos.x;
  _jumpSafeZ = state.pos.z;
  audio.beep(420, 0.05, 0.03, 'triangle');
}

function updateJump(dt){
  if (onGround) return;
  velY -= JUMP_GRAVITY * dt;
  jumpY += velY * dt;
  if (jumpY <= 0){
    jumpY = 0; velY = 0; onGround = true;
    audio.step();
    /* 落点卡进障碍（跳到桌子上之类）→ 退回起跳点，绝不卡死 */
    if (collides(state.pos.x, state.pos.z, PLAYER_RADIUS)){
      state.pos.x = _jumpSafeX;
      state.pos.z = _jumpSafeZ;
    }
  }
}

/* ---------------------------- 小地图 ---------------------------- */
/* 小地图要画两个完全不同的区域，所以坐标系不能在写死 ROOM_W/ROOM_D，
   而是跟着当前区域的边界走。校园里还要多画几个地标（传送圈、安检门、
   志愿者），否则一张全是草地的地图等于没有信息。 */
let mmFrameSkip = 0;
function drawMinimap(){
  if (++mmFrameSkip % 4 !== 0) return;         /* 隔帧画，省掉 3/4 的 2D 开销 */

  const c = minimap, ctx = mmCtx, W = c.width, H = c.height;
  ctx.fillStyle = 'rgba(10,13,20,.85)';
  ctx.fillRect(0, 0, W, H);

  const inCampus = state.area === 'campus';
  /* 世界范围 → 画布范围。校园用 CAMPUS_*，房间沿用 ROOM_*，楼内用 hall 边界 */
  const world =
    state.area === 'campus' ? { x0: -CAMPUS_HALF_W, x1: CAMPUS_HALF_W, z0: CAMPUS_MIN_Z, z1: CAMPUS_MAX_Z } :
    state.area === 'hall1'  ? { x0: 7.4, x1: 30, z0: -27, z1: 27 } :
    state.area === 'hall2'  ? { x0: 7.4, x1: 30, z0: 33,  z1: 87 } :
                              { x0: -ROOM_W / 2, x1: ROOM_W / 2, z0: -ROOM_D / 2, z1: ROOM_D / 2 };
  const sx = W / (world.x1 - world.x0), sy = H / (world.z1 - world.z0);
  const tx = x => (x - world.x0) * sx;
  const ty = z => (z - world.z0) * sy;

  /* ---- 地标（只画校园的：房间的地标就是障碍物本身） ---- */
  if (inCampus){
    const mark = (wx, wz, color, r) => {
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(tx(wx), ty(wz), r, 0, TAU); ctx.fill();
    };
    /* 传送圈：缓慢呼吸，好认 */
    const pulse = 0.55 + 0.45 * Math.sin(performance.now() * 0.004);
    ctx.fillStyle = 'rgba(120,240,255,' + pulse.toFixed(2) + ')';
    ctx.beginPath(); ctx.arc(tx(CAMPUS_PORTAL_X), ty(CAMPUS_PORTAL_Z), 4, 0, TAU); ctx.fill();
    mark(CAMPUS_AUDIT_X, CAMPUS_AUDIT_Z, '#ffcc57', 3.2);            /* 安检口 */
    for (const v of VOLUNTEERS) mark(v.x, v.z, '#e0788a', 2.6);      /* 志愿者 */
    /* 教学楼正面画一条横线，一眼看出"目标在那一头" */
    ctx.strokeStyle = '#4a6bff'; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(tx(-6), ty(CAMPUS_BUILD_Z));
    ctx.lineTo(tx(6), ty(CAMPUS_BUILD_Z));
    ctx.stroke();
  }

  ctx.fillStyle = '#2a3242';
  for (const o of obstacles){
    ctx.fillRect(tx(o.x - o.hw), ty(o.z - o.hd), o.hw * 2 * sx, o.hd * 2 * sy);
  }

  for (const n of npcs){
    const ud = n.userData;
    if (!ud) continue;
    ctx.fillStyle = ud.state === 'seated' ? '#6a7a9a' : '#c08050';
    ctx.beginPath();
    ctx.arc(tx(n.group.position.x), ty(n.group.position.z), 2.2, 0, TAU);
    ctx.fill();
  }

  for (const n of foreignNpcs){
    ctx.fillStyle = '#8a7aa0';
    ctx.beginPath();
    ctx.arc(tx(n.group.position.x), ty(n.group.position.z), 2.0, 0, TAU);
    ctx.fill();
  }

  if (teacher){
    ctx.fillStyle = '#ffcc57';
    ctx.beginPath();
    ctx.arc(tx(teacher.group.position.x), ty(teacher.group.position.z), 2.8, 0, TAU);
    ctx.fill();
  }

  for (const g of securityGuards){
    if (!g.userData.alive) continue;
    const pulse = 0.7 + 0.3 * Math.sin(performance.now() * 0.01);
    ctx.fillStyle = 'rgba(255,68,68,' + pulse.toFixed(2) + ')';
    ctx.beginPath();
    ctx.arc(tx(g.group.position.x), ty(g.group.position.z), 3.2, 0, TAU);
    ctx.fill();
  }

  const px = tx(state.pos.x), py = ty(state.pos.z);
  ctx.fillStyle = '#5b8cff';
  ctx.beginPath();
  ctx.arc(px, py, 3.4, 0, TAU);
  ctx.fill();

  ctx.strokeStyle = 'rgba(91,140,255,.85)';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(px, py);
  ctx.lineTo(px - Math.sin(state.yaw) * 9, py - Math.cos(state.yaw) * 9);
  ctx.stroke();
}
