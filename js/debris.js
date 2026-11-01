'use strict';
/* =========================================================================
   debris —— 击中爆散：身体部件飞散 + 形状感知的刚体
   ---------------------------------------------------------------------
   一拳打中的瞬间，把目标身上所有 Mesh 从角色组里"摘"到场景，作为独立
   刚体模拟。这一步是整个打击感的来源：命中不是播动画，是目标真的散了。

   物理模型（刻意只与房间六面碰撞，碎块之间互不碰撞 —— 按需求从略）：
     · 初速度 = 视线前向分量 + 相对准星的横向偏移 + 随机散布 + 独立上抛
       （横向偏移这一项很关键：它让"打脸"和"打肚子"飞散形状不一样）
     · 接触求解按几何形状取支撑点：盒 → OBB 支撑点（会磕角翻转）、
       球 → 球面（会滚）、柱 → 局部 AABB 近似
     · 明显撞击用完整法向 + 库仑摩擦冲量（含转动惯量），所以斜落会弹开、
       平落地会磕一下翻倒、球会越滚越慢
     · 低速持续一段时间进 sleep，避免静止抖动；尾部 0.5s 淡出
   配套手感：kickView（视角回弹）与 hitStop（顿帧），分别在 player.js / main.js。
   ========================================================================= */

const DEBRIS_GRAVITY = 10;
const DEBRIS_LIFE = 2.5, DEBRIS_FADE = 0.5;
const DEBRIS_DRAG = 1.2;
const DEBRIS_RESTITUTION = 0.1;
const DEBRIS_FRICTION = 0.3;
const DEBRIS_SLEEP_V = 0.28, DEBRIS_SLEEP_W = 1.1, DEBRIS_SLEEP_T = 0.35;
const DEBRIS_MAX_OMEGA = 22, DEBRIS_ANG_DRAG = 2.5, DEBRIS_ROLL_RESIST = 1.6;

/* 房间约束平面：n·p ≥ d（n 指向房间内部） */
const DEBRIS_PLANES = [
  { n: new THREE.Vector3(0, 1, 0), d: 0 },                  /* 地板 */
  { n: new THREE.Vector3(0, -1, 0), d: -ROOM_H },           /* 天花板 */
  { n: new THREE.Vector3(1, 0, 0), d: -ROOM_W / 2 },        /* -X 墙 */
  { n: new THREE.Vector3(-1, 0, 0), d: -ROOM_W / 2 },       /* +X 墙 */
  { n: new THREE.Vector3(0, 0, 1), d: -ROOM_D / 2 },        /* -Z 墙 */
  { n: new THREE.Vector3(0, 0, -1), d: -ROOM_D / 2 }        /* +Z 墙 */
];

const debrisList = [];

/* 复用的临时向量 / 四元数，避免每帧分配（碎块多时这块开销很真实） */
const _dbPos = new THREE.Vector3(), _dbQuat = new THREE.Quaternion(),
      _dbScl = new THREE.Vector3(), _dbFwd = new THREE.Vector3(),
      _dbTo = new THREE.Vector3(), _dbSide = new THREE.Vector3(),
      _dbDir = new THREE.Vector3(), _dbJit = new THREE.Vector3();
const _dbAx = new THREE.Vector3(), _dbAy = new THREE.Vector3(), _dbAz = new THREE.Vector3();
const _dbR = new THREE.Vector3(), _dbCP = new THREE.Vector3();
const _dbVp = new THREE.Vector3(), _dbW = new THREE.Vector3(), _dbRn = new THREE.Vector3();
const _dbT1 = new THREE.Vector3(), _dbT2 = new THREE.Vector3(), _dbT3 = new THREE.Vector3();
const _dbTan = new THREE.Vector3(), _dbRt = new THREE.Vector3();
const _dbQ = new THREE.Quaternion(), _dbAxisN = new THREE.Vector3();

/* ---------------------------- 形状描述 ---------------------------- */
function boxShape(w, h, d){
  return {
    kind: 'box',
    half: new THREE.Vector3(w / 2, h / 2, d / 2),
    /* 单位质量盒体的转动惯量倒数：Ix = (h²+d²)/12 … */
    inv: new THREE.Vector3(12 / (h * h + d * d), 12 / (w * w + d * d), 12 / (w * w + h * h))
  };
}

function debrisShape(geo, scale){
  const p = (geo && geo.parameters) || {};
  const t = geo && geo.type;
  const sx = Math.abs(scale.x), sy = Math.abs(scale.y), sz = Math.abs(scale.z);

  if (t === 'SphereGeometry'){
    const r = (p.radius || 0.1) * Math.max(sx, sy, sz);
    const inv = 1 / (0.4 * r * r);
    return { kind: 'sphere', half: new THREE.Vector3(r, r, r), inv: new THREE.Vector3(inv, inv, inv) };
  }
  if (t === 'CylinderGeometry'){
    const r = Math.max(p.radiusTop || 0, p.radiusBottom || 0) * Math.max(sx, sz);
    const h = (p.height || 0.1) * sy;
    return boxShape(r * 2, h, r * 2);
  }
  return boxShape((p.width || 0.1) * sx, (p.height || 0.1) * sy, (p.depth || 0.1) * sz);
}

/* OBB 沿某世界方向的支撑长度 */
function supportExtent(shape, n){
  if (shape.kind === 'sphere') return shape.half.x;
  _dbAx.set(1, 0, 0).applyQuaternion(shape.quat);
  _dbAy.set(0, 1, 0).applyQuaternion(shape.quat);
  _dbAz.set(0, 0, 1).applyQuaternion(shape.quat);
  return Math.abs(_dbAx.dot(n)) * shape.half.x +
         Math.abs(_dbAy.dot(n)) * shape.half.y +
         Math.abs(_dbAz.dot(n)) * shape.half.z;
}

/* 沿 -n 方向的最深支撑点（接触点） */
function supportPoint(shape, pos, n, out){
  if (shape.kind === 'sphere') return out.copy(pos).addScaledVector(n, -shape.half.x);
  _dbAx.set(1, 0, 0).applyQuaternion(shape.quat);
  _dbAy.set(0, 1, 0).applyQuaternion(shape.quat);
  _dbAz.set(0, 0, 1).applyQuaternion(shape.quat);
  out.copy(pos)
    .addScaledVector(_dbAx, Math.sign(_dbAx.dot(n)) * shape.half.x)
    .addScaledVector(_dbAy, Math.sign(_dbAy.dot(n)) * shape.half.y)
    .addScaledVector(_dbAz, Math.sign(_dbAz.dot(n)) * shape.half.z);
  return out;
}

/* 世界向量过一遍 I⁻¹ = R · diag(inv) · Rᵀ */
function applyInvInertia(shape, v, out){
  _dbQ.copy(shape.quat).invert();
  out.copy(v).applyQuaternion(_dbQ);
  out.set(out.x * shape.inv.x, out.y * shape.inv.y, out.z * shape.inv.z);
  out.applyQuaternion(shape.quat);
  return out;
}

function clampOmega(d){
  const w = d.omega.length();
  if (w > DEBRIS_MAX_OMEGA) d.omega.multiplyScalar(DEBRIS_MAX_OMEGA / w);
}

/* ---------------------------- 单平面碰撞解算 ---------------------------- */
function resolvePlane(d, plane){
  const n = plane.n;
  const dist = n.dot(d.mesh.position) - plane.d;
  const pen = supportExtent(d.shape, n) - dist;
  if (pen <= 0) return false;

  /* 位置修正：沿法线推出穿透 */
  d.mesh.position.addScaledVector(n, pen);

  supportPoint(d.shape, d.mesh.position, n, _dbCP);
  _dbR.copy(_dbCP).sub(d.mesh.position);

  _dbVp.copy(d.vel).add(_dbW.copy(d.omega).cross(_dbR));
  const vn = _dbVp.dot(n);
  if (vn >= 0) return true;              /* 正在分离：只推位置 */

  if (-vn < 0.6){
    /* 静置/轻微接触：只做速度级响应。
       这里若做完整刚体解算，支撑点会随转角跳变导致自激（越转越快、
       永不休眠），所以法向只抵掉接近速度，角项仅出现在摩擦里。 */
    d.vel.addScaledVector(n, -vn);
    _dbVp.copy(d.vel).add(_dbW.copy(d.omega).cross(_dbR));
    _dbTan.copy(_dbVp).addScaledVector(n, -_dbVp.dot(n));
    const ts = _dbTan.length();
    if (ts > 1e-4){
      _dbTan.divideScalar(ts);
      _dbRt.copy(_dbR).cross(_dbTan);
      applyInvInertia(d.shape, _dbRt, _dbT1);
      _dbT2.copy(_dbR).cross(_dbT1);
      const denomT = 1 + _dbTan.dot(_dbT2);
      const jt = Math.max(-DEBRIS_FRICTION * 0.35 * Math.abs(vn), -ts / Math.max(denomT, 1e-6));
      d.vel.addScaledVector(_dbTan, jt);
      applyInvInertia(d.shape, _dbRt, _dbT3);
      d.omega.addScaledVector(_dbT3, jt);
      clampOmega(d);
    }
    return true;
  }

  /* 明显撞击：完整法向 + 库仑摩擦冲量（含角冲量）—— 磕角翻倒的手感来源 */
  const e = DEBRIS_RESTITUTION;
  _dbRn.copy(_dbR).cross(n);
  applyInvInertia(d.shape, _dbRn, _dbT1);
  _dbT2.copy(_dbR).cross(_dbT1);
  const denom = 1 + n.dot(_dbT2);
  const j = -(1 + e) * vn / Math.max(denom, 1e-6);
  d.vel.addScaledVector(n, j);
  applyInvInertia(d.shape, _dbRn, _dbT3);
  d.omega.addScaledVector(_dbT3, j);

  _dbVp.copy(d.vel).add(_dbW.copy(d.omega).cross(_dbR));
  _dbTan.copy(_dbVp).addScaledVector(n, -_dbVp.dot(n));
  const tanSpeed = _dbTan.length();
  if (tanSpeed > 1e-4){
    _dbTan.divideScalar(tanSpeed);
    _dbRt.copy(_dbR).cross(_dbTan);
    applyInvInertia(d.shape, _dbRt, _dbT1);
    _dbT2.copy(_dbR).cross(_dbT1);
    const denomT = 1 + _dbTan.dot(_dbT2);
    const jt = Math.max(-DEBRIS_FRICTION * j, -tanSpeed / Math.max(denomT, 1e-6));
    d.vel.addScaledVector(_dbTan, jt);
    applyInvInertia(d.shape, _dbRt, _dbT3);
    d.omega.addScaledVector(_dbT3, jt);
  }
  clampOmega(d);
  return true;
}

/* ---------------------------- 生成 ---------------------------- */
function spawnBodyDebris(group, opt){
  if (!group) return;
  opt = opt || {};
  const speed = opt.speed || 3.4;
  group.updateMatrixWorld(true);

  const parts = [];
  group.traverse(o => { if (o.isMesh) parts.push(o); });
  if (!parts.length) return;

  _dbFwd.set(0, 0, -1).applyQuaternion(camera.quaternion).normalize();

  /* 直接用 matrixWorld 分解出的位姿写入碎块 —— 比 updateMatrixWorld + decompose
     少一次全场景矩阵刷新，而且父级已经摘干净，不会受到组变换二次影响 */
  const _m = new THREE.Matrix4();

  for (const p of parts){
    _m.copy(p.matrixWorld).decompose(_dbPos, _dbQuat, _dbScl);
    if (_dbScl.x === 0 || _dbScl.y === 0 || _dbScl.z === 0) continue;

    /* 横向偏移：部件相对准星射线的横向分量，决定它往哪边飞 */
    _dbTo.copy(_dbPos).sub(camera.position);
    const along = _dbTo.dot(_dbFwd);
    _dbSide.copy(_dbTo).addScaledVector(_dbFwd, -along);
    if (_dbSide.lengthSq() < 1e-6) _dbSide.set(Math.random() - 0.5, 0, Math.random() - 0.5);
    _dbSide.normalize();

    _dbJit.set((Math.random() - 0.5) * 0.6, Math.random() * 0.55 + 0.3, (Math.random() - 0.5) * 0.6);
    _dbDir.copy(_dbFwd).multiplyScalar(0.5)
      .addScaledVector(_dbSide, 0.95)
      .add(_dbJit)
      .normalize()
      .multiplyScalar(speed * (0.75 + Math.random() * 0.55));
    /* 归一化会压掉竖直分量，补一段独立上抛，抛物线才好看 */
    _dbDir.y += 2.0 + Math.random() * 1.2;

    /* 克隆材质：要做淡出，绝不能动共享缓存里的那份 */
    const m = p.material.clone();
    m.transparent = true;
    m.opacity = 1;

    const mesh = new THREE.Mesh(p.geometry, m);
    mesh.position.copy(_dbPos);
    mesh.quaternion.copy(_dbQuat);
    mesh.scale.copy(_dbScl);
    scene.add(mesh);

    const shape = debrisShape(p.geometry, _dbScl);
    shape.quat = mesh.quaternion;        /* 刚体姿态实时引用同一对象 */

    _dbAxisN.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();

    debrisList.push({
      mesh: mesh, mat: m, shape: shape,
      vel: _dbDir.clone(),
      omega: _dbAxisN.clone().multiplyScalar(3 + Math.random() * 8),
      life: DEBRIS_LIFE * (0.8 + Math.random() * 0.5),
      calm: 0, sleep: false
    });

    /* 从角色身上摘掉该部件：打爆即分离，不再跟随角色动画 */
    if (p.parent) p.parent.remove(p);
  }
}

/* ---------------------------- 每帧物理 ---------------------------- */
function updateDebris(dt){
  for (let i = debrisList.length - 1; i >= 0; i--){
    const d = debrisList[i];
    d.life -= dt;
    if (d.life <= 0){
      scene.remove(d.mesh);
      d.mat.dispose();                   /* 只销毁克隆材质，共享几何不动 */
      debrisList.splice(i, 1);
      continue;
    }

    if (!d.sleep){
      /* 收尾段额外增强阻尼：接触求解里自旋与平移会互相转换，
         单靠常阻尼存在极限环，必须让它必然安定 */
      const settle = (d.life < DEBRIS_LIFE * 0.25) ? 6 : 1;

      d.vel.y -= DEBRIS_GRAVITY * dt;
      d.vel.multiplyScalar(Math.max(0, 1 - DEBRIS_DRAG * settle * dt));
      d.mesh.position.addScaledVector(d.vel, dt);

      const w = d.omega.length();
      if (w > 1e-5){
        _dbAxisN.copy(d.omega).divideScalar(w);
        _dbQ.setFromAxisAngle(_dbAxisN, w * dt);
        d.mesh.quaternion.multiply(_dbQ);
      }
      d.omega.multiplyScalar(Math.max(0, 1 - DEBRIS_ANG_DRAG * settle * dt));
      clampOmega(d);

      let touched = false;
      for (const pl of DEBRIS_PLANES) if (resolvePlane(d, pl)) touched = true;

      /* 接触阻力：纯滚动在库仑模型里无损，不补这项碎块会永远滚下去 */
      if (touched){
        const rr = Math.max(0, 1 - DEBRIS_ROLL_RESIST * settle * dt);
        d.vel.multiplyScalar(rr);
        d.omega.multiplyScalar(rr);
      }

      /* 贴地打转的假象：有着地、自旋很高但平移很小 */
      if (touched && d.omega.lengthSq() > 4 && d.vel.lengthSq() < 1.0){
        d.omega.multiplyScalar(Math.max(0, 1 - 12 * dt));
      }

      if (touched &&
          d.vel.lengthSq() < DEBRIS_SLEEP_V * DEBRIS_SLEEP_V &&
          d.omega.lengthSq() < DEBRIS_SLEEP_W * DEBRIS_SLEEP_W){
        d.calm += dt;
        if (d.calm > DEBRIS_SLEEP_T){
          d.sleep = true;
          d.vel.set(0, 0, 0);
          d.omega.set(0, 0, 0);
        }
      } else {
        d.calm = 0;
      }
    }

    if (d.life < DEBRIS_FADE) d.mat.opacity = Math.max(0, d.life / DEBRIS_FADE);
  }
}
