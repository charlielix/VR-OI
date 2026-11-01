'use strict';
/* =========================================================================
   tension —— 紧张值系统：出拳之后，考场开始"不对劲"
   ---------------------------------------------------------------------
   紧张值 0→1 由三部分决定：
     · 基础值：随已击倒保安数上升，120 人封顶；
     · 逼近增益：最近的保安越近，加成越高（上限 0.18）；
     · 平静通道：回到座位附近且几乎不动时，整体压到 0.55 倍 ——
       紧张不是单向的，得给玩家一个"息事宁人"的出口。
   数值用两个时间常数平滑：上升快（1.1s），回落慢（3.4s）。

   所有氛围效果都挂在这个值上，各自渐变：
     灯光压暗 + 雾色/半球光偏暗红、canvas 对比度/去饱和/压暗、
     屏幕暗角 + 心跳节拍收缩、心跳音（BPM 68→152）、
     镜头抖动（player.js）、全局拖影强度（postfx.js）、假接触阴影加深。
   ========================================================================= */

const TENSION_KILLS_FULL = 120;
const TENSION_NEAR_MAX = 0.18;
const TENSION_NEAR_RANGE = 4.0;
const TENSION_CALM_RADIUS = 1.6;
const TENSION_CALM_SPEED = 0.3;
const TENSION_CALM_FLOOR = 0.55;
const TENSION_RISE_TAU = 1.1;
const TENSION_FALL_TAU = 3.4;
const TENSION_NIGHTMARE_FLOOR = 0.22;

const TENSION_FOG_CALM = 0x090b11, TENSION_FOG_TENSE = 0x1d0709;
const TENSION_SKY_CALM = 0xc8d8ff, TENSION_SKY_TENSE = 0x8a3535;
const TENSION_GROUND_CALM = 0x232833, TENSION_GROUND_TENSE = 0x160a0a;

let tension = 0;
let tAmbient = null, tHemi = null;
const tPoints = [];
let heartPhase = 0, lastBeatIdx = -1;

const _tFogA = new THREE.Color(TENSION_FOG_CALM), _tFogB = new THREE.Color(TENSION_FOG_TENSE);
const _tSkyA = new THREE.Color(TENSION_SKY_CALM), _tSkyB = new THREE.Color(TENSION_SKY_TENSE);
const _tGndA = new THREE.Color(TENSION_GROUND_CALM), _tGndB = new THREE.Color(TENSION_GROUND_TENSE);

/* 纯函数：目标紧张值（便于单测） */
function tensionTarget(kills, nearestDist, atSeat, nightmare){
  /* 基础值 = 屠杀记忆，只有它能被"坐定"平息 */
  let base = Math.min(1, (kills || 0) / TENSION_KILLS_FULL);
  if (nightmare) base = Math.max(base, TENSION_NIGHTMARE_FLOOR);
  if (atSeat) base *= TENSION_CALM_FLOOR;

  /* 贴身威胁是即时的，不打折 —— 保安贴在脸上时坐着也没用 */
  let near = 0;
  if (nearestDist < TENSION_NEAR_RANGE){
    near = TENSION_NEAR_MAX * (1 - nearestDist / TENSION_NEAR_RANGE);
  }
  return clamp(base + near, 0, 1);
}

function getTension(){ return tension; }

/* 在 init 时把灯光引用捞出来（点光源按数量进 shader，缓一下引用值得） */
function initTension(){
  scene.traverse(o => {
    if (!tAmbient && o.isAmbientLight) tAmbient = o;
    if (!tHemi && o.isHemisphereLight) tHemi = o;
    if (o.isPointLight && tPoints.indexOf(o) < 0) tPoints.push(o);
  });
}

/* 每帧：平滑 + 施加全部氛围效果 */
function updateTension(dt, kills, nearestDist, playerSpeed){
  const dx = state.pos.x, dz = state.pos.z - SEAT_CENTER_Z;
  const atSeat = Math.hypot(dx, dz) < TENSION_CALM_RADIUS &&
                 playerSpeed < TENSION_CALM_SPEED;
  const nightmare = (state.guardsSpawned || 0) > 0;

  let target = tensionTarget(kills, nearestDist, atSeat, nightmare);
  /* 嘴硬是有代价的：每次违抗通报直接推高紧张值（最多 +0.25） */
  if (state.defiance > 0) target = clamp(target + Math.min(0.25, state.defiance * 0.12), 0, 1);

  const tau = target > tension ? TENSION_RISE_TAU : TENSION_FALL_TAU;
  tension += (target - tension) * (1 - Math.exp(-dt / tau));

  applyTension(tension, dt);
  return tension;
}

function applyTension(t, dt){
  const cvs = $('scene');

  /* 战斗光影关闭：把紧张值驱动的灯光/雾/调色/暗角/拖影全部复位到"平时"，
     战斗时画面保持正常亮度与色调（心跳音与镜头抖动不受这个开关影响）。
     每帧都设一次很便宜（几个赋值），比"记住上一帧状态再回滚"省心。 */
  if (!combatLightFx){
    if (cvs) cvs.style.filter = '';
    if (tAmbient) tAmbient.intensity = 0.75;
    if (tHemi){
      tHemi.intensity = 0.85;
      tHemi.color.copy(_tSkyA);
      tHemi.groundColor.copy(_tGndA);
    }
    for (const p of tPoints){
      if (p.userData && p.userData.noTensionDim) continue;
      p.intensity = 1.1;
    }
    if (scene.fog) scene.fog.color.copy(_tFogA);
    setPostDamp(0);
    const vig0 = $('tenseVignette');
    if (vig0) vig0.style.opacity = '0';
    heartPhase = 0; lastBeatIdx = -1;
    return;
  }

  /* 1. 整体调色：只作用于 WebGL 画面，不污染 HUD */
  if (cvs){
    cvs.style.filter = t < 0.01 ? '' :
      'contrast(' + (1 + 0.24 * t).toFixed(3) + ') ' +
      'saturate(' + (1 - 0.30 * t).toFixed(3) + ') ' +
      'brightness(' + (1 - 0.26 * t).toFixed(3) + ')';
  }

  /* 2. 灯光压暗 + 色偏 */
  if (tAmbient) tAmbient.intensity = lerp(0.75, 0.16, t);
  if (tHemi){
    tHemi.intensity = lerp(0.85, 0.22, t);
    tHemi.color.copy(_tSkyA).lerp(_tSkyB, t);
    tHemi.groundColor.copy(_tGndA).lerp(_tGndB, t);
  }
  for (const p of tPoints){
    /* 警灯与终局白光的强度各自驱动，不随紧张值调光 */
    if (p.userData && p.userData.noTensionDim) continue;
    p.intensity = lerp(1.1, 0.3, t);
  }
  if (scene.fog) scene.fog.color.copy(_tFogA).lerp(_tFogB, t);

  /* 3. 假接触阴影加深 */
  deepenContactShadows(t);

  /* 4. 全局拖影强度 */
  setPostDamp(t);

  /* 5. 暗角 + 心跳 */
  const vig = $('tenseVignette');
  if (t < 0.02){
    if (vig) vig.style.opacity = '0';
    heartPhase = 0;
    lastBeatIdx = -1;
    return;
  }

  const bpm = 68 + 84 * t;
  heartPhase += dt * (bpm / 60) * TAU;
  const idx = Math.floor(heartPhase / Math.PI);      /* 每周期两声：扑-扑 */
  if (idx !== lastBeatIdx){
    lastBeatIdx = idx;
    const second = idx % 2 === 1;
    audio.beep(second ? 52 : 44, second ? 0.16 : 0.20, 0.09 + 0.06 * t, 'sine');
  }
  if (vig){
    const beat = Math.pow(Math.max(0, Math.sin(heartPhase)), 6);
    vig.style.opacity = (0.40 * t + 0.26 * t * beat).toFixed(3);
  }
}
