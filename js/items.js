'use strict';
/* =========================================================================
   items —— 物品 / 物品栏（快捷栏） / 背包
   ---------------------------------------------------------------------
   三层分开，别混：
     · ITEMS         物品定义表：名字、字形、颜色、怎么用。纯数据。
     · state.bag     持有列表 [{ id, n }]  —— 你「有什么」
     · state.hotbar  快捷栏 4 格（物品 id） —— 你「能快速按到什么」

   为什么不合成一个数组：背包管的是数量，快捷栏管的是摆位。
   混在一起写，捡到第二瓶臭水的那一刻就会把玩家自己摆好的快捷栏覆盖掉。
   顺带一个必须处理的情况：某一格的东西用完了，要把它从快捷栏摘掉 ——
   否则按 Q 会打到一个"看得见但按不出来"的空槽。
   ========================================================================= */

const HOTBAR_SLOTS = 4;

/* 臭水：投掷。落点周围一片，保安蹲下干呕，这期间不追人也不抓人。 */
const STINK_THROW  = 5.0;    /* 扔出去多远（米） */
const STINK_RADIUS = 2.6;    /* 落点多大范围会被熏到 */
const STINK_STUN   = 2.6;    /* 干呕多久（秒，世界时钟 —— 慢放时一起慢） */

/* 辣条：只有疾走才加速，走路不变 —— 描述里写的就是"疾走快三成"。 */
const SPICY_TIME  = 6;
const SPICY_BOOST = 1.35;

const ITEMS = {
  stink: {
    name: '臭水', glyph: '臭', color: '#8fb04a', kind: '武器', stack: 9,
    desc: '一瓶放了三天的淘米水。扔出去，落点周围 ' + STINK_RADIUS +
          ' 米内的保安全蹲下干呕 ' + STINK_STUN + ' 秒 —— 拳头这时候才够得着。',
    use: throwStinkWater
  },
  water: {
    name: '矿泉水', glyph: '矿', color: '#5bc8ff', kind: '补给', stack: 9,
    desc: '喝一口回一格血。前提是你已经有血条 —— 挨过打的人才存得住水。',
    use: drinkMineralWater
  },
  spicy: {
    name: '辣条', glyph: '辣', color: '#ff6b4a', kind: '补给', stack: 9,
    desc: '边跑边嚼，' + SPICY_TIME + ' 秒内疾走快 ' +
          Math.round((SPICY_BOOST - 1) * 100) + '%。考试周的主要能源。',
    use: eatSpicyStrip
  },
  /* 手机。它不是消耗品 —— 用一次不会少一台，所以 keep: true。
     过安检会从背包里真的拿走（bagTake），不是只改一个布尔量。
     use 必须写成箭头函数：usePhoneItem 定义在后加载的 phone.js 里，
     而 function 声明只在自己文件内提升 —— 直接写 `use: usePhoneItem`
     会在 items.js 加载的那一刻就抛 ReferenceError（真踩过）。 */
  phone: {
    name: '手机', glyph: '机', color: '#7aa2ff', kind: '杂物', stack: 1, keep: true,
    desc: '没被安检收走才留得下来的东西。按 P 掏出来：战况 / 群聊 / 2048 / 计算器。' +
          '想用 Q 打开的话，先按 B 把它指派到快捷栏。被监考看见就要没收。',
    use: () => usePhoneItem()
  },

  /* ---- 武器 ----
     空手拳锋 2.2m / 半角 0.4 rad。武器加的是 reach（够得更远）和 arc（扫得更宽），
     外加 uses（耐久）：抡断了就散架，包里的东西才不是永久神装。
     三把凑成一个取舍三角：扫把中庸、拖把最长但扫得窄、板凳最短但扫得最宽最耐。
     和 phone 一样标 keep：不消耗、不自动上快捷栏 —— 要靠 B 自己指派到某一格，
     否则一进背包就会把摆好的消耗品挤掉。
     use 都是箭头函数：punchGuardsArc 在更晚加载的 combat.js 里。 */
  broom: {
    name: '扫把', glyph: '帚', color: '#c8a165', kind: '武器', stack: 1, keep: true, melee: true,
    reach: 1.1, arc: 0.55, uses: 14, knock: 1.6, power: 5.4,
    desc: '员工通道里那根。拳锋多够 1.1 米 —— 保安的拳头够不着你，你的扫把够得着他；' +
          '半角也放宽了，竖着抡能扫到两个，没倒的还会被推开。抡 14 下散架。',
    use: () => punchGuardsArc()
  },
  mop: {
    name: '拖把', glyph: '拖', color: '#6fa8c8', kind: '武器', stack: 1, keep: true, melee: true,
    reach: 1.4, arc: 0.45, uses: 10, knock: 2.0, power: 6.0,
    desc: '考场后面立着的那把。三把里够得最远（+1.4 米）、推得最狠，' +
          '但杆重、扫得窄，正面一对一时最稳。抡 10 下散架。',
    use: () => punchGuardsArc()
  },
  stool: {
    name: '板凳', glyph: '凳', color: '#8a7a5a', kind: '武器', stack: 1, keep: true, melee: true,
    reach: 0.7, arc: 0.75, uses: 22, knock: 1.2, power: 6.8,
    desc: '窗边多出来的那张。够得不算远，但半角接近直角 —— 被围住时抡一圈就是一片，' +
          '砸下去最沉，被打倒的会飞出去。而且它结实：抡 22 下才散。',
    use: () => punchGuardsArc()
  }
};

/* ---------------------------- 持有列表 ---------------------------- */
/* 装备那把近战武器（'' = 收起）。
   武器**不进快捷栏**：快捷栏是消耗品（Q），左键永远抡手上这件。
   这样打架时不用来回切格 —— 那个"来回切换严重影响效率"就是从这里来的。 */
function equipWeapon(id){
  const it = id ? ITEMS[id] : null;
  state.weapon = (it && it.melee) ? id : '';
  return state.weapon;
}

function bagCount(id){
  const e = state.bag.find(x => x.id === id);
  return e ? e.n : 0;
}

/* 快捷栏必须是定长 4 格、且同一个物品只占一格。
   这是"捡到的东西一定放得下"的前提：物品只有 3 种，4 格不重复就永远空着一格，
   于是 hotbarAutoPlace 在正常游戏里走不到"没地方放"那一支。
   不信任外部数据（存档、旧版本）时，用这个把不变式重做一遍。 */
function normalizeHotbar(raw){
  const out = new Array(HOTBAR_SLOTS).fill('');
  let w = 0;
  for (let i = 0; i < Math.min(HOTBAR_SLOTS, (raw || []).length); i++){
    const id = raw[i];
    if (!id || !ITEMS[id]) continue;
    if (out.indexOf(id) >= 0) continue;        /* 同一个物品只占一格 */
    out[w++] = id;
  }
  return out;
}

/* 捡到 / 收到的东西必须立刻能用：这件物品不在快捷栏上，就塞进第一个空格。
   少这一句会有一个很难受的效果：用光一摞之后 bagTake 会把格子清空，
   再捡到同一种东西时背包里确实有，快捷栏却还是空的 ——
   提示说"捡到了"，玩家看不见、按 Q 也只得到一句"这一格是空的"。
   返回放进第几格；已经挂在某格上（或没有空格）返回 -1。 */
function hotbarAutoPlace(id){
  /* keep 的东西（手机 / 武器）不自动上快捷栏：
     它们是长驻物品，要靠玩家自己按 B 指派。自动塞进去只会把摆好的消耗品挤掉，
     而且会把"4 格 / 3 种补给永远空着一格"这条不变式顶破。 */
  if (ITEMS[id] && ITEMS[id].keep) return -1;
  if (state.hotbar.indexOf(id) >= 0) return -1;
  let i = state.hotbar.indexOf('');
  /* 兜底：按 normalizeHotbar 上面的道理，正常玩到不了这里。
     真到了也**绝不能**提示"按 B 装上去" —— 战斗正在进行，
     让玩家开面板整理物品，等于告诉他这件东西现在用不了。
     把当前选中的那一格让出来：新的先进得去，马上按 Q 就能用。 */
  if (i < 0) i = clamp(state.hotbarIdx | 0, 0, HOTBAR_SLOTS - 1);
  state.hotbar[i] = id;
  return i;
}

function bagAdd(id, n){
  const it = ITEMS[id];
  if (!it || n <= 0) return 0;
  let e = state.bag.find(x => x.id === id);
  if (!e){ e = { id: id, n: 0 }; state.bag.push(e); }
  const add = Math.min(Math.max(0, it.stack - e.n), n);
  e.n += add;
  if (add > 0){
    /* 近战武器：捡到就直接上手（不占快捷栏）。这是"装备"的全部动作 ——
       捡起来那一刻就已经能抡了，不用再去背包里指派一格。 */
    if (it.melee) equipWeapon(id);
    else hotbarAutoPlace(id);
  }
  renderHotbar();
  return add;
}

function bagTake(id, n){
  const e = state.bag.find(x => x.id === id);
  if (!e || e.n < n) return false;
  e.n -= n;
  if (e.n <= 0){
    state.bag.splice(state.bag.indexOf(e), 1);
    /* 用完就从快捷栏摘掉：留着会变成一个按不出来的空槽 */
    for (let i = 0; i < state.hotbar.length; i++){
      if (state.hotbar[i] === id) state.hotbar[i] = '';
    }
    /* 武器没了就空手 —— 否则 heldWeaponId 会一直指着已经不在包里的东西 */
    if (state.weapon === id) state.weapon = '';
  }
  renderHotbar();
  return true;
}

/* 开局带的东西：保安查了手机，没查你的包。 */
function initBag(){
  state.bag = [];
  state.hotbar = ['stink', 'water', 'spicy', ''];
  state.hotbarIdx = 0;
  state.spicyUntil = 0;
  bagAdd('stink', 3);
  bagAdd('water', 2);
  bagAdd('spicy', 2);
  /* 手机也在兜里，但**只进背包、不占快捷栏**（keep ⇒ hotbarAutoPlace 会跳过它）：
     快捷栏必须一直空着一格 —— 那是 hotbarAutoPlace 永远不会失败的前提。
     手机默认用 P 打开；想按 Q 用，可以按 B 从背包里把它指派到某一格。 */
  bagAdd('phone', 1);
  state.hasPhone = true;
  renderHotbar();
}

/* ---------------------------- 使用 ---------------------------- */
/* 用掉当前选中的物品。
   返回值是"到底用掉了没有" —— 测试直接看这个，别去看快捷栏数字变没变：
   用掉了但格子还占着、或者没用到却减了数量，都是要当场抓住的 bug。 */
function useSelectedItem(){
  if (state.view !== 'world' || state.ended || state.frozen) return false;
  const id = state.hotbar[state.hotbarIdx];
  if (!id){ toast('这一格是空的。', 1100); return false; }
  const it = ITEMS[id];
  if (!it) return false;
  if (bagCount(id) <= 0){ toast('没有了。', 1100); return false; }
  if (it.use() === false) return false;      /* 物品自己说"这次用不上" */
  /* keep: true 的东西不消耗 —— 手机用一次不会少一台。
     别的物品照旧用一次扣一个。 */
  if (!it.keep) bagTake(id, 1);
  return true;
}

function throwStinkWater(){
  const from = new THREE.Vector3(state.pos.x, PLAYER_EYE - 0.14, state.pos.z);
  const dir = new THREE.Vector3(
    -Math.sin(state.yaw) * Math.cos(state.pitch),
     Math.sin(state.pitch),
    -Math.cos(state.yaw) * Math.cos(state.pitch)
  );
  const to = from.clone().addScaledVector(dir, STINK_THROW);

  fxBottle(from, to);
  audio.beep(520, 0.07, 0.05, 'triangle');

  /* 判定用"扔出去的落点"，不是"玩家脚下"：
     站在门口往前扔能熏到 3 米外的保安，这才是投掷武器该有的手感。 */
  const victims = stinkVictims(to, STINK_RADIUS);
  for (const g of victims) g.userData.stinkUntil = state.worldTime + STINK_STUN;

  if (victims.length > 1){
    toast('一瓶臭水泼了 ' + victims.length + ' 名保安一脸。', 1900);
  } else if (victims.length === 1){
    toast('正中保安的脸 —— 他弯下腰开始干呕。', 1900);
  } else {
    toast('臭水摔在地上，味道飘出去老远。', 1600);
  }
  return true;
}

function stinkVictims(center, r){
  const out = [];
  for (const g of securityGuards){
    if (!g.userData.alive) continue;
    const d = Math.hypot(g.group.position.x - center.x, g.group.position.z - center.z);
    if (d <= r) out.push(g);
  }
  return out;
}

function drinkMineralWater(){
  if (!state.hpVisible){
    toast('还没上血条，喝下去也存不住 —— 先挨一下再说。', 2100);
    return false;
  }
  if (state.hp >= HP_MAX){
    toast('血是满的，留着吧。', 1400);
    return false;
  }
  state.hp++;
  renderHp();
  audio.beep(640, 0.08, 0.05, 'sine');
  setTimeout(() => audio.beep(760, 0.10, 0.04, 'sine'), 90);
  toast('咕咚咕咚 —— 回了一格血。', 1500);
  return true;
}

function eatSpicyStrip(){
  state.spicyUntil = state.worldTime + SPICY_TIME;
  audio.beep(300, 0.06, 0.05, 'square');
  toast('嘶 —— 辣得你想跑。' + SPICY_TIME + ' 秒内疾走快 ' +
        Math.round((SPICY_BOOST - 1) * 100) + '%。', 2000);
  return true;
}

/* ---------------------------- 投掷物 / 臭气云 ---------------------------- */
/* 自己管生命周期，main.js 每帧调 updateItemFx(realDt)。
   不往 debris.js 塞：那是"尸块"，物理和寿命都不一样，混在一起两头都变脏。 */
const itemFx = [];

function fxBottle(from, to){
  if (!scene) return;
  const m = new THREE.Mesh(getSphereGeo(0.09, 8, 6), mat(0x6f7d3a, { roughness: 0.45 }));
  m.position.copy(from);
  scene.add(m);
  itemFx.push({ kind: 'bottle', mesh: m, age: 0, life: 0.22,
                from: from.clone(), to: to.clone() });
}

function fxPuff(at){
  if (!scene) return;
  /* 这个材质不进 mat() 缓存 —— 它每帧都要单独改 opacity 并销毁 */
  const mm = new THREE.MeshBasicMaterial({
    color: 0x8fb04a, transparent: true, opacity: 0.62, depthWrite: false
  });
  const m = new THREE.Mesh(getSphereGeo(1, 12, 10), mm);
  m.position.copy(at);
  m.scale.setScalar(0.35);
  scene.add(m);
  itemFx.push({ kind: 'puff', mesh: m, age: 0, life: 1.5, mat: mm });
}

function updateItemFx(dt){
  for (let i = itemFx.length - 1; i >= 0; i--){
    const f = itemFx[i];
    f.age += dt;
    const k = Math.min(1, f.age / f.life);
    if (f.kind === 'bottle'){
      /* 手写分量插值，不用 lerpVectors/addScaledVector ——
         少依赖一个 Vector3 方法，无头测试的桩就不用跟着长（桩每缺一个方法
         都会变成一条"跑 300 帧不抛异常"的失败，排查成本远高于这里多写两行）。 */
      f.mesh.position.set(
        f.from.x + (f.to.x - f.from.x) * k,
        f.from.y + (f.to.y - f.from.y) * k + Math.sin(k * Math.PI) * 0.35,   /* 抛物线 */
        f.from.z + (f.to.z - f.from.z) * k
      );
      if (k >= 1){
        scene.remove(f.mesh);
        fxPuff(f.to);
        itemFx.splice(i, 1);
      }
    } else {
      f.mesh.scale.setScalar(0.35 + k * 1.35);
      f.mat.opacity = 0.62 * (1 - k);
      if (k >= 1){
        scene.remove(f.mesh);
        f.mat.dispose();
        itemFx.splice(i, 1);
      }
    }
  }
}

/* ---------------------------- 快捷栏 UI ---------------------------- */
function selectHotbar(i){
  if (i < 0 || i >= HOTBAR_SLOTS) return;
  state.hotbarIdx = i;
  renderHotbar();
}

function renderHotbar(){
  const el = $('hotbar');
  if (!el) return;
  /* 没开局、或者已经离场，就不该占着屏幕 */
  const show = !!state.started && !state.ended;
  el.classList.toggle('hidden', !show);
  if (!show) return;

  el.innerHTML = '';
  for (let i = 0; i < HOTBAR_SLOTS; i++){
    const id = state.hotbar[i];
    const it = id ? ITEMS[id] : null;
    const n = it ? bagCount(id) : 0;

    const d = document.createElement('div');
    d.className = 'slot' + (i === state.hotbarIdx ? ' sel' : '') + (n ? '' : ' empty');
    /* 格子上不写数字：数字键现在归弹窗选项用，写着"1"会被当成"按 1 选"。
       位置靠高亮 + 点击 + 滚轮表达就够了。 */
    d.innerHTML =
      (it ? '<span class="g" style="color:' + it.color + '">' + it.glyph + '</span>' : '') +
      (n ? '<span class="n">' + n + '</span>' : '');
    d.title = it ? (it.name + ' ×' + n) : '空';
    d.onclick = () => selectHotbar(i);
    el.appendChild(d);
  }
}

/* ---------------------------- 背包 UI ---------------------------- */
function openBag(){
  if (state.view !== 'world' || !state.started || state.ended || state.frozen) return;
  state.view = 'bag';
  crosshair.classList.add('hidden');
  promptEl.classList.add('hidden');
  releaseLock();
  $('bagUI').classList.remove('hidden');
  renderBag();
  renderHotbar();
  syncViewUI();
}

function closeBag(){
  $('bagUI').classList.add('hidden');
  state.view = 'world';
  crosshair.classList.remove('hidden');
  requestLock();
  flushLockHint();
}

/* 把物品放进当前选中的快捷栏格子。
   已经挂在别的格子上就交换 —— 这样快捷栏里永远不会出现同一个物品占两格，
   而"不重复"正是"永远留着一个空格给新捡到的东西"的前提。 */
function assignToHotbar(id){
  const i = state.hotbarIdx;
  const exist = state.hotbar.indexOf(id);
  if (exist === i) return;
  if (exist >= 0) state.hotbar[exist] = state.hotbar[i];
  state.hotbar[i] = id;
  renderHotbar();
  renderBag();
  const it = ITEMS[id];
  toast('「' + it.name + '」放到了第 ' + (i + 1) + ' 格。', 1300);
}

function renderBag(){
  const grid = $('bagGrid');
  const slots = $('bagSlots');
  if (!grid || !slots) return;

  /* 上半：快捷栏 4 格，点一下选当前要往哪格放 */
  slots.innerHTML = '';
  for (let i = 0; i < HOTBAR_SLOTS; i++){
    const id = state.hotbar[i];
    const it = id ? ITEMS[id] : null;
    const d = document.createElement('div');
    d.className = 'bslot' + (i === state.hotbarIdx ? ' sel' : '');
    d.innerHTML = '<b>' + (i + 1) + '</b>' +
                  (it ? '<span style="color:' + it.color + '">' + it.glyph + '</span>' : '·');
    d.onclick = () => { selectHotbar(i); renderBag(); };
    slots.appendChild(d);
  }

  /* 下半：持有的一切 */
  grid.innerHTML = '';
  if (!state.bag.length){
    const p = document.createElement('div');
    p.className = 'bagempty';
    p.textContent = '包是空的。';
    grid.appendChild(p);
  }
  for (const e of state.bag){
    const it = ITEMS[e.id];
    if (!it) continue;
    const d = document.createElement('div');
    d.className = 'bitem';
    d.innerHTML = '<span class="g" style="color:' + it.color + '">' + it.glyph + '</span>' +
                  '<span class="nm">' + it.name + '</span>' +
                  '<span class="ct">×' + e.n + '</span>' +
                  '<span class="kd">' + it.kind + '</span>';
    const desc = $('bagDesc');
    d.onmouseenter = () => { if (desc) desc.textContent = it.name + '：' + it.desc; };
    d.onclick = () => assignToHotbar(e.id);
    grid.appendChild(d);
  }
}

/* ---------------------------- 存档 ---------------------------- */
function bagSnapshot(){
  return {
    bag: state.bag.map(e => ({ id: e.id, n: e.n })),
    hotbar: state.hotbar.slice()
  };
}
function bagRestore(o){
  if (!o || !Array.isArray(o.bag)) return;
  /* 存档不能直接信：同一个 id 可能出现两条、数量可能超上限。
     不合并的话 bagCount 用 find 只看得见第一条 ——
     "明明有 5 瓶，用了 2 瓶就没了"，这种 bug 查起来极其费劲。 */
  const merged = new Map();
  for (const e of o.bag){
    if (!e || !ITEMS[e.id]) continue;
    const n = Math.max(0, e.n | 0);
    if (!n) continue;
    merged.set(e.id, Math.min(ITEMS[e.id].stack, (merged.get(e.id) || 0) + n));
  }
  state.bag = Array.from(merged, kv => ({ id: kv[0], n: kv[1] }));
  state.hotbar = normalizeHotbar(o.hotbar);
  renderHotbar();
}
