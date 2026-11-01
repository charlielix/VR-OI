'use strict';
/* =========================================================================
   building —— 教学楼里的其他考场 / 走廊 / 楼层 / 洗手间
   ---------------------------------------------------------------------
   404（玩家那间）之外，楼里还有别的考场和楼层：
     · 1F：一条南北向走廊（贴着 404 的东墙，门洞在 +X 墙上），走廊东侧
       两间考场 405 / 406，北头是洗手间，南头是楼梯间（通 2F）。
     · 2F：结构一致，两间考场 501 / 502，整体沿 +Z 偏移 FL2_Z。
   引擎是 XZ 平面 + 固定眼高，没有真实的"向上走"，所以 2F 是 +Z 偏移的
   一条平行街区；楼梯间用淡入淡出传送连接（和校门传送圈同款手感）。
   各考场里坐的是"外班同学"（foreignNpcs）—— 不属于你的榜单，干扰他们
   纯属捣蛋：爽一下 + 解锁成就，但把他们惹毛了会招来监考老师。
   ========================================================================= */

/* 走廊 x 范围与半长。405/406/501/502 都贴着走廊东墙往外扩 2*CLS_HW。 */
const BD_X0 = 8, BD_X1 = 13;
const BD_LEN = 20;
const CLS_HW = 8, CLS_HD = 7;
const FL2_Z = 60;
const BD_WALL = 0.22;                     /* 走廊/教室墙半厚 */

/* 外班同学 + 各层的障碍清单（switchArea 切进来时整体重放） */
const foreignNpcs = [];
const hallObstacles1f = [];
const hallObstacles2f = [];

const FOREIGN_NAMES = ['王同学', '李同学', '张同学', '刘同学', '陈同学',
                       '杨同学', '赵同学', '黄同学', '周同学', '吴同学'];

/* 每层的考场：cx 固定 = BD_X1 + CLS_HW = 21，cz 是教室中心 z。
   扩展说明（做"方案 B 更多楼层"时按这三步改，无需动核心循环）：
   ① FLOORS 里加一行 { zOff: 上一层 zOff+40, ground:false, rooms:[...] }；
   ② core.js 的 AREA_BOUNDS 加对应 hall{n}（xMin/xMax 同 hall1，zMin/zMax = zOff±27）；
   ③ stairsTeleport() 的落点分支补一层；若楼上要独立障碍表，给 building.js
   加个 hallObstacles{n} 并在 registerHallObstacles 里 switch 一下。 */
const FLOORS = [
  { zOff: 0,   ground: true,  areaKey: 'hall1', rooms: [
      { name: '405', cz: 11, seats: 3 },
      { name: '406', cz: -11, seats: 3 }
    ]},
  { zOff: FL2_Z, ground: false, areaKey: 'hall2', rooms: [
      { name: '501', cz: 71, seats: 2 },
      { name: '502', cz: 49, seats: 2 }
    ]}
];

const FOREIGN_LINES = [
  '干嘛？这是我们的考场！',
  '你谁啊？别碰我东西。',
  '再乱来我要喊监考老师了！',
  '老师——！这里有人捣乱！！'
];

const bWallMat = mat(0x2b313d, { roughness: 0.92, side: THREE.DoubleSide });

/* ============================ 教室门 ============================
   每个考场一扇门：关着时有碰撞挡路，按 E 推开/拉上，开门 10 秒后自动关。
   blockers 是"关门时补进障碍表的格子"（门洞在 wallZOb 的 gaps 里本来就是空的）；
   404 的门横跨 room / hall1 两个区域，所以它可以有多个 blocker。 */
const classroomDoors = [];
const DOOR_AUTO_CLOSE = 10;      /* 秒 */

/* 一扇铰链门：hinge 在门洞上沿某一边，面板沿 +Z 展开，绕 Y 轴摆开 */
function makeDoorGroup(hingeX, hingeZ){
  const g = new THREE.Group();
  g.position.set(hingeX, 0, hingeZ);
  box(0.06, DOOR_H, DOOR_W, 0x4a3a2e, 0, DOOR_H / 2, DOOR_W / 2, g, { roughness: 0.7 });
  const knob = new THREE.Mesh(getSphereGeo(0.045, 8, 8),
    mat(0xc9b037, { metalness: 0.85, roughness: 0.3 }));
  knob.position.set(0.07, 1.05, DOOR_W - 0.11);
  g.add(knob);
  scene.add(g);
  return g;
}

function registerClassroomDoor(name, group, openRotY, areas, blockers){
  classroomDoors.push({
    name: name, group: group,
    closedRotY: group.rotation.y, openRotY: openRotY,
    state: 'closed', closeAt: 0,
    areas: areas, blockers: blockers
  });
}

/* 关门时，把属于当前区域的门的碰撞体补进 obstacles */
function registerDoorBlockers(area){
  for (const d of classroomDoors){
    if (d.state !== 'closed') continue;
    for (const b of d.blockers){
      if (b.area === area) addObstacle(b.x, b.z, b.hw, b.hd);
    }
  }
}

/* 开/关门后重放当前区域的障碍表（门洞补上/撤掉一个格子） */
function refreshAreaObstacles(){
  obstacles.length = 0;
  if (state.area === 'campus'){ for (const o of campusColliders) obstacles.push(o); }
  else if (state.area === 'room'){ registerRoomObstacles(); }
  else { registerHallObstacles(state.area === 'hall2' ? 2 : 1); }
}

function setDoorOpen(d, open){
  d.state = open ? 'open' : 'closed';
  d.group.rotation.y = open ? d.openRotY : d.closedRotY;
  d.closeAt = open ? (state.worldTime + DOOR_AUTO_CLOSE) : 0;
  refreshAreaObstacles();
}

function openClassroomDoor(d){
  if (state.ended || state.frozen) return;
  if (d.name === '404' && state.doorOpen) return;   /* 终局门归 combat 管 */
  setDoorOpen(d, d.state !== 'open');
  audio.beep(420, 0.06, 0.04);
}

/* 每帧：到点的门自动关 */
function updateClassroomDoors(){
  for (const d of classroomDoors){
    if (d.state === 'open' && d.closeAt > 0 && state.worldTime >= d.closeAt){
      if (d.name === '404' && state.doorOpen) continue;
      setDoorOpen(d, false);
    }
  }
}

/* 站在本区域某扇门边时给出"开门/关门"提示；返回 true 表示已接管交互 */
function doorInteractPrompt(){
  for (const d of classroomDoors){
    if (!d.areas.includes(state.area)) continue;
    if (d.name === '404' && state.doorOpen) continue;
    const d2 = Math.hypot(state.pos.x - d.group.position.x, state.pos.z - d.group.position.z);
    if (d2 < 1.7){
      actionE = { fn: () => openClassroomDoor(d) };
      setPrompt(d.state === 'closed' ? '[ E ] 开门' : '[ E ] 关门');
      promptEl.classList.remove('hidden');
      return true;
    }
  }
  return false;
}

/* ---- 墙：给定一段 [a,b] 和若干门洞 [g0,g1]，返回实心段的列表 ---- */
function solidSegs(a, b, gaps){
  const sorted = (gaps || []).slice().sort((p, q) => p[0] - q[0]);
  const out = [];
  let cur = a;
  for (const [g0, g1] of sorted){
    if (g0 > cur) out.push([cur, g0]);
    cur = Math.max(cur, g1);
  }
  if (cur < b) out.push([cur, b]);
  return out;
}

/* 固定 x 的墙（沿 z 走）；几何一段段拼，留出门口 */
function wallZ(x, z0, z1, gaps){
  for (const [a, b] of solidSegs(z0, z1, gaps)){
    const m = new THREE.Mesh(new THREE.PlaneGeometry(b - a, ROOM_H * 0.99), bWallMat);
    m.position.set(x, ROOM_H / 2, (a + b) / 2);
    m.rotation.y = Math.PI / 2;
    scene.add(m);
  }
}
function wallZOb(list, x, z0, z1, gaps){
  for (const [a, b] of solidSegs(z0, z1, gaps)) list.push({ x: x, z: (a + b) / 2, hw: BD_WALL, hd: (b - a) / 2 });
}

/* 固定 z 的墙（沿 x 走） */
function wallX(z, x0, x1, gaps){
  for (const [a, b] of solidSegs(x0, x1, gaps)){
    const m = new THREE.Mesh(new THREE.PlaneGeometry(b - a, ROOM_H * 0.99), bWallMat);
    m.position.set((a + b) / 2, ROOM_H / 2, z);
    m.rotation.y = 0;
    scene.add(m);
  }
}
function wallXOb(list, z, x0, x1, gaps){
  for (const [a, b] of solidSegs(x0, x1, gaps)) list.push({ x: (a + b) / 2, z: z, hw: (b - a) / 2, hd: BD_WALL });
}

/* ---- 建一层：走廊 + 两间考场 + 洗手间 + 楼梯间 ---- */
function buildFloor(zOff, ground, rooms, obList, areaKey){
  const zS = zOff - BD_LEN, zN = zOff + BD_LEN;
  const cx = (BD_X0 + BD_X1) / 2;
  const doorHalf = DOOR_W / 2 + 0.05;         /* 门洞半宽 0.525 */
  const smallDoor = [[10, 11]];                /* 洗手间/楼梯间的门洞（x 方向） */

  /* 走廊地面 + 天花板 */
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(BD_X1 - BD_X0, BD_LEN * 2),
    mat(0x23272f, { roughness: 0.96 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(cx, 0, zOff);
  scene.add(floor);
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(BD_X1 - BD_X0, BD_LEN * 2),
    mat(0x171b23, { roughness: 1.0 }));
  ceil.rotation.x = Math.PI / 2;
  ceil.position.set(cx, ROOM_H, zOff);
  scene.add(ceil);

  /* 走廊西墙：1F 与 404 之间留门洞，2F 是整面墙 */
  wallZ(BD_X0, zS, zN, ground ? [[-doorHalf, doorHalf]] : []);
  wallZOb(obList, BD_X0, zS, zN, ground ? [[-doorHalf, doorHalf]] : []);

  /* 走廊东墙：两间考场的门洞 */
  const eastGaps = rooms.map(r => [r.cz - doorHalf, r.cz + doorHalf]);
  wallZ(BD_X1, zS, zN, eastGaps);
  wallZOb(obList, BD_X1, zS, zN, eastGaps);

  /* 走廊北墙（洗手间门洞）+ 南墙（楼梯间门洞） */
  wallX(zN, BD_X0, BD_X1, smallDoor);
  wallXOb(obList, zN, BD_X0, BD_X1, smallDoor);
  wallX(zS, BD_X0, BD_X1, smallDoor);
  wallXOb(obList, zS, BD_X0, BD_X1, smallDoor);

  /* 洗手间（走廊北头伸出 7 米）：三面墙 + 小便池 + 洗手池 */
  const tN = zN + 7;
  wallZ(BD_X0, zN, tN, []); wallZOb(obList, BD_X0, zN, tN, []);
  wallZ(BD_X1, zN, tN, []); wallZOb(obList, BD_X1, zN, tN, []);
  wallX(tN, BD_X0, BD_X1, []); wallXOb(obList, tN, BD_X0, BD_X1, []);
  { /* 洗手间地面 */
    const tf = new THREE.Mesh(new THREE.PlaneGeometry(BD_X1 - BD_X0, 7), mat(0x1f232b, { roughness: 0.9 }));
    tf.rotation.x = -Math.PI / 2; tf.position.set(cx, 0, (zN + tN) / 2); scene.add(tf);
  }
  box(0.7, 1.0, 0.12, 0xe8ecf2, BD_X0 + 1.0, 0.5, tN - 0.25, scene);   /* 小便池 */
  box(0.9, 0.85, 0.1, 0xcfd6e2, BD_X1 - 1.0, 0.42, zN + 0.3, scene);   /* 洗手池 */

  /* 楼梯间（走廊南头伸出 7 米）：三面墙 + 一块台阶标记 */
  const tS = zS - 7;
  wallZ(BD_X0, tS, zS, []); wallZOb(obList, BD_X0, tS, zS, []);
  wallZ(BD_X1, tS, zS, []); wallZOb(obList, BD_X1, tS, zS, []);
  wallX(tS, BD_X0, BD_X1, smallDoor); wallXOb(obList, tS, BD_X0, BD_X1, smallDoor);
  { /* 楼梯间地面 */
    const sf = new THREE.Mesh(new THREE.PlaneGeometry(BD_X1 - BD_X0, 7), mat(0x1f232b, { roughness: 0.9 }));
    sf.rotation.x = -Math.PI / 2; sf.position.set(cx, 0, (tS + zS) / 2); scene.add(sf);
  }
  box(2.6, 0.32, 2.2, 0x3a4150, cx, 0.16, (tS + zS) / 2, scene);      /* 台阶 */

  /* 电梯间（1F 楼梯间再往南伸 7 米，安检通过后落到这里） */
  if (ground){
    const tE = tS - 7;
    wallZ(BD_X0, tE, tS, []); wallZOb(obList, BD_X0, tE, tS, []);
    wallZ(BD_X1, tE, tS, []); wallZOb(obList, BD_X1, tE, tS, []);
    wallX(tE, BD_X0, BD_X1, []); wallXOb(obList, tE, BD_X0, BD_X1, []);
    const ef = new THREE.Mesh(new THREE.PlaneGeometry(BD_X1 - BD_X0, 7),
      mat(0x1d2128, { roughness: 0.92 }));
    ef.rotation.x = -Math.PI / 2; ef.position.set(cx, 0, (tE + tS) / 2); scene.add(ef);
    /* 电梯双开门（贴南墙）+ 上梁 + 指示灯 */
    box(1.7, DOOR_H, 0.08, 0x8a93a6, cx, DOOR_H / 2, tE + 0.04, scene, { metalness: 0.5, roughness: 0.35 });
    box(2.2, 0.26, 0.30, 0x3a4150, cx, 2.6, tE + 0.02, scene);
    const led = new THREE.Mesh(getSphereGeo(0.06, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0x33ff88 }));
    led.position.set(cx + 0.9, 2.4, tE + 0.16); scene.add(led);
  }

  /* 两间考场 */
  rooms.forEach((r, ri) => {
    const clsCenterX = BD_X1 + CLS_HW;        /* 教室中心 x = 21（面宽 2*CLS_HW=16） */
    const eastX = BD_X1 + CLS_HW * 2;         /* 教室东墙 x = 29 */
    const zn = r.cz + CLS_HD, zs = r.cz - CLS_HD;
    const n = r.name;

    /* 地面 + 天花板 */
    const f = new THREE.Mesh(new THREE.PlaneGeometry(CLS_HW * 2, CLS_HD * 2),
      mat(0x23272f, { roughness: 0.96 }));
    f.rotation.x = -Math.PI / 2; f.position.set(clsCenterX, 0, r.cz); scene.add(f);
    const c = new THREE.Mesh(new THREE.PlaneGeometry(CLS_HW * 2, CLS_HD * 2),
      mat(0x171b23, { roughness: 1.0 }));
    c.rotation.x = Math.PI / 2; c.position.set(clsCenterX, ROOM_H, r.cz); scene.add(c);

    /* 东墙 + 南北墙（西墙就是走廊东墙，上面有门洞） */
    wallZ(eastX, zs, zn, []); wallZOb(obList, eastX, zs, zn, []);
    wallX(zn, BD_X1, eastX, []); wallXOb(obList, zn, BD_X1, eastX, []);
    wallX(zs, BD_X1, eastX, []); wallXOb(obList, zs, BD_X1, eastX, []);

    /* 门牌（挂在西墙门边，朝走廊） */
    const sign = makeCanvas(128, 64);
    sign.ctx.fillStyle = '#23272f'; sign.ctx.fillRect(0, 0, 128, 64);
    sign.ctx.fillStyle = '#e8ecf2'; sign.ctx.font = 'bold 40px "Microsoft YaHei"';
    sign.ctx.textAlign = 'center'; sign.ctx.fillText(n, 64, 46);
    const signMesh = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.8),
      new THREE.MeshBasicMaterial({ map: canvasTex(sign.c, true), side: THREE.DoubleSide }));
    signMesh.position.set(BD_X1 + 0.02, 2.3, r.cz); signMesh.rotation.y = Math.PI / 2;
    scene.add(signMesh);

    /* 教室门：西墙（走廊东墙）的门洞处，铰链在北沿，朝教室内摆开 */
    const dg = makeDoorGroup(BD_X1, r.cz - DOOR_W / 2);
    registerClassroomDoor(n, dg, 1.5, [areaKey],
      [{ area: areaKey, x: BD_X1, z: r.cz, hw: BD_WALL, hd: doorHalf }]);

    /* 座位：靠西墙一列；学生朝 +z 坐（面朝"黑板"的一侧，纯装饰） */
    const seatCount = r.seats;
    for (let i = 0; i < seatCount; i++){
      const sx = BD_X1 + 2.2 + i * 2.4;
      const sz = r.cz - 2 + i * 2.0;
      buildDesk(sx, sz, false);
      obList.push({ x: sx, z: sz, hw: 0.92, hd: 0.45 });
      const p = buildPerson(sx, sz + 0.92, 0x4a5a7a, Math.PI);
      p.userData = {
        name: FOREIGN_NAMES[ri * 3 + i] || ('同学' + (ri + 1) + '-' + (i + 1)),
        roomName: n, seatX: sx, seatZ: sz + 0.92,
        state: 'seated', anger: 0, baseRot: Math.PI
      };
      foreignNpcs.push(p);
    }
  });
}

/* ---- 总入口：一次性建完 1F 与 2F 的几何 + 障碍清单 ---- */
function buildBuildingArea(){
  for (const fl of FLOORS){
    const list = fl.ground ? hallObstacles1f : hallObstacles2f;
    buildFloor(fl.zOff, fl.ground, fl.rooms, list, fl.areaKey);
  }
  /* 404 教室门：复用 world.js 的 doorGroup（东墙那扇）。它横跨 room / hall1，
     所以有两个 blocker。闭态 rotation 记作它的初始值，开态朝房间里摆开。 */
  if (doorGroup){
    registerClassroomDoor('404', doorGroup, -1.6, ['room', 'hall1'], [
      { area: 'room',  x: ROOM_W / 2 + 0.5, z: 0, hw: 0.5,    hd: DOOR_W / 2 + 0.05 },
      { area: 'hall1', x: BD_X0,            z: 0, hw: BD_WALL, hd: DOOR_W / 2 + 0.05 }
    ]);
  }
}

/* 切进 hall1 / hall2 时整体重放障碍（和 registerRoomObstacles 同款约定） */
function registerHallObstacles(floor){
  obstacles.length = 0;
  const list = (floor === 2) ? hallObstacles2f : hallObstacles1f;
  for (const o of list) obstacles.push(o);
  registerDoorBlockers(floor === 2 ? 'hall2' : 'hall1');
}

/* ---- 安检后瞬移进电梯间（1F 南端，楼梯间再往南） ---- */
function teleportToElevatorLobby(){
  switchArea('hall1');
  state.pos.set(10.5, 1.65, -31.5);
  state.yaw = 0; state.pitch = 0; yawTarget = 0; pitchTarget = 0;
  toast('电梯门打开，你走进了教学楼。', 2000);
}

function currentFloorZ(){
  return state.area === 'hall2' ? FL2_Z : 0;
}

/* ---- 外班同学：坐下发呆 / 被干扰 ---- */
function updateForeignNpcs(worldDt, t){
  for (const n of foreignNpcs){
    if (!n.userData) continue;
    const ortho = Math.sin(t * 6 + n.phase) * 0.06;
    n.armL.rotation.x = ortho;
    n.armR.rotation.x = -ortho;
    n.head.rotation.x = Math.sin(t * 3 + n.phase) * 0.05;
    n.group.rotation.y += (n.userData.baseRot - n.group.rotation.y) * Math.min(1, worldDt * 4);
  }
}

function disturbForeignNpc(i){
  const n = foreignNpcs[i];
  if (!n || !n.userData || n.userData.state !== 'seated') return;
  if (state.view !== 'world' || state.ended || state.frozen) return;

  const ud = n.userData;
  ud.anger++;
  state.mischief++;
  audio.beep(280 + Math.random() * 200, 0.08, 0.04);
  audio.beep(180, 0.12, 0.05, 'triangle');

  const dx = state.pos.x - n.group.position.x;
  const dz = state.pos.z - n.group.position.z;
  n.group.rotation.y = Math.atan2(dx, dz);
  n.head.rotation.x = -0.35;
  setTimeout(() => { if (n.head) n.head.rotation.x = 0; }, 350);

  const line = FOREIGN_LINES[Math.min(ud.anger - 1, FOREIGN_LINES.length - 1)];
  toast(ud.roomName + ' 教室 · ' + ud.name + '：“' + line + '”', 1900);

  if (state.mischief >= 5) unlockAch('hall_mischief');

  if (ud.anger >= 3){
    ud.anger = 0;
    toast(ud.name + ' 冲出座位去喊本考场的监考老师了……', 2400);
    /* 只要你在外场捣蛋到惊动别人，老师就一定被招来 ——
       洗手间许可也保不住你。 */
    enterTeacherChase();
  }
}

/* ---- 区域切换：从 404 走出走廊 / 从走廊走回 404 ---- */
function checkBuildingDoors(){
  if (state.view !== 'world' || !state.started || state.ended || state.frozen) return;

  if (state.area === 'room'){
    /* 穿过 404 东墙门洞 → 走廊 */
    if (state.pos.x > BD_X0 + 0.2){
      switchArea('hall1');
      state.pos.x = BD_X0 + 0.4;
      if (state.bathroomApproved){
        toast('你拿着洗手间许可走出了考场。', 1800);
      } else {
        if (!state.leftRoomOnce){ state.leftRoomOnce = true; unlockAch('escape'); }
        enterTeacherChase();
      }
    }
  } else if (state.area === 'hall1'){
    /* 从走廊走回 404 门洞 */
    if (state.pos.x < BD_X0 - 0.2 && Math.abs(state.pos.z) < 1.0){
      switchArea('room');
      state.pos.x = BD_X0 - 0.4;
      state.bathroomApproved = false;      /* 一进一回，洗手间许可用完了 */
      stopTeacherChase();
      /* 第一次走进 404 才是真正"进入考场"：开考时钟在这儿启动 */
      if (!state.enteredRoom){
        state.enteredRoom = true;
        beginExamClock();
        toast('CSP-S 2026 · 比赛开始。祝你 AK。', 2600);
        unlockAch('classroom');
      }
    }
  }
}

/* ---- 楼梯传送（1F 与 2F 之间） ---- */
function stairsTeleport(){
  if (state.area === 'hall1'){
    switchArea('hall2');
    state.pos.set(10.5, 1.65, FL2_Z - 23.5);
    toast('你走上了楼梯，来到二楼。', 1800);
  } else if (state.area === 'hall2'){
    switchArea('hall1');
    state.pos.set(10.5, 1.65, -23.5);
    toast('你走下楼梯，回到一楼。', 1800);
  } else return;

  state.yaw = 0; state.pitch = 0; yawTarget = 0; pitchTarget = 0;
  /* 只有老师本就在追时才跟着挪到这一层；没在追（例：已获洗手间许可）就留在原地 */
  if (teacher && teacher.userData.mode === 'chase') relocateTeacherToFloor();
  audio.beep(520, 0.08, 0.05);
  setTimeout(() => audio.beep(660, 0.08, 0.05), 90);
}

/* ---- 洗手间：站在便池前按 E ---- */
function tryUseBathroom(){
  if (state.view !== 'world' || state.ended || state.frozen) return;
  startBathroom();
}

/* ---- 本区域的交互判定（供 interact.js 在 hall1/hall2 时调用） ---- */
function hallInteract(){
  const zOff = currentFloorZ();

  /* 0. 教室门（开门/关门）—— 优先级最高，别被"干扰同学"抢走 */
  if (doorInteractPrompt()) return;

  /* 1. 干扰外班同学 */
  for (let i = 0; i < foreignNpcs.length; i++){
    const n = foreignNpcs[i];
    if (!n.userData || n.userData.state !== 'seated') continue;
    const d = Math.hypot(state.pos.x - n.group.position.x, state.pos.z - n.group.position.z);
    if (d < NPC_DISTURB_RANGE){
      actionF = { fn: () => disturbForeignNpc(i) };
      setPrompt('[ F ] 干扰 ' + n.userData.roomName + ' 的 ' + n.userData.name);
      promptEl.classList.remove('hidden');
      return;
    }
  }

  /* 2. 洗手间（北头） */
  const bathX = 10.5, bathZ = zOff + 25;
  if (Math.hypot(state.pos.x - bathX, state.pos.z - bathZ) < 1.6){
    actionE = { fn: tryUseBathroom };
    setPrompt('[ E ] 使用洗手间');
    promptEl.classList.remove('hidden');
    return;
  }

  /* 3. 楼梯间（南头） */
  const stairZ = (state.area === 'hall2') ? FL2_Z - 23.5 : -23.5;
  if (Math.hypot(state.pos.x - 10.5, state.pos.z - stairZ) < 1.6){
    actionF = { fn: stairsTeleport };
    setPrompt(state.area === 'hall2' ? '[ F ] 下楼（回一楼）' : '[ F ] 上楼（去二楼）');
    promptEl.classList.remove('hidden');
    return;
  }
}