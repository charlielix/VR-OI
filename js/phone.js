'use strict';
/* =========================================================================
   phone —— 兜里的手机
   ---------------------------------------------------------------------
   开局就带在身上。走正门过安检会被封存（state.hasPhone = false）；
   从员工通道溜进楼则还在 —— 那才有得看。
   在考场里按 P 打开。三个"软件"：

     战况    每题得分 / 实时名次 / 剩余时间。HUD 上只有总分，
             看不出哪道题还欠着 —— 这是它最实用的一面。
     群聊    "考场交流群"。消息不是随机刷的：对手每交一题就冒一条，
             时间和名次都来自 rivals.js 的同一份数据。
     计算器  真的能算（只有四则和括号）。

   作弊有代价：老师那一眼（teacher.js 的 checkTeacherPeek）会看见你，
   手机当场没收，还记一次警告。
   ========================================================================= */

const PHONE_TABS = ['status', 'chat', 'game', 'calc'];
const PHONE_TAB_NAMES = { status: '战况', chat: '群聊', game: '2048', calc: '计算器' };

/* 群聊里那些不是对手的人。时间是比赛时钟（秒），写死以保证可复现。
   后面几位是友情客串 —— 台词都按人设现写，没有抄任何原作文本。
   放在固定时点上，所以会和对手的"交了第 N 题"自然穿插。 */
const PHONE_CHAT_FLAVOR = [
  { t: 6 * 60,  who: '志愿者 · 阿舟', text: '还没进场的抓紧，一会儿要关门了' },
  { t: 10 * 60, who: '凉宫春日',      text: '这个考场太没意思了。SOS 团现在开始研究第三题。' },
  { t: 15 * 60, who: '小明',          text: '第一题有人过了吗' },
  { t: 18 * 60, who: '黑猫',          text: '哼，这种水题也配让我动真格。' },
  { t: 25 * 60, who: '小红',          text: '别问了，写你的' },
  { t: 28 * 60, who: '蕾姆',          text: '蕾姆觉得……这位同学的代码，再改一点点就能过了。' },
  { t: 36 * 60, who: '桂木桂马',      text: '攻略之神也搞不定这组数据范围。' },
  { t: 40 * 60, who: '小刚',          text: '我可能要交了' },
  { t: 52 * 60, who: '哆啦A梦',       text: '四次元口袋里没有能把时间限制改大的道具啊……' },
  { t: 70 * 60, who: '志愿者 · 小林', text: '手机都收上去了吧？收上去就别再翻了' },
  { t: 78 * 60, who: '坂本',          text: '嘛，总会有办法的。' }
];

/* 只在"人在考场里、手机还在、没结束也没被冻住"时能掏出来 */
function canOpenPhone(){
  return state.hasPhone && state.area === 'room' &&
         !state.ended && !state.frozen;
}

function phoneClock(sec){
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return (h ? h + ':' : '') + String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
}

/* ---------------------------- 战况 ---------------------------- */
function phoneRenderStatus(){
  const problems = state.problems || [];
  let total = 0;
  const rows = problems.map(p => {
    const sc = (state.score && state.score[p.id]) || 0;
    total += sc;
    const cls = sc >= p.max ? 'ph-ok' : (sc > 0 ? 'ph-half' : 'ph-zero');
    return '<div class="ph-row"><span class="ph-name">' + p.name + '</span>' +
           '<span class="' + cls + '">' + sc + '<i>/' + p.max + '</i></span></div>';
  });
  phRows.innerHTML = rows.join('') ||
    '<div class="ph-row"><span class="ph-name">还没发卷</span><span class="ph-zero">—</span></div>';
  phTotal.textContent = total + ' 分';
  /* 只写"第 N 名"看不出差距：把榜首是谁、多少分一起摆出来，
     否则玩家永远不知道别人在涨。 */
  const board = rivalBoard(state.elapsed);
  const top = board[0];
  phRank.textContent = '第 ' + playerRank(state.elapsed) + ' / ' + rivalCount() + ' 名' +
    (top ? (top.me ? '　榜首是你' : '　榜首 ' + top.name + ' ' + top.score) : '');
}

/* 一打开群聊就置顶的那一句。
   它不按时间排 —— 按"你正在干什么"排：你在考场里掏手机，就有人正好这么问。
   所以它是 unshift 上去的，不能丢进时间序里（丢进去会被"最近 9 条"挤掉，
   而它的全部意义就是"一打开就看见"）。 */
const PHONE_CHAT_OPENER = { who: 'Cherry_Pop', text: '又在摸鱼呢？' };

/* ---------------------------- 群聊 ----------------------------
   消息全部由状态推出来：对手的交卷时间取自 rivalSubmitAt（和名次表同一份数据），
   所以"小红第一题交了"这条一定是真的，不会和榜单打架。 */
function phoneChatLines(){
  const out = [];
  const n = (state.problems || []).length;

  /* 你是从侧门进来的 —— 有人看见了。这条只有在 sneakedIn 时才出现 */
  if (state.sneakedIn)
    out.push({ t: 0, who: '匿名', text: '刚看见有人从员工通道上来了' });

  for (const name of Object.keys(RIVAL_PROFILE)){
    for (let i = 0; i < n; i++){
      const t = rivalSubmitAt(name, i);
      if (t > state.elapsed) continue;
      out.push({ t: t, who: name, text: '第 ' + (i + 1) + ' 题交了' });
    }
  }
  for (const f of PHONE_CHAT_FLAVOR){
    if (f.t <= state.elapsed) out.push({ t: f.t, who: f.who, text: f.text });
  }
  out.sort((a, b) => a.t - b.t || (a.who < b.who ? -1 : 1));
  const lines = out.slice(-9);   /* 客串多了之后 7 条会把对手的"交了"挤出去 */

  /* 置顶那句放在切片之后：它不属于时间轴，属于"你此刻的状态"。
     pinned 标记让渲染器不打印时间戳 —— 上面写着一个更晚的时刻、
     下面却是更早的消息，看起来像 bug。 */
  lines.unshift({ t: 0, who: PHONE_CHAT_OPENER.who, text: PHONE_CHAT_OPENER.text, pinned: true });
  return lines;
}

function phoneRenderChat(){
  const lines = phoneChatLines();
  phChatLog.innerHTML = lines.map(l => l.pinned
    ? '<div class="pn-msg pin"><span class="pn-who">' + l.who + '</span>' +
      '<div class="pn-text">' + l.text + '</div></div>'
    : '<div class="pn-msg"><span class="pn-who">' + l.who + '</span>' +
      '<span class="pn-when">' + phoneClock(l.t) + '</span>' +
      '<div class="pn-text">' + l.text + '</div></div>'
  ).join('') ||
    '<div class="pn-empty">群里还没有人说话。</div>';
  /* 滚到底：新消息在最下面 */
  phChatLog.scrollTop = phChatLog.scrollHeight;
}

/* ---------------------------- 2048 ----------------------------
   手机里唯一真能"玩"的东西。纯状态机：没有定时器、没有动画、不改入参，
   所以测试可以直接喂一个盘面进 g2048Move 断言合并结果。
   被监考看见的风险和其它软件一样 —— 它也算"在玩手机"。 */
const G2048_N = 4;
const G2048_COLORS = {
  0: '#181c24',   2: '#2b3a4d',   4: '#31536b',    8: '#2f6b6b',
  16: '#2f7f52',  32: '#3f8a3a',  64: '#7a8a2f',   128: '#a8812a',
  256: '#a8642a', 512: '#a8452a', 1024: '#8a3550', 2048: '#6b3f8a'
};

function g2048New(){
  return { cells: new Array(G2048_N * G2048_N).fill(0), score: 0, won: false, dead: false };
}

/* 往空格里放一个 2（九成）或 4（一成）。rng 可注入，测试要确定性。 */
function g2048Spawn(cells, rng){
  const empty = [];
  for (let i = 0; i < cells.length; i++) if (!cells[i]) empty.push(i);
  if (!empty.length) return false;
  const r = rng || Math.random;
  cells[empty[Math.floor(r() * empty.length)]] = r() < 0.9 ? 2 : 4;
  return true;
}

/* 一行挤到左边并合并，返回挤完的 4 格和这一步吃到的分。 */
function g2048Slide(line){
  const a = line.filter(v => v);
  const out = [];
  let gained = 0;
  for (let i = 0; i < a.length; i++){
    if (a[i] === a[i + 1]){ const v = a[i] * 2; out.push(v); gained += v; i++; }
    else out.push(a[i]);
  }
  while (out.length < G2048_N) out.push(0);
  return { out: out, gained: gained };
}

/* 按方向拆成 4 条"从移动方向看过去"的线，处理完写回。不改入参。 */
function g2048Move(cells, dir){
  const N = G2048_N;
  const out = cells.slice();
  let moved = false, gained = 0;
  for (let k = 0; k < N; k++){
    const idx = [];
    for (let j = 0; j < N; j++){
      let r, c;
      if (dir === 'left'){ r = k; c = j; }
      else if (dir === 'right'){ r = k; c = N - 1 - j; }
      else if (dir === 'up'){ r = j; c = k; }
      else { r = N - 1 - j; c = k; }
      idx.push(r * N + c);
    }
    const res = g2048Slide(idx.map(i => cells[i]));
    gained += res.gained;
    for (let j = 0; j < N; j++){
      if (out[idx[j]] !== res.out[j]) moved = true;
      out[idx[j]] = res.out[j];
    }
  }
  return { cells: out, moved: moved, gained: gained };
}

function g2048CanMove(cells){
  if (cells.indexOf(0) >= 0) return true;
  for (let r = 0; r < G2048_N; r++) for (let c = 0; c < G2048_N; c++){
    const v = cells[r * G2048_N + c];
    if (c + 1 < G2048_N && cells[r * G2048_N + c + 1] === v) return true;
    if (r + 1 < G2048_N && cells[(r + 1) * G2048_N + c] === v) return true;
  }
  return false;
}

function g2048Ensure(){
  if (!state.g2048){
    state.g2048 = g2048New();
    g2048Spawn(state.g2048.cells);
    g2048Spawn(state.g2048.cells);
  }
  return state.g2048;
}

function g2048Step(dir){
  const g = g2048Ensure();
  if (g.dead) return false;
  const res = g2048Move(g.cells, dir);
  if (!res.moved) return false;
  g.cells = res.cells;
  g.score += res.gained;
  if (g.score > state.g2048Best) state.g2048Best = g.score;
  g2048Spawn(g.cells);
  if (g.cells.indexOf(2048) >= 0 && !g.won){
    g.won = true;
    unlockAch('phone2048');
  }
  if (!g2048CanMove(g.cells)) g.dead = true;
  return true;
}

function phoneRenderGame(){
  const g = g2048Ensure();
  phGameScore.textContent = String(g.score);
  phGameBest.textContent = String(Math.max(state.g2048Best || 0, g.score));
  phGameBoard.innerHTML = g.cells.map(v =>
    '<div class="g2048-cell" style="background:' + (G2048_COLORS[v] || '#6b3f8a') + '">' +
    (v || '') + '</div>').join('');
  phGameTip.textContent = g.dead ? '没路可走了 —— 按 R 重开' : '方向键 / WASD 移动 · R 重开';
}

const G2048_KEYS = {
  ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
  KeyA: 'left', KeyD: 'right', KeyW: 'up', KeyS: 'down'
};

/* 手机视图下把方向键让给 2048。返回 true = 这个键已经被吃掉了。 */
function g2048HandleKey(code){
  if (state.phoneTab !== 'game') return false;
  if (code === 'KeyR'){
    state.g2048 = g2048New();
    g2048Spawn(state.g2048.cells);
    g2048Spawn(state.g2048.cells);
    phoneRenderGame();
    return true;
  }
  const dir = G2048_KEYS[code];
  if (!dir) return false;
  g2048Step(dir);
  phoneRenderGame();
  return true;
}

/* ---------------------------- 计算器 ----------------------------
   只做四则和括号。求值走一个白名单正则 + Function，
   因为字符集已经锁死（数字、四则、括号、点、空格），拼不出任何别的东西。 */
function calcEval(expr){
  const s = String(expr || '').replace(/×/g, '*').replace(/÷/g, '/').trim();
  if (!s) return '';
  if (!/^[0-9+\-*/(). ]+$/.test(s)) return '错误';
  let v;
  try { v = Function('return (' + s + ');')(); } catch(e){ return '错误'; }
  if (typeof v !== 'number' || !isFinite(v)) return '错误';
  /* 去掉浮点毛刺：0.1+0.2 显示 0.3，而不是 0.30000000000000004 */
  return String(Math.round(v * 1e10) / 1e10);
}

const PHONE_CALC_KEYS = [
  ['C', '⌫', '(', ')'],
  ['7', '8', '9', '÷'],
  ['4', '5', '6', '×'],
  ['1', '2', '3', '-'],
  ['0', '.', '=', '+']
];

function phoneRenderCalc(){
  if (!phCalcPad.childElementCount){
    phCalcPad.innerHTML = PHONE_CALC_KEYS.map(row =>
      row.map(k => '<button class="pcalc-btn' + (k === '=' ? ' pcalc-eq' : '') +
                   '" data-k="' + k + '">' + k + '</button>').join('')
    ).map(r => '<div class="pcalc-row">' + r + '</div>').join('');
  }
  phCalcOut.textContent = calcEval(state.calcExpr) === '' ? '0' : calcEval(state.calcExpr);
  phCalcExpr.textContent = state.calcExpr || '';
}

function phoneCalcPress(k){
  if (k === 'C'){ state.calcExpr = ''; }
  else if (k === '⌫'){ state.calcExpr = String(state.calcExpr || '').slice(0, -1); }
  else if (k === '='){
    const v = calcEval(state.calcExpr);
    state.calcExpr = (v && v !== '错误') ? v : '';
  } else {
    if (String(state.calcExpr || '').length < 40) state.calcExpr = (state.calcExpr || '') + k;
  }
  phoneRenderCalc();
}

/* ---------------------------- 渲染与开关 ---------------------------- */
/* 切 tab 时必须把那一屏重新渲染一遍。
   第一版只切了显隐 —— 于是"打开手机 → 过 20 分钟 → 切到群聊"看到的
   还是打开那一刻的旧消息，而群聊的全部意义就是看实时进度。 */
function phoneSetTab(tab){
  if (PHONE_TABS.indexOf(tab) < 0) tab = 'status';
  state.phoneTab = tab;
  phStatus.classList.toggle('hidden', tab !== 'status');
  phChat.classList.toggle('hidden', tab !== 'chat');
  phGame.classList.toggle('hidden', tab !== 'game');
  phCalc.classList.toggle('hidden', tab !== 'calc');
  for (const b of phTabs.querySelectorAll('button')){
    b.classList.toggle('on', b.dataset.tab === tab);
  }
  if (tab === 'status') phoneRenderStatus();
  else if (tab === 'chat') phoneRenderChat();
  else if (tab === 'game') phoneRenderGame();
  else phoneRenderCalc();
}

function phoneRender(){
  const left = Math.max(0, CONTEST_LEN - state.elapsed);
  phClock.textContent = phoneClock(state.elapsed);
  phLeft.textContent = '剩余 ' + phoneClock(left);
  phoneSetTab(state.phoneTab || 'status');    /* 内部会把那一屏渲染好 */
}

function openPhone(){
  if (!canOpenPhone()) return;
  state.view = 'phone';
  crosshair.classList.add('hidden');
  promptEl.classList.add('hidden');
  releaseLock();
  phoneRender();
  phoneUI.classList.remove('hidden');

  /* 第一次掏出来就算"夹带"：它已经进考场了，只是没人看见 */
  if (!state.phoneUsed){
    state.phoneUsed = true;
    unlockAch('phone');
  }
}

function closePhone(){
  if (state.view !== 'phone') return;
  phoneUI.classList.add('hidden');
  state.view = 'world';
  crosshair.classList.remove('hidden');
  requestLock();
}

/* P 键：开/关。已经在别的面板里就交给那个面板自己处理 */
function togglePhone(){
  if (state.view === 'phone'){ closePhone(); return; }
  if (state.view !== 'world') return;
  if (!state.hasPhone){
    toast('手机在正门那边被封存了。', 1600);
    return;
  }
  if (state.area !== 'room'){
    toast('这会儿没什么好看的。', 1400);
    return;
  }
  openPhone();
}

/* 被监考抓到：手机没收，面板关掉。由 teacher.js 调用。
   注意背包里也要真的没有 —— "状态是假的、物品还在"这种双份真相迟早出事。 */
function confiscatePhone(){
  const had = state.hasPhone;
  state.hasPhone = false;
  if (bagCount('phone') > 0) bagTake('phone', 1);
  if (state.view === 'phone') closePhone();
  return had;
}

/* 存档可能来自"手机"这个功能之前，也可能 bag 和 hasPhone 各自被改过。
   读档末尾把两份状态对齐到 hasPhone 上 —— 否则会出现"背包里没有手机却能按 P"，
   或者反过来"背包里有却提示已被封存"。 */
function reconcilePhone(){
  const inBag = bagCount('phone') > 0;
  if (state.hasPhone && !inBag) bagAdd('phone', 1);
  else if (!state.hasPhone && inBag) bagTake('phone', 1);
}

/* 物品栏里按 Q 用手机。返回 false 表示"这次用不上"，不会消耗。
   （ITEMS.phone.keep = true，所以 useSelectedItem 不会扣数量。） */
function usePhoneItem(){
  if (state.view !== 'world') return false;
  if (!state.hasPhone){
    toast('手机在正门那边被封存了。', 1600);
    return false;
  }
  if (state.area !== 'room'){
    toast('这会儿没什么好看的。', 1400);
    return false;
  }
  openPhone();
  return true;
}

/* 点 tab / 点计算器按键。用事件委托，按钮是渲染时才生成的 */
function initPhoneEvents(){
  phTabs.addEventListener('click', e => {
    const b = e.target.closest ? e.target.closest('button') : null;
    if (!b || !b.dataset.tab) return;
    phoneSetTab(b.dataset.tab);
  });
  phCalcPad.addEventListener('click', e => {
    const b = e.target.closest ? e.target.closest('button') : null;
    if (!b || !b.dataset.k) return;
    phoneCalcPress(b.dataset.k);
  });
}
