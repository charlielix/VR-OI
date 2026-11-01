'use strict';
/* =========================================================================
   pickups —— 场景里的补给：固定补给点 + 保安掉落
   ---------------------------------------------------------------------
   先说清这一层为什么存在，因为"加补给"很容易变成往不存在的缺口里填东西：

     · 战斗**不缺资源**。一拳一个保安，punchGuardsArc 还是范围扫，
       保安抓到只掉 1 格血且有 1 秒无敌帧。真按资源算，3 瓶臭水绰绰有余。
     · 所以补给不设计成"续命"，它解决的是另外两件事：
         1. 物品栏一开局就给齐，用光就是空的 —— 一套一次性的东西
            配一场 200 只的连战，中间没有任何获取节奏，打起来是一条直线。
         2. 考场里没有任何"值得走过去"的地面物件。
            捡补给要离开座位，而离开座位是要拿违纪次数换的 ——
            这才让"打不打老师"这个选择多一层成本。

   拾取不设按键：走进 PICKUP_RADIUS 就自动进包。战斗正在进行时再要求
   低头对准一个小瓶子做拾取判定，纯粹是给手添活，不是难度。
   ========================================================================= */

const PICKUP_RADIUS = 0.75;    /* 走进这个距离自动捡起 */
const PICKUP_CAP = 24;         /* 场上最多同时躺几个（防 200 连战堆成山） */

/* 三个固定补给点。坐标是挑出来的，不是随手写的：
   每一个都必须站得到 —— 不在桌椅/墙/饮水机的碰撞体里，
   也不在只有贴着墙才够得着的缝里。smoke 里有一条断言逐个验证这件事，
   所以以后改考场布局，摆歪了会立刻报出来。 */
const PICKUP_SPOTS = [
  { id: 'water', x: -5.8, z:  4.8, n: 1 },   /* 饮水机旁的纸杯 */
  { id: 'spicy', x:  0.0, z: -5.5, n: 1 },   /* 后排空位上的书包 */
  { id: 'stink', x:  6.4, z: -5.6, n: 1 },   /* 窗台下的备用瓶 */
  /* 两把武器躺在这里。扫把不在这张表里 —— 它挂在员工通道那扇门上，
     只有从侧门溜进来的人才拿得到（见 campus.js 的 enterSideDoor）。 */
  { id: 'mop',   x: -6.2, z: -5.2, n: 1 },   /* 后墙角落里立着的拖把 */
  { id: 'stool', x:  6.2, z:  3.6, n: 1 }    /* 窗边多出来的那张板凳 */
];

/* 掉落节奏：第 3 个保安掉臭水、第 5 个掉矿泉水。
   用"第 n 个"而不是随机 —— 随机掉落没法写断言，
   而这种固定节奏玩起来是有呼吸的：每三个换一次控场，每五个换一次血。 */
const DROP_EVERY_STINK = 3, DROP_EVERY_WATER = 5;

const pickups = [];
let pickupsPlaced = false;

/* '#8fb04a' → 0x8fb04a。颜色只在 ITEMS 里写一份，这里不重复定义。 */
function itemTint(id){
  const it = ITEMS[id];
  return it ? parseInt(it.color.slice(1), 16) : 0xffffff;
}

function addPickup(id, x, z, n){
  if (!ITEMS[id] || !scene) return null;
  /* 超量时先收掉最老的：200 连战会掉几十个，无限堆下去既占内存也糊画面 */
  while (pickups.length >= PICKUP_CAP) removePickup(0);

  const tint = itemTint(id);
  const g = new THREE.Group();
  g.position.set(x, 0, z);

  const body = new THREE.Mesh(getBoxGeo(0.16, 0.26, 0.16),
    mat(tint, { roughness: 0.42, metalness: 0.12,
                emissive: tint, emissiveIntensity: 0.32 }));
  body.position.y = 0.20;
  g.add(body);

  const cap = new THREE.Mesh(getSphereGeo(0.075, 8, 6),
    mat(0xdfe6f2, { roughness: 0.5 }));
  cap.position.y = 0.36;
  g.add(cap);

  scene.add(g);
  /* 相位按入列顺序取，不用 Math.random —— 场景物件的位置不该随机，
     而且随机相位会让"同一帧两张截图对不上"，排查时白费时间。 */
  pickups.push({ mesh: g, x: x, z: z, id: id, n: n, phase: pickups.length * 1.7 });
  return pickups[pickups.length - 1];
}

function removePickup(i){
  const p = pickups[i];
  if (!p) return;
  scene.remove(p.mesh);
  pickups.splice(i, 1);
}

/* 进房间时铺一次。幂等：switchArea 每次切区域都会调，不能重复铺。 */
function ensurePickups(){
  if (pickupsPlaced) return;
  pickupsPlaced = true;
  for (const s of PICKUP_SPOTS) addPickup(s.id, s.x, s.z, s.n);
}

/* 打死保安掉补给。位置钳进房间内侧，掉在墙上就永远捡不到。 */
function maybeDropFromGuard(kills, x, z){
  const inX = clamp(x, -7.2, 7.2), inZ = clamp(z, -6.2, 6.2);
  if (kills % DROP_EVERY_STINK === 0){ addPickup('stink', inX, inZ, 1); return 'stink'; }
  if (kills % DROP_EVERY_WATER === 0){ addPickup('water', inX, inZ, 1); return 'water'; }
  return '';
}

function updatePickups(dt, t){
  const canGrab = state.view === 'world' && state.area === 'room'
                  && state.started && !state.ended && !state.frozen;

  for (let i = pickups.length - 1; i >= 0; i--){
    const p = pickups[i];
    /* 轻微浮沉 + 自转：灰地板上要一眼看得出那是个能捡的东西 */
    p.mesh.position.y = Math.sin(t * 2.2 + p.phase) * 0.03;
    p.mesh.rotation.y += dt * 1.1;

    if (!canGrab) continue;
    if (Math.hypot(state.pos.x - p.x, state.pos.z - p.z) > PICKUP_RADIUS) continue;

    const barBefore = state.hotbar.slice();
    const added = bagAdd(p.id, p.n);
    /* 背包满了就留在地上，不凭空蒸发 —— 玩家看见东西消失却没进包最恼人 */
    if (!added) continue;

    /* 如果挤掉了快捷栏上的东西，顺口说一句换下了什么。
       但绝不要求玩家做任何操作 —— 战斗正打到一半，
       "按 B 装上去"这种提示等于说这件东西现在用不了。 */
    const idx = state.hotbar.indexOf(p.id);
    let tail = '';
    if (idx >= 0 && barBefore.indexOf(p.id) < 0 && barBefore[idx]){
      tail = '（换下了「' + ITEMS[barBefore[idx]].name + '」）';
    }
    toast('捡到「' + ITEMS[p.id].name + '」×' + added + tail, tail ? 2200 : 1200);
    audio.beep(720, 0.06, 0.045, 'sine');
    removePickup(i);
  }
}
