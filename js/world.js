'use strict';
/* =========================================================================
   world —— 考场场景搭建
   ---------------------------------------------------------------------
   房间尺寸固定在常量里，所有摆放都基于它推导，改房间大小不用改别处。
   桌子 / 椅子 / 显示器 / 人 都做成可复用的构造器，主循环只负责刷新
   显示器贴图。碰撞体在建造时顺手登记（addObstacle），玩家与 NPC 共用。
   ========================================================================= */

const ROOM_W = 16, ROOM_D = 14, ROOM_H = 3.4;
const DOOR_W = 0.95, DOOR_H = 2.15;     /* +X 墙上的门洞 */
const SEAT_Z_BIAS = 0.92;               /* 椅面相对桌心的偏移 */

/* 其他选手的座位（玩家自己的座位另算）。抽成常量是因为它现在有两个消费者：
   buildWorld() 摆桌椅和人，registerRoomObstacles() 登记碰撞体。
   以前这两件事写在一处，现在区域切换要单独重放碰撞，所以必须能共用同一份坐标 ——
   否则改了座位表就会有一份看不见的碰撞留在原地。 */
const NPC_SEATS = [
  { x: -4.5, z: -3.0, color: 0x3b5ba5 },
  { x: 4.5, z: -3.0, color: 0x8a4a6b },
  { x: -4.5, z: 2.5, color: 0x4a7a5a },
  { x: 0.0, z: 2.5, color: 0x7a6a3a },
  { x: 4.5, z: 2.5, color: 0x5a4a8a }
];

/* 终局白光（打完全部保安后点亮）：门板 / 门口光面 / 外扩辉光 / 地面投射光斑 / 点光源 */
let doorGroup = null, doorLightMesh = null, doorGlowMesh = null,
    doorFloorMesh = null, doorPointLight = null;
let doorOpenT = 0;

/* 假接触阴影已按要求去除：人物脚下不再贴径向渐变黑圈。
   addContactShadow / deepenContactShadows 保留为空的占位函数，好让 world.js 里的
   各个人物建造器（buildPerson / buildSecurityGuard / buildTeacher）以及 campus.js、
   main.js / tension.js 的既有调用点不用改。 */
function addContactShadow(parent, radius){ /* no-op：阴影已移除 */ }
function deepenContactShadows(t){ /* no-op：阴影已移除 */ }

/* ============================ 房间 ============================ */
/* 本区域有两块互不相干的空间（校园 / 房间），靠切换"障碍表 + 移动边界"来往走。
   所以这里把【几何体】和【碰撞体】彻底分开：
     buildRoom()              只建几何，一辈子只跑一次
     registerRoomObstacles()  只登记碰撞，每次切进房间都要重放
   这样切换区域时不需要重建任何几何，也不会出现"几何改造了、碰撞忘了改"。 */
/* 房间的静态碰撞体快照（墙 / 桌 / 饮水机，不含门）。
   保安在房间 ↔ 走廊之间追人时，需要「房间 + 走廊」的并集碰撞
   （见 building.js 的 guardCollides）—— 而全局 obstacles 只装玩家当前区域的墙。
   所以这里单独留一份房间的，供并集使用。 */
const roomObstacles = [];

function registerRoomObstacles(){
  obstacles.length = 0;          /* 自己清：下面的快照只取房间静态部分 */
  const W = ROOM_W, D = ROOM_D;
  /* 四面墙：+X 墙留门洞，让人能走出 404 进楼走廊（见 building.js） */
  addObstacle(-W / 2 - 0.5, 0, 0.5, D / 2 + 1);
  /* +X 墙的碰撞体要留出门口：以前整条都在，"能走出 404"这件事根本不可能发生。
     门口宽度 DOOR_W，位置 z=0。 */
  const gapHalf = DOOR_W / 2 + 0.05;
  const wallX = W / 2 + 0.5, zN = D / 2 + 1, zS = -D / 2 - 1;
  if (zS < -gapHalf) addObstacle(wallX, (zS - gapHalf) / 2, 0.5, (-gapHalf - zS) / 2);
  if (gapHalf < zN)  addObstacle(wallX, (zN + gapHalf) / 2, 0.5, (zN - gapHalf) / 2);
  addObstacle(0, -D / 2 - 0.5, W / 2 + 1, 0.5);
  addObstacle(0, D / 2 + 0.5, W / 2 + 1, 0.5);
  /* 六张课桌（玩家 1 张 + 同学 5 张）。桌椅布局由 buildDesk 的登记分支给出，
     坐标来源是 SEAT 常量，避免和 buildWorld 里的摆放写重一遍 */
  registerDeskObstacle(SEAT_CENTER_X, SEAT_CENTER_Z);
  for (const s of NPC_SEATS) registerDeskObstacle(s.x, s.z);
  /* 饮水机 */
  addObstacle(-6.6, 5.6, 0.25, 0.25);
  /* 快照（不含门）：门是动态的，由 rebuildGuardObstacles 按开关状态补 */
  roomObstacles.length = 0;
  for (const o of obstacles) roomObstacles.push(o);
  /* 教室门（404 东墙）：关门时把它的碰撞体补上（见 building.js） */
  registerDoorBlockers('room');
  rebuildGuardObstacles();
}

function buildRoom(){
  const W = ROOM_W, D = ROOM_D, H = ROOM_H;

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), mat(0x22262e, { roughness: 0.96 }));
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  const grid = new THREE.GridHelper(W, 16, 0x2e3442, 0x2a2f3b);
  grid.position.y = 0.005;
  scene.add(grid);

  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(W, D), mat(0x171b23, { roughness: 1 }));
  ceil.rotation.x = Math.PI / 2;
  ceil.position.y = H;
  scene.add(ceil);

  const wallMat = mat(0x2b313d, { roughness: 0.92 });
  const mkWall = (w, h, x, y, z, ry) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), wallMat);
    m.position.set(x, y, z);
    m.rotation.y = ry;
    scene.add(m);
    return m;
  };
  mkWall(W, H, 0, H / 2, -D / 2, 0);
  mkWall(W, H, 0, H / 2, D / 2, Math.PI);
  mkWall(D, H, -W / 2, H / 2, 0, Math.PI / 2);
  /* +X 墙留门洞：左右两段 + 门楣 */
  const sideW = (D - DOOR_W) / 2;
  mkWall(sideW, H, W / 2, H / 2, -(D / 2 - sideW / 2), -Math.PI / 2);
  mkWall(sideW, H, W / 2, H / 2, (D / 2 - sideW / 2), -Math.PI / 2);
  mkWall(DOOR_W, H - DOOR_H, W / 2, DOOR_H + (H - DOOR_H) / 2, 0, -Math.PI / 2);

  /* 碰撞体不在这里登记 —— 见 registerRoomObstacles() */

  /* 吊灯：灯管用自发光面片，真实点光源只留 3 盏（点光源数量直接进 shader） */
  for (let i = -1; i <= 1; i++){
    const lamp = new THREE.Mesh(getBoxGeo(3.4, 0.06, 0.42),
      new THREE.MeshBasicMaterial({ color: 0xfff4dc }));
    lamp.position.set(i * 4.6, H - 0.08, 0);
    scene.add(lamp);
    const pl = new THREE.PointLight(0xfff0d8, 1.1, 24, 2);
    pl.position.set(i * 4.6, H - 0.4, 0);
    scene.add(pl);
  }

  buildBlackboard(D);
  buildClock(D);
  buildDoor(W);
  buildWindow(W);
  buildCooler();
}

function buildBlackboard(D){
  box(6.16, 2.16, 0.03, 0x3a4150, 0, 1.85, -D / 2 + 0.03, scene);
  const { c, ctx } = makeCanvas(1024, 320);
  ctx.fillStyle = '#f2f4f0'; ctx.fillRect(0, 0, 1024, 320);
  ctx.fillStyle = '#c0392b';
  ctx.font = 'bold 52px "Microsoft YaHei", sans-serif';
  ctx.fillText('NOI 2026  竞赛守则', 56, 88);
  ctx.fillStyle = '#2c3e50';
  ctx.font = '29px "Microsoft YaHei", sans-serif';
  ctx.fillText('1. 禁止随意走动、禁止交头接耳、禁止干扰他人', 56, 158);
  ctx.fillText('2. 如需去洗手间请举手示意监考老师', 56, 202);
  ctx.fillText('3. 尊重监考老师，禁止任何形式的暴力行为', 56, 246);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(5.96, 1.96),
    new THREE.MeshBasicMaterial({ map: canvasTex(c, true) }));
  face.position.set(0, 1.85, -D / 2 + 0.085);
  scene.add(face);
}

function buildClock(D){
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.07, 32),
    mat(0xe8ecf2, { roughness: 0.4 }));
  body.rotation.x = Math.PI / 2;
  body.position.set(6.2, 2.6, -D / 2 + 0.08);
  scene.add(body);

  const face = new THREE.Mesh(new THREE.CircleGeometry(0.29, 32),
    new THREE.MeshBasicMaterial({ color: 0xfbfcfe }));
  face.position.set(6.2, 2.6, -D / 2 + 0.13);
  scene.add(face);

  const hh = box(0.022, 0.15, 0.01, 0x1a1a1a, 6.2, 2.65, -D / 2 + 0.14, scene);
  const mm = box(0.018, 0.23, 0.01, 0x333333, 6.2, 2.71, -D / 2 + 0.145, scene);
  hh.rotation.z = 0.6;
  mm.rotation.z = -1.1;
}

function buildDoor(W){
  /* 注意：必须赋值给模块级 doorGroup，不能加 const 遮蔽它，
     否则 updateDoorLight 拿到的永远是 null */
  doorGroup = new THREE.Group();
  doorGroup.position.set(W / 2 - 0.04, 0, -DOOR_W / 2);
  scene.add(doorGroup);
  box(0.07, 2.15, DOOR_W, 0x4a3a2e, 0, 1.075, DOOR_W / 2, doorGroup, { roughness: 0.7 });

  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.16, 10),
    mat(0xc9b037, { metalness: 0.85, roughness: 0.28 }));
  handle.rotation.x = Math.PI / 2;
  handle.position.set(-0.08, 1.05, 0.15);
  doorGroup.add(handle);

  const { c, ctx } = makeCanvas(256, 96);
  ctx.fillStyle = '#1f6b4a'; ctx.fillRect(0, 0, 256, 96);
  ctx.fillStyle = '#fff'; ctx.font = 'bold 46px "Microsoft YaHei"';
  ctx.textAlign = 'center'; ctx.fillText('出 口', 128, 64);
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.19),
    new THREE.MeshBasicMaterial({ map: canvasTex(c, true) }));
  sign.position.set(W / 2 - 0.09, 2.42, 0);
  sign.rotation.y = -Math.PI / 2;
  scene.add(sign);

  /* ---- 终局白光四件套 ---- */
  doorLightMesh = new THREE.Mesh(new THREE.PlaneGeometry(DOOR_W, DOOR_H),
    new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0,
      depthWrite: false, side: THREE.DoubleSide
    }));
  doorLightMesh.position.set(W / 2 + 0.14, DOOR_H / 2, 0);
  doorLightMesh.rotation.y = -Math.PI / 2;
  doorLightMesh.visible = false;
  scene.add(doorLightMesh);

  doorGlowMesh = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 3.4),
    new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
    }));
  doorGlowMesh.position.set(W / 2 + 0.42, 1.5, 0);
  doorGlowMesh.rotation.y = -Math.PI / 2;
  doorGlowMesh.visible = false;
  scene.add(doorGlowMesh);

  const fc = makeCanvas(256, 256);
  const grad = fc.ctx.createLinearGradient(256, 0, 0, 0);
  grad.addColorStop(0.0, 'rgba(255,255,255,0.95)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1.0, 'rgba(255,255,255,0)');
  fc.ctx.fillStyle = grad;
  fc.ctx.fillRect(0, 0, 256, 256);
  doorFloorMesh = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 2.8),
    new THREE.MeshBasicMaterial({
      map: new THREE.CanvasTexture(fc.c), transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false
    }));
  doorFloorMesh.rotation.x = -Math.PI / 2;
  doorFloorMesh.position.set(W / 2 - 2.1, 0.03, 0);
  doorFloorMesh.visible = false;
  scene.add(doorFloorMesh);

  doorPointLight = new THREE.PointLight(0xffffff, 0, 18, 2);
  doorPointLight.userData.noTensionDim = true;
  doorPointLight.position.set(W / 2 + 0.5, 1.6, 0);
  scene.add(doorPointLight);
}

function buildWindow(W){
  box(0.06, 1.6, 3.0, 0x3a4150, -W / 2 + 0.04, 1.9, 0, scene);
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 1.42),
    new THREE.MeshBasicMaterial({ color: 0x6d8fb8 }));
  glass.position.set(-W / 2 + 0.09, 1.9, 0);
  glass.rotation.y = Math.PI / 2;
  scene.add(glass);
  /* 窗框竖梃，避免一整块蓝板太假 */
  box(0.05, 1.5, 0.05, 0x2a303c, -W / 2 + 0.10, 1.9, 0, scene);
  box(0.05, 0.05, 2.9, 0x2a303c, -W / 2 + 0.10, 1.9, 0, scene);
}

function buildCooler(){
  const cooler = new THREE.Group();
  cooler.position.set(-6.6, 0, 5.6);
  scene.add(cooler);
  box(0.36, 1.0, 0.36, 0xdfe4ec, 0, 0.5, 0, cooler, { roughness: 0.5 });
  box(0.3, 0.36, 0.3, 0x8fd0f0, 0, 1.18, 0, cooler,
    { transparent: true, opacity: 0.75, roughness: 0.15 });
  box(0.4, 0.04, 0.4, 0x9aa4b4, 0, 1.0, 0, cooler);
  addObstacle(-6.6, 5.6, 0.25, 0.25);
}

/* ============================ 显示器贴图 ============================ */
/* 屏幕内容：题目列表 + 当前题代码首屏预览。卡片是"活的"，提交/切题都会刷新。
   owner 为空 = 玩家自己的座位；否则是那位选手的名字。
   别人的屏幕必须画他自己的题和他的代码 —— 要是整屋子显示器都读
   state.problems / state.code，你走到谁那儿看到的都是自己的屏幕。 */
function drawDeskScreen(cx, w, h, owner){
  const who = owner || '';
  cx.fillStyle = '#0b0f16'; cx.fillRect(0, 0, w, h);
  cx.fillStyle = '#131b26'; cx.fillRect(0, 0, w, 34);
  cx.fillStyle = '#5b8cff'; cx.fillRect(0, 32, w, 2);
  cx.fillStyle = '#8ea6d8'; cx.font = 'bold 16px Consolas, monospace';
  cx.fillText('NOI 2026  Contest Environment' + (who ? '   |  ' + who : ''), 14, 23);

  cx.fillStyle = '#1a2330'; cx.fillRect(12, 48, w - 24, 104);
  cx.font = '15px Consolas, monospace';

  let lines;
  if (who){
    /* ---- 别人的屏幕：他自己的题、他自己的代码 ---- */
    const pid = npcProblemId(who);
    const prob = PROBLEM_BY_ID.get(pid);
    const max = prob ? prob.max : 100;
    const sc = rivalProblemScore(who, 0);
    const label = (pid + '  ' + (prob ? prob.name : '')).slice(0, 24);
    const pad = ' '.repeat(Math.max(1, 24 - label.length));
    let status, color;
    if (sc >= max)      { status = '[ 已 AC ]';  color = '#4fd1c5'; }
    else if (sc > 0)    { status = '[ 部分分 ]'; color = '#ffcc57'; }
    else                { status = '[ 未提交 ]'; color = '#8a92a5'; }
    cx.fillStyle = color;
    cx.fillText(label + pad + status, 26, 76);
    lines = genNpcCode(who, pid).split('\n').slice(0, 9);

  } else {
    /* ---- 你自己的屏幕 ---- */
    const probs = (state.problems && state.problems.length) ? state.problems : [];
    probs.slice(0, 4).forEach((p, i) => {
      const sc = state.score[p.id] || 0;
      const label = (p.id + '  ' + p.name).slice(0, 24);
      const pad = ' '.repeat(Math.max(1, 24 - label.length));
      let status, color;
      if (sc >= p.max)      { status = '[ 已 AC ]';  color = '#4fd1c5'; }
      else if (sc > 0)      { status = '[ 部分分 ]'; color = '#ffcc57'; }
      else                  { status = '[ 未提交 ]'; color = '#8a92a5'; }
      cx.fillStyle = color;
      cx.fillText(label + pad + status, 26, 76 + i * 24);
    });
    const first = probs[0];
    lines = (first && state.code[first.id])
      ? state.code[first.id].split('\n').slice(0, 9)
      : ['#include <bits/stdc++.h>', 'using namespace std;', '', 'int main() {', '    // ...', '    return 0;', '}'];
  }

  cx.fillStyle = '#3a4456'; cx.fillRect(12, 158, w - 24, 2);

  cx.font = '14px Consolas, monospace';
  lines.forEach((l, i) => {
    let color = '#8fa8c8';
    if (/^\s*#/.test(l))                              color = '#c586c0';
    else if (/\/\//.test(l))                          color = '#5a6b80';
    else if (/(cin|cout|return|int main)/.test(l))    color = '#9cdcfe';
    cx.fillStyle = color;
    cx.fillText(l.slice(0, 62), 24, 188 + i * 21);
  });
}

function updateAllDeskScreens(){
  for (const s of deskScreens){
    drawDeskScreen(s.ctx, 640, 384, s.owner);
    s.tex.needsUpdate = true;
  }
}

/* 合并短时间内的多次刷新（连续提交时避免 6 张画布反复全量重绘） */
let deskScreenTimer = null;
function scheduleDeskScreensUpdate(){
  if (deskScreenTimer) return;
  deskScreenTimer = setTimeout(() => {
    deskScreenTimer = null;
    updateAllDeskScreens();
  }, 80);
}

/* ============================ 桌椅 / 电脑 ============================ */
/* 一张课桌的碰撞体。抽出来是因为 registerRoomObstacles() 需要在切区域时
   只看布局、不建几何地把六张桌子重新登记一遍。 */
function registerDeskObstacle(x, z){ addObstacle(x, z, 0.92, 0.45); }

function buildDesk(x, z, withMonitor, owner){
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  scene.add(g);

  const woodTop = 0x6b5137;
  box(1.9, 0.06, 0.95, woodTop, 0, 0.74, 0, g);
  for (const dx of [-0.88, 0.88]){
    for (const dz of [-0.4, 0.4]){
      box(0.06, 0.74, 0.06, 0x2b303b, dx, 0.37, dz, g);
    }
  }
  box(1.9, 0.4, 0.03, 0x50596a, 0, 0.55, -0.44, g);

  /* 碰撞不在 buildDesk 里登记：几何与碰撞分开，见 registerRoomObstacles() */

  if (withMonitor){
    box(0.46, 0.025, 0.22, 0x22262e, 0, 0.775, -0.28, g);
    box(0.07, 0.34, 0.07, 0x2e3440, 0, 0.95, -0.30, g);
    box(0.80, 0.48, 0.035, 0x15181f, 0, 1.26, -0.30, g);

    const { c, ctx } = makeCanvas(640, 384);
    drawDeskScreen(ctx, 640, 384, owner);
    const tex = canvasTex(c, true);
    const face = new THREE.Mesh(new THREE.PlaneGeometry(0.75, 0.44),
      new THREE.MeshBasicMaterial({ map: tex }));
    face.position.set(0, 1.26, -0.278);
    g.add(face);
    /* owner 决定这块屏画谁的题：'' = 玩家，名字 = 那位选手 */
    deskScreens.push({ ctx: ctx, tex: tex, canvas: c, owner: owner || '' });

    /* 屏幕辉光：一块加法面片代替一台台 PointLight（省 shader 分支） */
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.34),
      new THREE.MeshBasicMaterial({
        color: 0x35507f, transparent: true, opacity: 0.18, depthWrite: false
      }));
    glow.position.set(0, 1.26, -0.06);
    g.add(glow);

    /* 键盘：用 canvas 画一组键帽，比真建 96 个盒子便宜得多 */
    const kb = makeCanvas(512, 180);
    kb.ctx.fillStyle = '#1c2028'; kb.ctx.fillRect(0, 0, 512, 180);
    kb.ctx.fillStyle = '#2c323e';
    for (let r = 0; r < 6; r++){
      for (let cix = 0; cix < 16; cix++){
        const w = (r === 5 && cix > 3 && cix < 9) ? 40 : 26;
        kb.ctx.fillRect(10 + cix * 31, 12 + r * 27, w, 21);
      }
    }
    const kbMesh = new THREE.Mesh(getBoxGeo(0.46, 0.022, 0.16),
      new THREE.MeshStandardMaterial({ map: canvasTex(kb.c, true), roughness: 0.75 }));
    kbMesh.position.set(0, 0.775, 0.08);
    g.add(kbMesh);

    box(0.065, 0.028, 0.105, 0x1e222a, 0.38, 0.778, 0.10, g, { roughness: 0.6 });

    /* 水杯 */
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.03, 0.10, 16),
      new THREE.MeshStandardMaterial({
        color: 0xdfe6f2, transparent: true, opacity: 0.55, roughness: 0.2
      }));
    cup.position.set(0.66, 0.82, -0.02);
    g.add(cup);
    cup.userData.interact = { label: '喝水', action: () => drinkWater() };
    interactables.push(cup);

    /* 草稿纸 + 笔 */
    const paper = new THREE.Mesh(new THREE.PlaneGeometry(0.30, 0.42),
      new THREE.MeshStandardMaterial({
        color: 0xf2eee3, roughness: 0.95, side: THREE.DoubleSide
      }));
    paper.rotation.x = -Math.PI / 2;
    paper.rotation.z = 0.14;
    paper.position.set(-0.62, 0.772, 0.06);
    g.add(paper);
    paper.userData.interact = { label: '摊开草稿纸', action: () => openPaper() };
    interactables.push(paper);

    const pen = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.15, 8),
      mat(0x2a2f3a, { roughness: 0.5 }));
    pen.rotation.z = Math.PI / 2;
    pen.rotation.y = 0.3;
    pen.position.set(-0.62, 0.782, 0.20);
    g.add(pen);

    /* 进入电脑：先进桌面（CSP-S114514 文件夹），再从文件夹里的题目文件进 IDE。
       这样"桌面 → 文件夹 → 题目"这条路是真的，而不是直接跳进编辑器。
       编辑器里的 Esc / 离开按钮依然可用，不会因为多了一层而变麻烦。

       owner 这一支是必须的：buildDesk 会给**每一张**桌子跑一遍，
       包括五个同学的桌子。以前无条件挂 openDesktop()，于是走到谁那儿
       按 E 打开的都是你自己的桌面 —— 这才是"别人的电脑显示我的电脑"的根。 */
    if (owner){
      face.userData.interact = {
        label: '看一眼' + owner + '的电脑',
        action: () => {
          const idx = npcs.findIndex(n => n.userData && n.userData.name === owner);
          if (idx < 0){ toast('这台电脑没人用。', 1400); return; }
          useNPCComputer(idx);      /* 人不在才给看；坐着会拒绝，理由在 npc.js */
        }
      };
    } else {
      face.userData.interact = {
        label: '打开电脑桌面 · CSP-S114514',
        action: () => openDesktop()
      };
    }
    interactables.push(face);
  }

  /* 椅子 */
  const chair = new THREE.Group();
  chair.position.set(0, 0, SEAT_Z_BIAS);
  g.add(chair);
  box(0.46, 0.05, 0.46, 0x2e3440, 0, 0.45, 0, chair);
  box(0.46, 0.52, 0.05, 0x2e3440, 0, 0.72, 0.21, chair);
  box(0.05, 0.45, 0.05, 0x242a34, 0, 0.22, 0, chair);

  return g;
}

/* ============================ 人物 ============================ */
/* 坐姿腿组 / 站姿腿组同时建好，切姿势只改 visible —— 比每帧重建骨骼便宜 */
function buildPerson(x, z, shirtColor, rotY, startPose){
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = rotY || 0;
  scene.add(g);

  const skin = 0xd8a878, pants = 0x2a3140;

  const legsSit = new THREE.Group();
  box(0.17, 0.17, 0.44, pants, -0.115, 0.52, 0.22, legsSit);
  box(0.17, 0.17, 0.44, pants, 0.115, 0.52, 0.22, legsSit);
  box(0.16, 0.44, 0.16, pants, -0.115, 0.24, 0.42, legsSit);
  box(0.16, 0.44, 0.16, pants, 0.115, 0.24, 0.42, legsSit);
  g.add(legsSit);

  const legsStand = new THREE.Group();
  box(0.17, 0.9, 0.17, pants, -0.115, 0.45, 0, legsStand);
  box(0.17, 0.9, 0.17, pants, 0.115, 0.45, 0, legsStand);
  g.add(legsStand);

  if (startPose === 'stand') legsSit.visible = false;
  else legsStand.visible = false;

  box(0.44, 0.58, 0.27, shirtColor, 0, 1.09, 0.01, g);
  const armL = box(0.115, 0.42, 0.115, shirtColor, -0.29, 1.06, 0.13, g);
  const armR = box(0.115, 0.42, 0.115, shirtColor, 0.29, 1.06, 0.13, g);

  const head = new THREE.Mesh(getSphereGeo(0.135, 16, 12), mat(skin, { roughness: 0.75 }));
  head.position.set(0, 1.52, 0.02);
  g.add(head);

  const hair = new THREE.Mesh(
    new THREE.SphereGeometry(0.142, 16, 12, 0, TAU, 0, Math.PI * 0.62),
    mat(0x18181c, { roughness: 1 }));
  hair.position.set(0, 1.535, 0.02);
  g.add(hair);

  addContactShadow(g, 0.52);

  return {
    group: g, armL: armL, armR: armR, head: head,
    legsSit: legsSit, legsStand: legsStand,
    phase: Math.random() * TAU,
    /* userData 必须一开始就存在。
       buildPerson 返回的是一个字面量对象，不是 THREE.Object3D ——
       g.userData 有值，p.userData 却是 undefined。调用方看到"人物对象"
       很自然会写 p.userData.xxx = ...，于是直接抛
       "Cannot set properties of undefined"。
       初值放在这里，比让每个调用方自己记得先赋值可靠。 */
    userData: {}
  };
}

/* 监考老师：衬衫 + 挂绳 + 记录板。身高比学生高一档（视觉上就有压迫感） */
function buildTeacher(x, z){
  const p = buildPerson(x, z, 0x2f3a4d, 0, 'stand');
  const g = p.group;
  g.scale.setScalar(1.06);

  box(0.40, 0.03, 0.24, 0x8a2b2b, 0, 1.20, 0.15, g);                 /* 红领带 */
  box(0.19, 0.26, 0.02, 0xd9d2c2, 0, 1.02, 0.15, g);                 /* 胸牌 */
  const board = box(0.22, 0.30, 0.015, 0x3b3226, 0.30, 0.98, 0.22, g);
  board.rotation.z = 0.16;
  const { c, ctx } = makeCanvas(128, 176);
  ctx.fillStyle = '#f2eee3'; ctx.fillRect(0, 0, 128, 176);
  ctx.strokeStyle = '#b9b2a2'; ctx.lineWidth = 1;
  for (let y = 24; y < 176; y += 18){
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(128, y); ctx.stroke();
  }
  ctx.fillStyle = '#c0392b'; ctx.font = 'bold 17px "Microsoft YaHei"';
  ctx.fillText('记录本', 16, 18);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(0.20, 0.28),
    new THREE.MeshBasicMaterial({ map: canvasTex(c, true) }));
  face.position.set(-0.012, 0, 0.014);
  board.add(face);

  return p;
}

/* 保安：制服 + 肩章 + 帽檐 + 头顶警灯（灯由 guards.js 驱动闪烁） */
function buildSecurityGuard(x, z){
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  scene.add(g);

  const skin = 0xd0a070, uniform = 0x1c2a44, pants = 0x141e30;

  box(0.18, 0.17, 0.46, pants, -0.115, 0.52, 0.22, g);
  box(0.18, 0.17, 0.46, pants, 0.115, 0.52, 0.22, g);
  box(0.17, 0.46, 0.17, pants, -0.115, 0.24, 0.42, g);
  box(0.17, 0.46, 0.17, pants, 0.115, 0.24, 0.42, g);

  box(0.50, 0.62, 0.29, uniform, 0, 1.10, 0.01, g);
  box(0.52, 0.035, 0.31, 0xffcc33, 0, 0.90, 0.01, g);
  box(0.52, 0.035, 0.31, 0xffcc33, 0, 1.28, 0.01, g);
  box(0.52, 0.045, 0.31, 0x0a1525, 0, 1.40, 0.01, g);
  box(0.52, 0.05, 0.31, 0x080808, 0, 0.80, 0.01, g);

  /* 手臂要能单独摆：独立几何 + 独立材质 */
  const armL = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.55, 0.14),
    new THREE.MeshStandardMaterial({ color: uniform, roughness: 0.88, metalness: 0.04 }));
  armL.position.set(-0.33, 1.12, 0.10);
  armL.rotation.x = -0.2;
  g.add(armL);

  const armR = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.55, 0.14),
    new THREE.MeshStandardMaterial({ color: uniform, roughness: 0.88, metalness: 0.04 }));
  armR.position.set(0.33, 1.12, 0.10);
  armR.rotation.x = -0.2;
  g.add(armR);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 16, 12),
    new THREE.MeshStandardMaterial({ color: skin, roughness: 0.75, metalness: 0.04 }));
  head.position.set(0, 1.58, 0.02);
  g.add(head);

  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.06, 16),
    new THREE.MeshStandardMaterial({ color: 0x0a1525, roughness: 0.5, metalness: 0.04 }));
  cap.position.set(0, 1.76, 0.02);
  g.add(cap);

  const brim = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.02, 0.18),
    new THREE.MeshStandardMaterial({ color: 0x050c18, roughness: 0.5, metalness: 0.04 }));
  brim.position.set(0, 1.73, 0.13);
  g.add(brim);

  const badge = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.01, 8),
    new THREE.MeshStandardMaterial({ color: 0xffcc33, roughness: 0.3, metalness: 0.8 }));
  badge.rotation.x = Math.PI / 2;
  badge.position.set(0, 1.76, 0.15);
  g.add(badge);

  const warnLight = new THREE.Mesh(getSphereGeo(0.05, 8, 8),
    new THREE.MeshBasicMaterial({ color: 0xff3333 }));
  warnLight.position.set(0, 1.84, 0.02);
  g.add(warnLight);

  const glow = new THREE.Mesh(getSphereGeo(0.13, 8, 8),
    new THREE.MeshBasicMaterial({
      color: 0xff3333, transparent: true, opacity: 0.30,
      blending: THREE.AdditiveBlending, depthWrite: false
    }));
  glow.position.set(0, 1.84, 0.02);
  g.add(glow);

  addContactShadow(g, 0.58);

  return {
    group: g, armL: armL, armR: armR, head: head,
    warnLight: warnLight, glow: glow, phase: Math.random() * TAU
  };
}

/* ============================ 组装世界 ============================ */
function buildWorld(){
  buildRoom();
  buildDesk(SEAT_CENTER_X, SEAT_CENTER_Z, true);   /* 玩家的座位 */

  /* 其他选手：五张桌 + 五个人，位置错开形成两条纵向通道。
     座位表来自 NPC_SEATS —— 和 registerRoomObstacles() 共用同一份坐标，
     这样"摆在这里、撞在那里"不可能对不上。 */
  const names = ['小明', '小红', '小刚', '小强', '小丽'];

  NPC_SEATS.forEach((s, i) => {
    /* 第四参数是这块屏的主人：屏幕按他的名字画他自己的题，
       不传的话所有人的显示器都会画你那一份（走一圈还以为在照镜子）。 */
    buildDesk(s.x, s.z, true, names[i]);
    const p = buildPerson(s.x, s.z + SEAT_Z_BIAS, s.color, Math.PI);
    p.userData = {
      id: i, name: names[i],
      seatX: s.x, seatZ: s.z + SEAT_Z_BIAS,
      state: 'seated', anger: 0, baseRot: Math.PI, timer: 0
    };
    npcs.push(p);
  });

  teacher = buildTeacher(2.4, 0);
  teacher.userData = { mode: 'patrol' };
}
