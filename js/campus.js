'use strict';
/* =========================================================================
   campus —— 校园室外场景（校门口 → 传送圈 → 第三教学楼 → 安检 → 404 教室）
   ---------------------------------------------------------------------
   设计要点：

   1) 校园整体平移到 +Z 500 单位处，与考场房间（原点附近）互不干扰。
      好处是切换区域时【不需要销毁任何几何体】：两块空间各自存在，
      只是移动边界与障碍表换一套。来回走零卡顿，也不会出现
      "重建世界时忘了重建某个子系统的引用"这类难查的错。

   2) 障碍表 obstacles 是全局的（球员与 NPC 共用）。所以每次切区域都
      清空重填 —— 校园的障碍单独存在 campusColliders 里，切到房间就
      不搬过去，反之亦然。

   3) 楼名 / 考场号 / 教室号全部来自 campusdata.js，不在这里写死。
      志愿者说的、墙上写的、传送圈旁边的牌子，必须是同一个数字。
   ========================================================================= */

/* 校园自己的碰撞体清单（切换区域时按需搬进全局 obstacles） */
const campusColliders = [];
function cpAddObstacle(x, z, hw, hd){ campusColliders.push({ x: x, z: z, hw: hw, hd: hd }); }

/* 可被准星射线拾取的校园交互物 */
const portalTargets = [];       /* 传送圈：站在上面按 F */
const campusTalkTargets = [];   /* 志愿者：按 E 搭话 */
const campusAuditTargets = [];  /* 安检口 / 楼门：按 E */
const campusVendingTargets = [];/* 自动售货机：按 E 买东西 */

let portalRing = null, portalGlow = null, portalRing2 = null;
let auditLedA = null, auditLedB = null;
let vendingLed = null;
let campusStudents = [];        /* 校园里走动的其他考生 */

/* ---------------------------- 画一块牌子 ----------------------------
   把若干行文字画成一块贴在墙上的板子。rows 形如
   [{text, color, size}]，自动垂直居中、按最长行水平居中。 */
function cpTextBoard(w, h, rows, bg, border){
  const c = makeCanvas(w, h);
  const ctx = c.ctx;
  ctx.fillStyle = bg || '#0d1420';
  ctx.fillRect(0, 0, w, h);
  if (border){
    ctx.strokeStyle = border;
    ctx.lineWidth = Math.max(4, w * 0.012);
    ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2,
                   w - ctx.lineWidth, h - ctx.lineWidth);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const total = rows.reduce((s, r) => s + r.size * 1.55, 0);
  let y = (h - total) / 2 + rows[0].size * 0.78;
  for (const r of rows){
    ctx.fillStyle = r.color || '#e8eef8';
    ctx.font = 'bold ' + r.size + 'px "Microsoft YaHei", sans-serif';
    ctx.fillText(r.text, w / 2, y);
    y += r.size * 1.55;
  }
  return c.c;
}

/* 一块板子挂到墙上（给出中心点、宽高、朝向） */
function cpBoard(canvas, w, h, x, y, z, ry){
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: canvasTex(canvas, true) }));
  m.position.set(x, y, z);
  m.rotation.y = ry || 0;
  scene.add(m);
  return m;
}

/* ============================ 地面与围墙 ============================ */
function cpBuildGround(){
  /* 草地：一张 canvas 贴图铺满，比纯色更有"校园"的味道 */
  const c = makeCanvas(256, 256);
  const ctx = c.ctx;
  ctx.fillStyle = '#2c3a2a';
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 900; i++){
    const g = 40 + Math.random() * 60;
    ctx.fillStyle = 'rgba(' + (g - 12) + ',' + g + ',' + (g - 20) + ',0.5)';
    ctx.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
  }
  const tex = new THREE.CanvasTexture(c.c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(10, 14);

  const W = CAMPUS_W + 6, D = CAMPUS_MAX_Z - CAMPUS_MIN_Z + 8;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(W, D),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(CP.x, 0, CP.z + (CAMPUS_MIN_Z + CAMPUS_MAX_Z) / 2);
  scene.add(ground);

  /* 中央砖路：从校门直通教学楼。这条线本身就是最直观的指引。 */
  const road = new THREE.Mesh(new THREE.PlaneGeometry(5.4, CAMPUS_MAX_Z - CAMPUS_BUILD_Z + 6),
    mat(0x6b5f52, { roughness: 0.95 }));
  road.rotation.x = -Math.PI / 2;
  road.position.set(CP.x, 0.012, CP.z + (CAMPUS_BUILD_Z + CAMPUS_MAX_Z) / 2 + 2);
  scene.add(road);

  /* 砖缝：横线间隔，让路面有尺度感（人眼靠这个判断走了多远） */
  for (let z = CAMPUS_BUILD_Z + 4; z < CAMPUS_MAX_Z; z += 1.6){
    box(5.4, 0.008, 0.05, 0x554b40, CP.x, 0.02, CP.z + z, scene);
  }

  /* 围墙：三面（左右 + 远端），把校园封起来。
     近端是校门，不封。 */
  const fenceMat = 0x3a4152;
  for (const sx of [-1, 1]){
    for (let z = CAMPUS_BUILD_Z + 2; z < CAMPUS_MAX_Z + 2; z += 4){
      box(0.3, 1.5, 3.6, fenceMat, CP.x + sx * (CAMPUS_HALF_W + 2.4), 0.75, CP.z + z, scene);
    }
    cpAddObstacle(CP.x + sx * (CAMPUS_HALF_W + 2.4), CP.z + (CAMPUS_MIN_Z + CAMPUS_MAX_Z) / 2,
                  0.25, (CAMPUS_MAX_Z - CAMPUS_MIN_Z) / 2 + 4);
  }

  /* 树：贴着围墙种两排，纯装饰但能撑起空间感 */
  const trunkM = mat(0x4a3a2a, { roughness: 0.95 });
  const leafM = mat(0x2f5a33, { roughness: 1 });
  for (let z = CAMPUS_BUILD_Z + 5; z < CAMPUS_MAX_Z; z += 7.5){
    for (const sx of [-1, 1]){
      const tx = CP.x + sx * (CAMPUS_HALF_W - 1.2);
      const tg = new THREE.Group();
      tg.position.set(tx, 0, CP.z + z + (sx > 0 ? 0 : 3.4));
      scene.add(tg);
      const tr = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.22, 2.2, 8), trunkM);
      tr.position.y = 1.1; tg.add(tr);
      const lf = new THREE.Mesh(getSphereGeo(1.25, 10, 8), leafM);
      lf.position.y = 3.1; lf.scale.set(1, 0.85, 1); tg.add(lf);
      addContactShadow(tg, 1.0);
      cpAddObstacle(tg.position.x, tg.position.z, 0.35, 0.35);
    }
  }
}

/* ============================ 校门 ============================ */
function cpBuildGate(){
  const gz = CP.z + CAMPUS_GATE_Z;
  const pillarColor = 0x8a8f9c;

  for (const sx of [-1, 1]){
    const px = CP.x + sx * 5.2;
    box(1.3, 5.2, 1.3, pillarColor, px, 2.6, gz, scene, { roughness: 0.8 });
    box(1.7, 0.35, 1.7, 0x6e7480, px, 5.35, gz, scene);
    cpAddObstacle(px, gz, 0.72, 0.72);
  }

  /* 横梁 + 校名 */
  box(11.6, 0.7, 1.1, 0x6e7480, CP.x, 5.5, gz, scene, { roughness: 0.8 });
  const nameCanvas = cpTextBoard(1024, 160,
    [{ text: SCHOOL_NAME, color: '#f2f6ff', size: 96 }], '#1b2c52', '#4a6bff');
  cpBoard(nameCanvas, 10.4, 1.62, CP.x, 5.5, gz - 0.58, Math.PI);

  /* 门卫室：一个方盒子 + 一块小牌子，说明"这里真的有人管" */
  const booth = new THREE.Group();
  booth.position.set(CP.x - 8.2, 0, gz + 0.6);
  scene.add(booth);
  box(2.6, 2.4, 2.6, 0x9aa2ae, 0, 1.2, 0, booth, { roughness: 0.85 });
  box(2.9, 0.18, 2.9, 0x6e7480, 0, 2.5, 0, booth);
  box(1.6, 0.9, 0.05, 0x2a3a55, 0, 1.6, 1.31, booth);          /* 玻璃 */
  cpAddObstacle(booth.position.x, booth.position.z, 1.35, 1.35);

  /* 校门口传达室旁边的小黑板："今日考场指引" —— 和墙上的大牌子内容一致 */
  const board = cpTextBoard(512, 384, [
    { text: '今日考试', color: '#ffe9a8', size: 40 },
    { text: 'CSP-S 2026', color: '#9fd3ff', size: 34 },
    { text: '考场 ' + EXAM_ROOM_NO + ' · ' + EXAM_CLASSROOM, color: '#ffb3b3', size: 30 },
    { text: EXAM_BUILDING + ' ' + EXAM_BUILDING_TAG, color: '#c8d6ea', size: 26 }
  ], '#12200f', '#5a6b3a');
  cpBoard(board, 2.4, 1.8, CP.x - 8.2, 1.5, gz + 1.95, 0);
}

/* ============================ 传送圈 ============================ */
function cpBuildPortal(){
  const x = CP.x + CAMPUS_PORTAL_X, z = CP.z + CAMPUS_PORTAL_Z;

  /* 地面光圈：两层，外圈慢转、内圈反向，转动方向相反才看得出"它在工作" */
  const ringGeo = new THREE.RingGeometry(1.02, 1.30, 48);
  portalRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
    color: 0x66e6ff, transparent: true, opacity: 0.85,
    side: THREE.DoubleSide, depthWrite: false
  }));
  portalRing.rotation.x = -Math.PI / 2;
  portalRing.position.set(x, 0.03, z);
  scene.add(portalRing);

  portalRing2 = new THREE.Mesh(new THREE.RingGeometry(0.30, 0.42, 32),
    new THREE.MeshBasicMaterial({
      color: 0xaaf4ff, transparent: true, opacity: 0.7,
      side: THREE.DoubleSide, depthWrite: false
    }));
  portalRing2.rotation.x = -Math.PI / 2;
  portalRing2.position.set(x, 0.03, z);
  scene.add(portalRing2);

  /* 中心光柱：一根竖直的加法面片，远处就能看见 */
  portalGlow = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.95, 3.2, 20, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0x59d8ff, transparent: true, opacity: 0.16,
      side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending
    }));
  portalGlow.position.set(x, 1.6, z);
  scene.add(portalGlow);

  /* 旁边立一块小牌子说明它能干什么。没有说明的传送圈没人敢站上去。 */
  const sgn = cpTextBoard(512, 256, [
    { text: '快 速 通 道', color: '#9fd3ff', size: 44 },
    { text: '站上来 · 按 F', color: '#ffe9a8', size: 38 },
    { text: '直达 ' + EXAM_BUILDING, color: '#c8d6ea', size: 26 }
  ], '#0a1a26', '#3fb8e0');
  cpBoard(sgn, 2.0, 1.0, x, 1.9, z - 1.75, 0);

  /* 一块不可见的平面用来承载射线：站在圈上时准星可能朝下也可能朝上，
     所以拾取面做得比人高，站在圈内侧就一定打得到。 */
  const hit = new THREE.Mesh(new THREE.PlaneGeometry(2.9, 2.9),
    new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }));
  hit.rotation.x = -Math.PI / 2;
  hit.position.set(x, 0.05, z);
  scene.add(hit);
  portalTargets.push(hit);
}

function teleportToExamDoor(){
  const p = CAMPUS_DOOR_STAND;
  state.pos.x = CP.x + p.x;
  state.pos.z = CP.z + p.z;
  state.yaw = 0; yawTarget = 0;
  state.pitch = 0; pitchTarget = 0;
  audio.beep(1180, 0.10, 0.06, 'sine');
  setTimeout(() => audio.beep(1560, 0.12, 0.05, 'sine'), 90);
  toast('一阵天旋地转 —— 你站在了 ' + EXAM_BUILDING + ' 门口。', 2400);
  if (!state.portalUsed){
    state.portalUsed = true;
    unlockAch('portal');
  }
}

/* ============================ 教学楼 ============================ */
function cpBuildBuilding(){
  const bz = CP.z + CAMPUS_BUILD_Z;

  /* 主楼体：一个深进深的盒子当作整栋楼，比真建楼层便宜得多，
     反正玩家的活动范围只到门口 */
  box(CAMPUS_W - 4, 16, 21, 0x3f4757, CP.x, 8, bz - 10.5, scene, { roughness: 0.9 });
  cpAddObstacle(CP.x, bz - 10.5, (CAMPUS_W - 4) / 2, 10.5);

  /* 一层贴面：颜色略亮，做出"入口那一段"的层次 */
  box(CAMPUS_W - 3, 4.2, 0.4, 0x4a5468, CP.x, 2.1, bz + 0.1, scene);
  /* 檐口 */
  box(CAMPUS_W - 3, 0.4, 1.2, 0x2e3646, CP.x, 4.4, bz - 0.3, scene);

  /* 门厅：凸出来一小块 + 雨棚，让入口看起来是个"入口" */
  box(7.0, 3.6, 1.5, 0x55617a, CP.x, 1.8, bz + 0.75, scene);
  const canopy = box(9.0, 0.28, 3.2, 0x2e3646, CP.x, 3.85, bz + 1.4, scene);
  canopy.rotation.x = 0.03;

  /* 自动门：两扇玻璃 + 中缝 */
  for (const sx of [-1, 1]){
    box(1.55, 2.5, 0.10, 0x8fc4e8, CP.x + sx * 0.82, 1.25, bz + 1.52, scene,
      { roughness: 0.15, metalness: 0.3, transparent: true, opacity: 0.72 });
  }
  box(0.10, 2.6, 0.14, 0x9aa2ae, CP.x, 1.3, bz + 1.52, scene);

  /* ---- 楼门上方的大字 ---- */
  const bigSign = cpTextBoard(2048, 512, [
    { text: EXAM_BUILDING + ' ' + EXAM_BUILDING_TAG, color: '#e8f0ff', size: 150 },
    { text: '考 场 ' + EXAM_ROOM_NO + '　·　教 室 ' + EXAM_CLASSROOM, color: '#ffd479', size: 96 }
  ], '#12233f', '#4a6bff');
  cpBoard(bigSign, 13.0, 3.25, CP.x, 6.6, bz + 0.36, Math.PI);

  /* ---- 墙面指引牌（要过安检这件事写在这里） ---- */
  const guide = cpTextBoard(1024, 768, CAMPUS_SIGN_ROWS, '#0b1a2e', '#3fb8e0');
  cpBoard(guide, 5.0, 3.75, CP.x + 9.6, 2.9, bz + 0.36, Math.PI);

  /* ---- 门牌：404 / 考场 39 ---- */
  const plate = cpTextBoard(512, 384, CAMPUS_DOOR_PLATE, '#f2f6ff', '#8aa0c0');
  cpBoard(plate, 1.5, 1.13, CP.x + 2.6, 2.15, bz + 1.54, Math.PI);

  /* ---- 另一侧补一块"请勿携带电子设备" ---- */
  const warn = cpTextBoard(512, 640, [
    { text: '进 楼 须 知', color: '#ffd479', size: 46 },
    { text: '禁止携带手机', color: '#ffb3b3', size: 34 },
    { text: '禁止携带智能手表', color: '#ffb3b3', size: 34 },
    { text: '经安检通道进入', color: '#9fd3ff', size: 34 }
  ], '#2a1010', '#c0392b');
  cpBoard(warn, 2.4, 3.0, CP.x - 9.6, 2.9, bz + 0.36, Math.PI);

  /* 楼层号与走廊灯：让立面不是一块死板 */
  for (let f = 1; f <= 4; f++){
    const y = 4.2 + (f - 1) * 3.1;
    box(CAMPUS_W - 6, 0.5, 0.3, 0x323a4a, CP.x, y, bz + 0.28, scene);
    const wc = makeCanvas(96, 96);
    wc.ctx.fillStyle = '#16233a'; wc.ctx.fillRect(0, 0, 96, 96);
    wc.ctx.fillStyle = '#8fb8ff'; wc.ctx.font = 'bold 58px "Microsoft YaHei"';
    wc.ctx.textAlign = 'center'; wc.ctx.textBaseline = 'middle';
    wc.ctx.fillText(String(f) + 'F', 48, 52);
    cpBoard(wc.c, 0.62, 0.62, CP.x - 6.4, y, bz + 0.44, Math.PI);
  }

  /* "过完安检"这条事实要能被看见：门上贴一张签到表 */
  const rollCanvas = cpTextBoard(768, 512, [
    { text: '签 到 表', color: '#e8f0ff', size: 46 },
    { text: '应到 48 人', color: '#9fd3ff', size: 32 },
    { text: '已到 47 人', color: '#9fd3ff', size: 32 },
    { text: '未到：1 人', color: '#ffb3b3', size: 32 },
    { text: '（就是你）', color: '#ff8080', size: 28 }
  ], '#0f1c2e', '#4a6bff');
  cpBoard(rollCanvas, 2.0, 1.33, CP.x + 5.2, 2.3, bz + 1.54, Math.PI);
}

/* ============================ 员工通道（侧门） ============================
   主楼东墙外面有一条 2m 宽的夹道：楼体半宽 11，校园可走范围到 13，
   所以沿楼东山墙一直走到底就能绕到楼侧面去。侧门就开在那面墙上。
   注意这不是为了作弊临时凿的后门 —— 夹道本来就在，只是以前走到头是死路。
   门开着，安检门在正门那边：这就是"不正规入场"那条路。 */
function cpBuildSideDoor(){
  const bz = CP.z + CAMPUS_BUILD_Z;
  const wx = CP.x + (CAMPUS_W - 4) / 2;      /* 东墙 x = CP.x + 11 */
  const dz = bz - 3;

  /* 门框 → 门板 → 把手 → 台阶。门板本身当交互面，不用再造一个隐形网格 */
  box(0.10, 2.50, 1.70, 0x39424f, wx + 0.02, 1.25, dz, scene);
  const door = box(0.14, 2.30, 1.50, 0x6a5636, wx + 0.07, 1.15, dz, scene,
                   { roughness: 0.85 });
  box(0.12, 0.09, 0.30, 0xc9cfd8, wx + 0.16, 1.06, dz - 0.52, scene,
      { metalness: 0.6, roughness: 0.35 });
  box(1.00, 0.12, 2.00, 0x55607a, wx + 0.45, 0.06, dz, scene);
  /* 门头小灯：夹道里唯一的暖色，用来把视线吸过来 */
  box(0.26, 0.10, 0.34, 0xffd48a, wx + 0.18, 2.62, dz, scene);

  const sign = cpTextBoard(512, 192, [
    { text: '员工通道', color: '#ffe9a8', size: 48 },
    { text: '考试期间封闭', color: '#ffb3b3', size: 28 }
  ], '#1a1a12', '#6a5636');
  cpBoard(sign, 1.6, 0.6, wx + 0.12, 3.05, dz, Math.PI / 2);

  campusAuditTargets.push({ obj: door, kind: 'sidedoor', label: '员工通道' });
}

/* ============================ 安检通道 ============================ */
function cpBuildAudit(){
  const az = CP.z + CAMPUS_AUDIT_Z;
  const metal = 0xb8c0cc;

  /* 门框式安检门：两根立柱 + 顶梁 */
  for (const sx of [-1, 1]){
    box(0.34, 2.5, 0.34, metal, CP.x + sx * 1.5, 1.25, az, scene,
      { roughness: 0.35, metalness: 0.6 });
    cpAddObstacle(CP.x + sx * 1.5, az, 0.19, 0.19);
  }
  box(3.4, 0.30, 0.34, metal, CP.x, 2.62, az, scene,
    { roughness: 0.35, metalness: 0.6 });

  /* 两侧安检机：方箱 + 滚轴（做出"传送带"的样子） */
  for (const sx of [-1, 1]){
    const bx = CP.x + sx * 3.4;
    box(2.4, 1.15, 1.5, 0x5a6270, bx, 0.58, az, scene, { roughness: 0.7 });
    box(2.0, 0.10, 1.1, 0x2a3040, bx, 1.18, az, scene);
    cpAddObstacle(bx, az, 1.2, 0.75);
  }

  /* 指示灯：两根立柱上各一盏，过一会绿一下（见 updateCampusArea） */
  auditLedA = new THREE.Mesh(getSphereGeo(0.10, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0x33ff88 }));
  auditLedA.position.set(CP.x - 1.5, 2.42, az + 0.2);
  scene.add(auditLedA);
  auditLedB = auditLedA.clone();
  auditLedB.position.x = CP.x + 1.5;
  scene.add(auditLedB);

  /* 顶梁挂一块告示：安检须知 + 已签到人数 */
  const notice = cpTextBoard(768, 512, CAMPUS_AUDIT_NOTICE, '#f2f6ff', '#c0392b');
  cpBoard(notice, 1.7, 1.13, CP.x, 2.0, az + 0.20, Math.PI);

  /* 排队隔离带：两段矮桩 + 横带，暗示"这里曾经排过队" */
  for (const sx of [-1, 1]){
    for (const dz of [-1.0, 0.6]){
      box(0.09, 0.85, 0.09, 0xc9b037, CP.x + sx * 2.4, 0.43, az + dz, scene,
        { metalness: 0.7, roughness: 0.3 });
    }
    box(0.05, 0.05, 1.6, 0xb03030, CP.x + sx * 2.4, 0.80, az - 0.2, scene);
  }

  /* 地面：安检通道的黄黑警戒条 */
  for (let i = -3; i <= 3; i++){
    box(1.6, 0.01, 0.34, i % 2 ? 0xd8b400 : 0x2a2a2a, CP.x + i * 1.7, 0.014, az + 1.5, scene);
  }

  /* 出口指示：过完安检往哪走 */
  const arrow = cpTextBoard(256, 128, [
    { text: '↑ 进 楼', color: '#33ff88', size: 46 }
  ], '#0a1a10', '#33ff88');
  cpBoard(arrow, 0.9, 0.45, CP.x, 3.05, az - 0.04, 0);

  /* 可交互：站在安检门前按 E 过安检（门框本身就是拾取面） */
  const hit = new THREE.Mesh(new THREE.BoxGeometry(2.7, 2.2, 2.0),
    new THREE.MeshBasicMaterial({ visible: false }));
  hit.position.set(CP.x, 1.1, az);
  scene.add(hit);
  campusAuditTargets.push({ obj: hit, kind: 'audit', label: '安检门' });

  /* 楼门也算安检点的一部分：没刷卡的人不该直接走进去 */
  const doorHit = new THREE.Mesh(new THREE.BoxGeometry(3.2, 2.6, 2.4),
    new THREE.MeshBasicMaterial({ visible: false }));
  doorHit.position.set(CP.x, 1.3, CP.z + CAMPUS_BUILD_Z + 1.2);
  scene.add(doorHit);
  campusAuditTargets.push({ obj: doorHit, kind: 'door', label: '楼门' });
}

/* ============================ 自动售货机 ============================
   校门内侧左手边的一台老机器：机身 + 玻璃橱窗 + 刷卡区 + 出货口。
   商品与价格来自 campusdata.js 的 VENDING_GOODS，这里只负责画。 */
function cpBuildVending(){
  const x = CP.x + VENDING_POS.x;
  const z = CP.z + VENDING_POS.z;
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  scene.add(g);
  addContactShadow(g, 0.8);

  /* 底座 + 机身 + 顶盖 */
  box(1.5, 0.08, 1.2, 0x2a3240, 0, 0.04, 0, g);
  box(1.1, 1.95, 0.8, 0x24567f, 0, 1.02, 0, g,
      { roughness: 0.42, metalness: 0.35 });
  box(1.18, 0.10, 0.88, 0x173a5a, 0, 2.02, 0, g, { roughness: 0.5 });
  box(1.18, 0.08, 0.88, 0x173a5a, 0, 0.12, 0, g, { roughness: 0.5 });

  /* 玻璃橱窗：一行一件商品，颜色/名字/价格都跟 ITEMS 与 VENDING_GOODS 走，
     不另写一份，免得改了价格牌面还对不上。 */
  const cv = makeCanvas(512, 640);
  const ctx = cv.ctx;
  ctx.fillStyle = '#08111c';
  ctx.fillRect(0, 0, 512, 640);
  const rowH = 640 / VENDING_GOODS.length;
  VENDING_GOODS.forEach((good, i) => {
    const it = ITEMS[good.id];
    const y = i * rowH;
    ctx.fillStyle = '#0d1c2b';
    ctx.fillRect(10, y + 10, 492, rowH - 20);
    /* 瓶身 */
    ctx.fillStyle = it.color;
    ctx.fillRect(40, y + rowH * 0.30, 58, rowH * 0.44);
    ctx.fillStyle = '#dfe9f6';
    ctx.fillRect(54, y + rowH * 0.20, 30, rowH * 0.10);
    /* 名称与价格 */
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#e8f1ff';
    ctx.font = 'bold 38px "Microsoft YaHei", sans-serif';
    ctx.fillText(it.name, 130, y + rowH * 0.38);
    ctx.fillStyle = '#ffe066';
    ctx.font = 'bold 34px "Microsoft YaHei", sans-serif';
    ctx.fillText('¥' + good.price, 130, y + rowH * 0.66);
    /* 货架隔板 */
    ctx.fillStyle = '#2a4a64';
    ctx.fillRect(10, y + rowH - 10, 492, 4);
  });

  const glass = new THREE.Mesh(new THREE.PlaneGeometry(0.86, 1.30),
    new THREE.MeshBasicMaterial({ map: canvasTex(cv.c, true) }));
  glass.position.set(0, 1.28, 0.415);
  g.add(glass);

  /* 刷卡区 + 绿灯 */
  box(0.20, 0.30, 0.05, 0x1a2233, -0.40, 1.30, 0.42, g);
  box(0.12, 0.03, 0.02, 0x39ff88, -0.40, 1.30, 0.45, g,
      { emissive: 0x39ff88, emissiveIntensity: 0.9 });

  /* 出货口：一个黑洞 + 一条挡板 */
  box(0.62, 0.16, 0.06, 0x05090f, 0, 0.48, 0.42, g);
  box(0.62, 0.03, 0.07, 0x9fb4cc, 0, 0.57, 0.43, g, { metalness: 0.5 });

  /* 顶部灯条：唯一会动的部分，见 updateCampusArea */
  vendingLed = box(0.94, 0.04, 0.05, 0x7fe3ff, 0, 2.09, 0.43, g);
  vendingLed.material = new THREE.MeshBasicMaterial({ color: 0x7fe3ff });

  /* 灯箱招牌：两根短支架把它架在机身上，避免看起来是悬空的 */
  box(0.05, 0.20, 0.05, 0x173a5a, -0.45, 2.12, 0.38, g);
  box(0.05, 0.20, 0.05, 0x173a5a, 0.45, 2.12, 0.38, g);
  const sign = cpTextBoard(1024, 192, [
    { text: '自 动 售 货 机', color: '#eaf6ff', size: 62 },
    { text: '饭卡支付 · 校园价', color: '#ffd66b', size: 28 }
  ], '#0b1a2b', '#4a9eff');
  cpBoard(sign, 1.28, 0.34, x, 2.36, z + 0.42, 0);

  /* 碰撞体：机器要挡住人；拾取盒只覆盖机身正面，不伸到路中间 */
  cpAddObstacle(x, z, 0.62, 0.48);
  const hit = new THREE.Mesh(new THREE.BoxGeometry(1.35, 2.3, 1.5),
    new THREE.MeshBasicMaterial({ visible: false }));
  hit.position.set(x, 1.15, z + 0.15);
  scene.add(hit);
  campusVendingTargets.push({ obj: hit });
}

/* ============================ 人物 ============================ */
function cpBuildVolunteers(){
  for (const v of VOLUNTEERS){
    const p = buildPerson(CP.x + v.x, CP.z + v.z, v.color, v.rotY, 'stand');
    p.userData.volunteer = v;
    p.userData.isVolunteer = true;
    /* 志愿者戴个红袖标，远处一眼能认出来 */
    box(0.13, 0.13, 0.13, 0xffe066, -0.29, 1.22, 0.14, p.group);

    /* 交互拾取盒 */
    const hit = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.9, 0.9),
      new THREE.MeshBasicMaterial({ visible: false }));
    hit.position.set(CP.x + v.x, 0.95, CP.z + v.z);
    scene.add(hit);
    campusTalkTargets.push({ obj: hit, npc: p, data: v });
    cpAddObstacle(CP.x + v.x, CP.z + v.z, 0.36, 0.36);
  }
}

/* 路过的考生：沿砖路朝教学楼走，走到门口循环回校门。
   作用是在你犹豫"往哪走"的时候，前面有个人可以跟着。 */
function cpBuildStudents(){
  const colors = [0x3b5ba5, 0x8a4a6b, 0x4a7a5a, 0x7a6a3a, 0x5a4a8a, 0x8a6a4a];
  for (let i = 0; i < 6; i++){
    const z0 = CAMPUS_MIN_Z + 4 + Math.random() * (CAMPUS_MAX_Z - CAMPUS_MIN_Z - 8);
    const x0 = (Math.random() * 2 - 1) * 2.0;
    const p = buildPerson(CP.x + x0, CP.z + z0, colors[i % colors.length], Math.PI, 'stand');
    p.userData = { speed: 1.0 + Math.random() * 0.7, phase: Math.random() * TAU };
    campusStudents.push(p);
  }
}

function cpUpdateStudents(worldDt, t){
  for (const s of campusStudents){
    /* 朝 -Z 走（教学楼方向）；到门口折返到校门口重新走一遍 */
    s.group.position.z -= s.userData.speed * worldDt;
    s.group.position.x += Math.sin(t * 1.4 + s.userData.phase) * 0.01;
    if (s.group.position.z < CP.z + CAMPUS_BUILD_Z + 2.5){
      s.group.position.z = CP.z + CAMPUS_GATE_Z - 2;
      s.group.position.x = CP.x + (Math.random() * 2 - 1) * 2.0;
    }
    s.group.rotation.y = Math.PI;
    /* 走路时腿部动作：用整体轻微上下起伏代替骨骼动画 */
    s.group.position.y = Math.abs(Math.sin(t * 5 + s.userData.phase)) * 0.05;
  }
}

/* ============================ 装配 ============================ */
function buildCampusArea(){
  cpBuildGround();
  cpBuildGate();
  cpBuildPortal();
  cpBuildBuilding();
  cpBuildSideDoor();
  cpBuildAudit();
  cpBuildVending();
  cpBuildVolunteers();
  cpBuildStudents();

  /* 校园的静态障碍一次性算好，之后切区域直接搬过去，不重复计算 */
  for (const o of campusColliders) obstacles.push(o);
}

/* ---------------------------- 灯光 ---------------------------- */
function initCampusLights(){
  /* 室外光：一盏方向光当天光 + 补一盏半球光，不要太强，
     因为紧张值系统会调环境光的强度，太亮就调不出"压抑" */
  const sun = new THREE.DirectionalLight(0xffeedd, 0.55);
  sun.position.set(30, 40, 60);
  scene.add(sun);
  const sky = new THREE.HemisphereLight(0x9fc6ff, 0x2e3a2a, 0.65);
  scene.add(sky);
  /* 路边的灯柱：只在校园区域可见，所以位置就放在校园坐标里，不用切换开关 */
  for (let z = CAMPUS_BUILD_Z + 6; z < CAMPUS_MAX_Z; z += 9){
    for (const sx of [-1, 1]){
      const lx = CP.x + sx * 4.2;
      box(0.12, 4.2, 0.12, 0x3a4152, lx, 2.1, CP.z + z, scene);
      const lamp = box(0.7, 0.14, 0.3, 0xfff0c8, lx + sx * 0.3, 4.2, CP.z + z, scene);
      lamp.material = new THREE.MeshBasicMaterial({ color: 0xfff0c8 });
      cpAddObstacle(lx, CP.z + z, 0.16, 0.16);
    }
  }
}

/* ---------------------------- 跑路了兄弟 ---------------------------- */
/* 离校园最外墙这么近，就算"你想溜"。 */
const RUNAWAY_INSET = 0.8;

/* 判定：贴到可走范围的最外沿 → 解锁成就 + 被拎回校门口。
   ------------------------------------------------------------------
   为什么判"最外墙"而不是"校门线"：出生点本地 z=11.5 本来就在校门(8)之外。
   最初写的是"从门内穿过门线"的穿越事件（理由是怕开局白送成就），
   结果玩家开局掉头往外跑，从 11.5 一路跑到 15.2，永远穿不过 9.5 ——
   成就根本不触发。判定必须覆盖"玩家真实会走的那条路"。
   现在任何人往校外方向跑到头都会触发，语义也更准：不是"走出校门"，
   是"走到头了还想跑"。
   ------------------------------------------------------------------ */
function cpWatchRunaway(){
  /* 边界从 AREA_BOUNDS 取，不在这里另抄一份数字 —— 抄一份就会漂。 */
  const wallZ = AREA_BOUNDS.campus.zMax - CP.z;      /* 本地 z 的最外沿 */
  const lz = state.pos.z - CP.z;
  if (lz < wallZ - RUNAWAY_INSET) return;

  unlockAch('runaway');

  /* 拎回门口 —— 这就是成就描述里"出发之后记得回来"的字面实现：
     你不是自己回来的，是被拽回来的。 */
  const p = CAMPUS_GATE_STAND;
  state.pos.x = CP.x + p.x;
  state.pos.z = CP.z + p.z;
  state.yaw = p.yaw; yawTarget = p.yaw;
  state.pitch = 0; pitchTarget = 0;
  audio.beep(300, 0.12, 0.07, 'square');
  setTimeout(() => audio.beep(220, 0.16, 0.06, 'square'), 110);
  toast('门口的志愿者一把把你拽了回来：「跑什么跑，考试还没开始呢。」', 2600);
}

/* ---------------------------- 每帧刷新（呼吸感） ---------------------------- */
function updateCampusArea(worldDt, t){
  if (state.area !== 'campus') return;

  cpWatchRunaway();

  /* 快到点了吼一声：广播一响，玩家就知道刚才在小恐龙里坐太久了。
     只报一次 —— 每帧都报就变成噪音。迟到仍然能进，只是会扣时间。 */
  if (!state.entryWarned && !state.enteredRoom && !state.examStarted &&
      !state.missedEntry && entryLeft() <= EXAM_RUSH_MARGIN && entryLeft() > 0){
    state.entryWarned = true;
    audio.beep(660, 0.14, 0.05);
    setTimeout(() => audio.beep(520, 0.18, 0.05), 160);
    toast('广播：入场预留时间还剩 ' + Math.round(EXAM_RUSH_MARGIN / 60) +
          ' 分钟。迟到仍可进考场，但考试时间会按迟到时长扣除。', 3600);
  }

  /* 传送圈：双层反向旋转 + 中心脉动。转速刻意不用 worldDt，
     这样顿帧和慢放时它依然在转 —— 它是"机器"，不该跟着人变慢。 */
  if (portalRing){
    portalRing.rotation.z = t * 0.6;
    portalRing2.rotation.z = -t * 1.1;
    const pulse = 0.72 + 0.28 * Math.sin(t * 2.4);
    portalRing.material.opacity = pulse;
    portalRing2.material.opacity = pulse * 0.85;
    portalGlow.material.opacity = 0.10 + 0.10 * pulse;
    portalGlow.rotation.y = t * 0.4;
  }

  /* 安检指示灯：绿灯慢闪，表示"通道正常" */
  if (auditLedA){
    const on = (t % 1.6) < 1.0;
    const col = on ? 0x33ff88 : 0x1a5c38;
    auditLedA.material.color.setHex(col);
    auditLedB.material.color.setHex(on ? 0xffc233 : 0x5c4a1a);
  }

  /* 售货机灯条：慢慢呼吸，给这台静止的机器一点存在感 */
  if (vendingLed){
    const on = (t % 2.4) < 1.6;
    vendingLed.material.color.setHex(on ? 0x7fe3ff : 0x1c4a5c);
  }

  cpUpdateStudents(worldDt, t);
}

/* ============================ 区域切换 ============================ */
/* 切换区域 = 换一套移动边界 + 换一套障碍表。
   几何体全部保留在原地不动 —— 这是本文件最关键的一个决定：
   不做销毁重建，就没有"重建时漏掉某个子系统"的风险。 */
function switchArea(area){
  if (state.area === area) return;
  const prev = state.area;
  state.area = area;
  state.bounds = AREA_BOUNDS[area];

  obstacles.length = 0;
  if (area === 'campus'){
    for (const o of campusColliders) obstacles.push(o);
  } else if (area === 'room'){
    registerRoomObstacles();
    ensurePickups();
    /* 只有从校园第一次进楼才落座；从走廊走回来不重置位置（连续行走） */
    if (prev === 'campus'){
      state.pos.x = SEAT_CENTER_X;
      state.pos.z = SEAT_CENTER_Z + 0.92;
      state.yaw = 0; yawTarget = 0;
      state.pitch = 0; pitchTarget = 0;
    }
  } else {
    /* 楼内走廊：hall1（1F）/ hall2（2F）。障碍由 building.js 整体重放 */
    registerHallObstacles(area === 'hall2' ? 2 : 1);
  }
  forceRedraw = true;
}

/* ---------------------------- 交互 ----------------------------
   返回 true 表示"校园里已经有交互目标了，别再去判房间里的东西"。 */
function campusInteract(){
  if (state.area !== 'campus') return false;

  raycaster.setFromCamera(CENTER, camera);
  raycaster.far = 3.6;

  /* 1. 安检口 / 楼门（打断性最强，优先级最高） */
  const auditHits = raycaster.intersectObjects(campusAuditTargets.map(a => a.obj), false);
  if (auditHits.length){
    const rec = campusAuditTargets.find(a => a.obj === auditHits[0].object);
    if (rec){
      if (rec.kind === 'sidedoor'){
        /* 侧门永远走"没安检"这条路 —— 它就是这条路的入口 */
        actionE = { fn: enterSideDoor };
        setPrompt('[ E ] 推开员工通道' + entryHint());
      } else if (state.passedSecurity){
        actionE = { fn: enter404Classroom };
        setPrompt('[ E ] 进入 ' + EXAM_CLASSROOM + ' 教室' + entryHint());
      } else {
        actionE = { fn: doSecurityCheck };
        /* 用 label 而不是 kind：kind 是内部标识（audit/door），
           直接拼进提示就会变成"过安检（audit）"这种把英文内部词漏给玩家的样子 */
        setPrompt('[ E ] 过安检（' + (rec.label || '通道') + '）' + entryHint());
      }
      promptEl.classList.remove('hidden');
      return true;
    }
  }

  /* 2. 自动售货机 */
  const vendHits = raycaster.intersectObjects(campusVendingTargets.map(a => a.obj), false);
  if (vendHits.length){
    actionE = { fn: openVendingMachine };
    setPrompt('[ E ] 自动售货机　余额 ¥' + state.cardBalance);
    promptEl.classList.remove('hidden');
    return true;
  }

  /* 3. 志愿者 */
  const talkHits = raycaster.intersectObjects(campusTalkTargets.map(a => a.obj), false);
  if (talkHits.length){
    const rec = campusTalkTargets.find(a => a.obj === talkHits[0].object);
    if (rec){
      actionE = { fn: () => talkToVolunteer(rec) };
      setPrompt('[ E ] 和' + rec.data.name + '说话');
      promptEl.classList.remove('hidden');
      return true;
    }
  }

  /* 3. 传送圈：站在圈上就行，不要求准星对准它 ——
       站在圆心的东西不该逼玩家低头找。 */
  const dx = state.pos.x - (CP.x + CAMPUS_PORTAL_X);
  const dz = state.pos.z - (CP.z + CAMPUS_PORTAL_Z);
  if (Math.hypot(dx, dz) < 1.35){
    actionF = { fn: teleportToExamDoor };
    setPrompt('[ F ] 站上光圈 · 瞬移到' + EXAM_BUILDING + '门口');
    promptEl.classList.remove('hidden');
    return true;
  }

  /* 4. 没目标时给个方向感：告诉玩家往哪走 */
  const dToBuild = Math.hypot(state.pos.x - CP.x, state.pos.z - (CP.z + CAMPUS_BUILD_Z));
  if (dToBuild > 6 && !state.passedSecurity){
    setPrompt('沿着砖路往' + EXAM_BUILDING + '走　（' + Math.round(dToBuild) + ' m）' + entryHint());
  } else if (!state.enteredRoom){
    setPrompt('往考场走' + entryHint());
  }
  return true;   /* 校园里永远不落到房间的那套判定 */
}

/* ---------------------------- 自动售货机：购买 ----------------------------
   弹窗不关，买完原地刷新余额与库存 —— 让玩家能连着买两瓶，
   而不是每次都要重新按 E。买不起 / 售罄只换正文，不改状态。 */
function vendingText(note){
  const lines = ['饭卡余额：¥' + state.cardBalance, ''];
  for (const good of VENDING_GOODS){
    const stock = state.vendingStock[good.id] | 0;
    lines.push(ITEMS[good.id].name + '　¥' + good.price + '　' +
      (stock > 0 ? '剩 ' + stock + ' 件' : '售罄'));
  }
  lines.push('', '开局包里已有 3 瓶臭水、2 瓶矿泉水、2 根辣条。');
  return (note ? note + '\n\n' : '') + lines.join('\n');
}

function vendingOptions(){
  const opts = VENDING_GOODS.map(good => {
    const stock = state.vendingStock[good.id] | 0;
    return {
      label: ITEMS[good.id].name + '　¥' + good.price +
        '（' + (stock > 0 ? '剩 ' + stock : '售罄') + '）',
      cb: dlg => buyFromVending(dlg, good.id)
    };
  });
  opts.push({ label: '离开', cb: dlg => closeDialog(dlg) });
  return opts;
}

function openVendingMachine(){
  if (state.area !== 'campus') return;
  audio.beep(660, 0.06, 0.04);
  openDialog({
    title: '自 动 售 货 机',
    text: vendingText('投币口坏了，只能刷饭卡。'),
    options: vendingOptions()
  });
}

function buyFromVending(dlg, id){
  const good = VENDING_GOODS.find(x => x.id === id);
  if (!good) return;
  const stock = state.vendingStock[id] | 0;

  if (stock <= 0){
    audio.beep(180, 0.12, 0.05, 'square');
    setDialogContent(dlg, {
      text: vendingText('「' + ITEMS[id].name + '」已经卖完了。'),
      options: vendingOptions()
    });
    return;
  }
  if (state.cardBalance < good.price){
    audio.beep(180, 0.12, 0.05, 'square');
    setDialogContent(dlg, {
      text: vendingText('余额不够 —— 还差 ¥' + (good.price - state.cardBalance) + '。'),
      options: vendingOptions()
    });
    return;
  }
  if (bagAdd(id, 1) <= 0){
    setDialogContent(dlg, {
      text: vendingText('背包里这一格已经堆满了。'),
      options: vendingOptions()
    });
    return;
  }

  state.cardBalance -= good.price;
  state.vendingStock[id] = stock - 1;
  scheduleAutoSave();
  audio.beep(880, 0.08, 0.05, 'sine');
  setTimeout(() => audio.beep(1174, 0.06, 0.04, 'sine'), 70);
  setDialogContent(dlg, {
    text: vendingText('咔哒。「' + ITEMS[id].name + '」掉进了出货口。'),
    options: vendingOptions()
  });
}

/* 入场倒计时：写进提示里。不写的话"30 分钟入场预留"这条规矩玩家永远不知道，
   第一次撞上就是"我走慢了点，怎么时间没了"。
   进楼前显示入场预留/迟到；进楼后显示考试剩余。 */
function entryHint(){
  if (state.enteredRoom) return '';
  if (state.examStarted){
    return '　·　考试已开始 · 剩 ' +
           Math.ceil((CONTEST_LEN - state.elapsed) / 60) + ' 分';
  }
  const left = entryLeft();
  if (left > 0){
    return '　·　入场预留 ' + Math.ceil(left / 60) + ' 分';
  }
  const late = entryLateSec();
  const remain = entryProjectedRemain();
  if (remain <= 0) return '　·　考试已结束';
  return '　·　迟到 ' + Math.ceil(late / 60) + ' 分 · 入场后剩 ' +
         Math.ceil(remain / 60) + ' 分';
}

/* ---------------------------- 安检流程 ----------------------------
   这里踩过的坑值得写下来：最初只有两个选项，且**两个都算过了安检、都收手机**，
   其中一个还叫「在原地愣一下」—— 玩家点它只是想"我还没决定"，结果手机没了、
   安检标记还变成"已通过"。之后他从员工通道进来时会发现兜里没手机，
   而屏幕上没有任何地方告诉他手机是哪一步丢的。
   现在：进门只有一个选项会收手机，另一个是明着写的"不过了"。
   弹窗必须有一条**什么都不改变**的退路。 */
function doSecurityCheck(){
  if (state.passedSecurity) return;
  dismissDialogs();
  openDialog({
    title: '安 检 通 道',
    text: '保安接过你的准考证扫了一下，抬头看了看你。\n' +
          '「' + EXAM_BUILDING_TAG + '，' + EXAM_CLASSROOM + '，考场 ' + EXAM_ROOM_NO + '。\n' +
          '　行了，进去吧 —— 你是最后一个。」\n' +
          '他指了指旁边的塑料筐：「手机放里面。」',
    options: [
      /* 每个选项都必须自己 closeDialog。
         漏掉它的后果不是"弹窗多留一会儿"，而是**整个输入系统停摆**：
         hasDialog() 一直为真 → 点击被吞（鼠标看起来失灵）、E/数字键只是
         反复触发同一个选项、campusInteract 再也不执行 → 碰不到门。
         项目里其它弹窗（teacher / npc / combat / guards）都写了这一句，
         只有校园这三处漏了。 */
      { label: '把手机放进筐里，走进教学楼', cb: dlg => {
          closeDialog(dlg);
          state.passedSecurity = true;
          confiscatePhone();                   /* 手机从背包里真的拿走 */
          audio.beep(880, 0.08, 0.05);
          setTimeout(() => audio.beep(1180, 0.10, 0.05), 110);
          toast('安检通过 · 手机已封存', 2200);
          unlockAch('security');
          /* 走进教学楼：瞬移到电梯间，剩下的路自己走（进 404 才真正开考） */
          if (passEntryGate()) teleportToElevatorLobby();
        } },
      /* 退路：什么都不改。安检标记、手机、成就全都不动 ——
         这样"没过安检就没手机"这种说不清的事不可能再发生。 */
      { label: '先不过了', cb: dlg => {
          closeDialog(dlg);
          toast('保安耸耸肩：「那你快点，一会儿关了门就进不去了。」', 2400);
        } }
    ]
  });
}

/* ---------------------------- 入场预留 ---------------------------- */
/* 入场阶段已经过了多久；负值表示还在预留时间内。 */
function entryLeft(){ return EXAM_ENTRY_LIMIT - state.admitElapsed; }
function entryLateSec(){ return Math.max(0, state.admitElapsed - EXAM_ENTRY_LIMIT); }
/* 如果现在进场，还能拿到多少考试时间（早到就是整整 4 小时）。 */
function entryProjectedRemain(){ return Math.max(0, CONTEST_LEN - entryLateSec()); }

/* 入场预留 + 4 小时都过完了：考试真的结束了，按缺考收场 ——
   不能只弹一句 toast 就让人站在门口不知道该怎么办。 */
function lateShutout(){
  if (state.missedEntry || state.enteredRoom) return;
  state.missedEntry = true;
  dismissDialogs();
  openDialog({
    title: '考 试 已 结 束',
    text: '楼门口拉上了警戒线，保安把手一摊：\n' +
          '「考试都结束了，你才来？\n' +
          '　入场预留 ' + Math.round(EXAM_ENTRY_LIMIT / 60) + ' 分钟，考试 ' +
          Math.round(CONTEST_LEN / 3600) + ' 小时 —— 你在外面待了 ' +
          Math.round(state.admitElapsed / 60) + ' 分钟。」\n' +
          '走廊里已经没人了。这场考试跟你没关系了。',
    options: [
      { label: '……', cb: dlg => { closeDialog(dlg); endContest(false); } }
    ]
  });
  audio.beep(180, 0.4, 0.07, 'square');
}

/* 进楼前统一走一遍：考试彻底结束了就拦；否则记下到达时刻。
   注意：这里**不能**动考试时钟 —— 员工通道的弹窗有"算了"选项，
   在门禁处重置的话，玩家取消一次就白拿了一次 4 小时。 */
function passEntryGate(){
  if (state.examStarted) return true;          /* 读档后重新进楼：时钟已经在跑 */
  if (state.admitElapsed >= EXAM_ENTRY_LIMIT + CONTEST_LEN){
    lateShutout();
    return false;
  }
  state.entryArrival = state.admitElapsed;
  return true;
}

/* 真正进楼那一刻才换算考试时钟：
     早到（≤ 30 分钟）→ 0，考试从 4:00:00 开始；
     迟到（> 30 分钟）→ 入场时间 - 30 分钟，剩余考试时间 = 4 小时 - 这个值。 */
function beginExamClock(){
  if (state.examStarted) return;
  const raw = state.entryArrival;
  state.examStarted = true;
  state.elapsed = Math.max(0, raw - EXAM_ENTRY_LIMIT);
  state.admitElapsed = 0;

  if (raw > EXAM_ENTRY_LIMIT){
    unlockAch('late_entry');
    toast('你迟到了 ' + Math.ceil((raw - EXAM_ENTRY_LIMIT) / 60) +
          ' 分钟 —— 剩余考试时间 ' +
          Math.ceil((CONTEST_LEN - state.elapsed) / 60) + ' 分。', 3000);
  } else if (raw >= EXAM_ENTRY_LIMIT - EXAM_RUSH_MARGIN){
    unlockAch('rush');
    toast('你踩着入场预留的尾巴进来了 —— 考试时间从 4 小时重新开始。', 3000);
  }
}

/* ---------------------------- 进 404 教室 ---------------------------- */
function enter404Classroom(){
  if (!state.passedSecurity){
    toast('入口的安检还没过。', 1800);
    return;
  }
  if (state.enteredRoom) return;
  if (!passEntryGate()) return;
  dismissDialogs();
  openDialog({
    title: EXAM_CLASSROOM + ' 教室 · 考场 ' + EXAM_ROOM_NO,
    text: '门牌上写着 404。\n推门进去，空调的冷风、键盘声、还有四十几个人的呼吸声\n' +
          '一起扑过来。你的座位在第二排靠窗，屏幕已经亮着了。',
    options: [
      { label: '走到自己的座位', cb: dlg => {
          closeDialog(dlg);            /* 必须自己关，理由同 doSecurityCheck */
          beginExamClock();
          switchArea('room');
          state.enteredRoom = true;
          toast('CSP-S 2026 · 比赛开始。祝你 AK。', 2600);
          unlockAch('classroom');
        } }
    ]
  });
}

/* ---------------------------- 从员工通道进楼 ---------------------------- */
function enterSideDoor(){
  if (state.enteredRoom) return;
  if (!passEntryGate()) return;
  dismissDialogs();
  openDialog({
    title: '员 工 通 道',
    text: '铁门没锁，门缝里透出走廊的灯。\n' +
          '门上贴着「考试期间封闭」，落款是去年的。\n' +
          '安检门在正门那边 —— 从这里上去，没人会翻你的口袋。',
    options: [
      { label: '推门进去', cb: dlg => {
          closeDialog(dlg);            /* 必须自己关，理由同 doSecurityCheck */
          beginExamClock();
          state.enteredRoom = true;
          state.sneakedIn = true;
          /* 走廊里堆着扫帚 —— 这是侧门这条路唯一的实物收益。
             它不是消耗品：要在背包里按 B 指派到某一格，之后左键就是抡。 */
          if (bagAdd('broom', 1))
            toast('你顺手抄起了走廊里的一根扫把（按 B 装到快捷栏）。', 3000);
          switchArea('room');
          audio.beep(520, 0.10, 0.05);
          toast('你从员工通道进了楼 —— 手机还在兜里。', 2800);
          unlockAch('sideentry');
        } },
      { label: '算了，回去过安检', cb: dlg => closeDialog(dlg) }
    ]
  });
}

/* ---------------------------- 快速入场（作弊键） ----------------------------
   校园里连按 3 次 Backspace / Delete：跳过安检直接坐进 404 ——
   手机、背包一样都不没收（和员工通道同样"没被安检翻口袋"，但不用走路、不弹窗）。 */
function fastEnterExam(){
  if (state.enteredRoom) return;
  if (state.area !== 'campus') return;
  if (!passEntryGate()) return;
  dismissDialogs();
  beginExamClock();
  state.enteredRoom = true;
  switchArea('room');
  toast('你趁乱直接坐进了 404 —— 安检没翻你的口袋，什么都没被没收。', 2600);
}

/* ---------------------------- 志愿者对话 ---------------------------- */
function talkToVolunteer(rec){
  /* 台词按顺序轮播：第一次说完整的，后面变成简短的催促。
     这比每次重复同样三句话要自然得多。 */
  const v = rec.data;
  const key = '__talk_' + v.name;
  const idx = (state[key] || 0) % v.lines.length;
  state[key] = (state[key] || 0) + 1;

  const body = v.lines[idx];
  /* 三个选项都自己关窗（同 doSecurityCheck 的理由）。
     '谢了' 以前是空回调 () => {} —— 点了完全没反应，最容易被当成"卡死"。 */
  const opts = [{ label: '谢了', cb: dlg => closeDialog(dlg) }];

  /* 已经知道路的时候，直接给一个"带我去"的选项，省掉走那段路 */
  if (!state.passedSecurity && idx >= 1){
    opts.unshift({ label: '（直接过去）', cb: dlg => { closeDialog(dlg); teleportToExamDoor(); } });
  }
  if (state.passedSecurity){
    opts.unshift({ label: '进楼去', cb: dlg => { closeDialog(dlg); enter404Classroom(); } });
  }

  openDialog({
    title: v.name,
    text: body,
    options: opts
  });
  audio.beep(640, 0.05, 0.03, 'triangle');
}
