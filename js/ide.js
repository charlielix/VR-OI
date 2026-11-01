'use strict';
/* =========================================================================
   ide —— 评测环境面板 / 语法高亮 / 提交评测
   ---------------------------------------------------------------------
   高亮用的是"叠一层 pre"的经典做法：textarea 负责输入与光标，
   透明的文字色 + 底层 <pre> 负责着色，滚动位置逐帧同步。
   高亮节流到 50ms 一次 —— 连续敲键时重建整块 DOM 太浪费。
   ========================================================================= */

/* ---------------------------- 面板开合 ---------------------------- */
function openPauseMenu(){
  if (state.view !== 'world' || !state.started || state.ended || state.frozen) return;
  state.view = 'pause';
  crosshair.classList.add('hidden');
  promptEl.classList.add('hidden');
  releaseLock();
  pauseMenu.classList.remove('hidden');
  syncViewUI();
}
function closePauseMenu(){
  pauseMenu.classList.add('hidden');
  state.view = 'world';
  crosshair.classList.remove('hidden');
  requestLock();
  /* 上一次申请如果因为 Esc 冷却被拒，这里补一句可执行的提示。
     没有这一句，玩家会停在"鼠标动不了、点了也没反应"的状态里刷页面。 */
  flushLockHint();
}

function openCode(){
  if (state.ended || state.frozen) return;
  state.view = 'code';
  crosshair.classList.add('hidden');
  promptEl.classList.add('hidden');
  releaseLock();
  codeUI.classList.remove('hidden');
  verdictEl.classList.add('hidden');
  renderProblemList();
  loadProblem(state.curProb);
  setTimeout(() => { try { codeArea.focus(); } catch(e){} }, 60);
}
function closeCode(){
  codeUI.classList.add('hidden');
  state.view = 'world';
  crosshair.classList.remove('hidden');
  requestLock();
}

function renderProblemList(){
  const list = $('problemList');
  list.innerHTML = '';
  state.problems.forEach(p => {
    const sc = state.score[p.id] || 0;
    const div = document.createElement('div');
    div.className = 'pitem' + (p.id === state.curProb ? ' active' : '') + (sc >= p.max ? ' ac' : '');
    div.innerHTML =
      '<div class="pn"><span>' + p.id + ' ' + p.name + '</span></div>' +
      '<div class="pn" style="margin-top:4px">' +
        '<span style="font-size:11px;opacity:.6">' + difficultyStars(p.difficulty) + '</span>' +
        '<span class="sc">' + sc + '/' + p.max + '</span>' +
      '</div>';
    div.onclick = () => {
      saveCode();
      state.curProb = p.id;
      loadProblem(p.id);
      renderProblemList();
      scheduleDeskScreensUpdate();
    };
    list.appendChild(div);
  });
}

function loadProblem(id){
  const p = state.problems.find(x => x.id === id);
  if (!p) return;
  if (state.code[id] === undefined) state.code[id] = p.starter;
  $('problemPane').innerHTML =
    '<h3>' + p.id + ' · ' + p.name + '</h3>' +
    '<div class="meta">时间限制 ' + p.tl + ' | 内存限制 ' + p.ml +
    ' | 满分 ' + p.max + ' | 难度 ' + difficultyStars(p.difficulty) + '</div>' +
    '<pre>' + p.desc.replace(/</g, '&lt;') + '</pre>';
  codeArea.value = state.code[id];
  $('fileName').textContent = p.id + '.cpp';
  verdictEl.classList.add('hidden');
  scheduleHighlight();
  updateCursorInfo();
}

function saveCode(){
  if (!state.curProb) return;
  state.code[state.curProb] = codeArea.value;
  scheduleAutoSave();
}

function updateCursorInfo(){
  const v = codeArea.value.substring(0, codeArea.selectionStart);
  const lines = v.split('\n');
  $('cursorInfo').textContent =
    'Ln ' + lines.length + ', Col ' + (lines[lines.length - 1].length + 1) +
    ' · C++14 · g++ -O2';
}

/* ---------------------------- 语法高亮 ---------------------------- */
const HL_KEYWORDS = new Set([
  'int','long','short','char','float','double','void','bool','auto','signed','unsigned',
  'if','else','for','while','do','switch','case','default','break','continue','return','goto',
  'using','namespace','include','define','typedef','struct','class','union','enum',
  'public','private','protected','virtual','override','static','inline','const','constexpr',
  'new','delete','template','typename','try','catch','throw','sizeof','true','false','nullptr',
  'vector','pair','map','set','queue','stack','deque','string','priority_queue',
  'std','cout','cin','endl','sort','swap','min','max','push_back','pop_back','begin','end',
  'scanf','printf','puts','putchar','getchar'
]);

const HL_TOK = '\x00T';
const HL_TOK_RE = /\x00T(\d+)\x00/g;
let hlPending = false, hlLastRun = 0;

function scheduleHighlight(){
  if (hlPending) return;
  hlPending = true;
  const delay = Math.max(0, 50 - (performance.now() - hlLastRun));
  setTimeout(() => {
    hlPending = false;
    hlLastRun = performance.now();
    codeHighlight.innerHTML = hlRender(codeArea.value) + '\n';
    codeHighlight.scrollTop = codeArea.scrollTop;
    codeHighlight.scrollLeft = codeArea.scrollLeft;
  }, delay);
}

function hlEscape(s){
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function hlRender(code){
  const tokens = [];
  let s = code;

  /* 先把注/串/# 指令挖成占位符，避免后续规则把它们内部也染上色 */
  s = s.replace(/\/\*[\s\S]*?\*\//g, m => {
    tokens.push('<span class="tok-c">' + hlEscape(m) + '</span>');
    return HL_TOK + (tokens.length - 1) + '\x00';
  });
  s = s.replace(/\/\/[^\n]*/g, m => {
    tokens.push('<span class="tok-c">' + hlEscape(m) + '</span>');
    return HL_TOK + (tokens.length - 1) + '\x00';
  });
  s = s.replace(/"(?:[^"\\\n]|\\.)*"/g, m => {
    tokens.push('<span class="tok-s">' + hlEscape(m) + '</span>');
    return HL_TOK + (tokens.length - 1) + '\x00';
  });
  s = s.replace(/'(?:[^'\\\n]|\\.)*'/g, m => {
    tokens.push('<span class="tok-s">' + hlEscape(m) + '</span>');
    return HL_TOK + (tokens.length - 1) + '\x00';
  });
  s = s.replace(/^(\s*#\s*\w+)/gm, m => {
    tokens.push('<span class="tok-p">' + hlEscape(m) + '</span>');
    return HL_TOK + (tokens.length - 1) + '\x00';
  });

  s = hlEscape(s);

  /* 先关键字后数字：否则第 2 步插入的 <span class="tok-n"> 里的 class
     会被第 3 步的关键字规则再包一层，直接把 HTML 结构搞坏 */
  s = s.replace(/\b([A-Za-z_]\w*)\b/g, m => HL_KEYWORDS.has(m) ? '<span class="tok-k">' + m + '</span>' : m);
  s = s.replace(/\b(0x[0-9a-fA-F]+|\d+\.?\d*[fFlL]?)\b/g, '<span class="tok-n">$1</span>');

  s = s.replace(HL_TOK_RE, (_, i) => tokens[+i]);
  return s;
}

/* ---------------------------- 提交评测 ---------------------------- */
function submitCode(){
  if (state.ended || state.frozen) return;
  saveCode();

  const prob = state.problems.find(x => x.id === state.curProb);
  const code = state.code[state.curProb];

  const bad = containsBannedWord(code);
  if (bad){ showBannedWordDialog(bad); return; }

  const btn = $('btnSubmit');
  btn.disabled = true;

  verdictEl.classList.remove('hidden');
  verdictEl.innerHTML =
    '<h4>评测中… <span style="color:#5b8cff">' + prob.id + '</span></h4>' +
    '<div class="judging">正在编译 g++ -O2 & 运行测试数据…</div>' +
    '<div class="barwrap"><i id="jbar"></i></div>';
  audio.beep(680, 0.06, 0.04);

  let prog = 0;
  /* 关键：先声明 iv 再启动轮询。写成 const iv = setInterval(() => {... iv ...})
     会在第一次回调（可能在赋值前触发）时抛 TDZ 错误 —— 隐藏得极深。 */
  let iv = null;
  const tick = () => {
    prog += 7 + Math.random() * 12;
    const bar = $('jbar');
    if (bar) bar.style.width = Math.min(100, prog) + '%';
    if (prog < 100) return;

    clearInterval(iv);
    const res = judgeCode(code, prob);
    const prev = state.score[prob.id] || 0;
    state.score[prob.id] = Math.max(prev, res.score);
    state.submitCount[prob.id] = (state.submitCount[prob.id] || 0) + 1;

    recalcScore();
    renderVerdict(prob, res, prev);
    renderProblemList();
    scheduleDeskScreensUpdate();
    scheduleAutoSave();
    btn.disabled = false;

    if (res.score >= prob.max){
      audio.beep(880, 0.15, 0.05);
      unlockAch('first_ac');
      if (state.problems.every(p => (state.score[p.id] || 0) >= p.max)) unlockAch('full_score');
    } else if (res.score > 0){
      audio.beep(560, 0.15, 0.045);
    } else {
      audio.beep(220, 0.25, 0.05);
    }
    if (state.problems.every(p => state.submitCount[p.id] > 0)) unlockAch('submitter');
  };
  iv = setInterval(tick, 130);
}

function renderVerdict(prob, res, prevScore){
  const statusText = res.status === 'AC' ? 'Accepted' :
                     res.status === 'CE' ? 'Compile Error' :
                     res.status === 'PART' ? 'Partial Score' : 'Wrong Answer';
  const color = res.status === 'AC' ? '#38d39f' :
                res.status === 'CE' ? '#8b95a9' :
                res.status === 'PART' ? '#ffcc57' : '#ff5f6d';
  const st = codeStats(codeArea.value);
  const d = res.detail;

  verdictEl.innerHTML =
    '<h4>' + prob.id + ' 评测结果 <span style="color:' + color + '">' + res.score + ' 分</span></h4>' +
    '<div style="color:' + color + ';font-size:12px;margin-bottom:10px;font-family:monospace">' +
      statusText + '　·　通过 ' + res.passed + '/10 个测试点</div>' +
    '<div class="cases">' + res.cases.map(c =>
      '<div class="case ' + c.status + '">#' + c.id + '<br>' + c.status + '</div>').join('') +
    '</div>' +
    '<div class="scorebreak">' +
      '<span>关键字 <b>' + d.kw + '</b>/40</span>' +
      '<span>长度 <b>' + Math.round(d.len) + '</b>/30</span>' +
      '<span>结构 <b>' + d.struct + '</b>/30</span>' +
      '<span>进阶 <b>' + d.adv + '</b>/10</span>' +
      '<span>抖动 <b>' + (d.jitter >= 0 ? '+' : '') + d.jitter + '</b></span>' +
    '</div>' +
    '<div style="margin-top:10px;font-size:11px;color:#5d6880;font-family:monospace">' +
      '代码 ' + st.lines + ' 行 / ' + st.chars + ' 有效字符' +
      (prevScore > 0 ? '　·　历史最高 ' + prevScore + ' 分' : '') +
    '</div>' +
    '<div style="margin-top:8px;font-size:11px;color:#5d6880">' +
      (res.status === 'CE' ? '提示：代码中未找到 main 函数或代码过短。' : '') +
      (res.status !== 'AC' && res.status !== 'CE' ? '提示：检查算法复杂度与边界情况。' : '') +
      (res.status === 'AC' ? '恭喜！这道题你拿到了满分。' : '') +
    '</div>';
}

/* ---------------------------- 计分 ---------------------------- */
let lastHudProbsKey = '';
function recalcScore(){
  let total = 0;
  state.problems.forEach(p => { total += (state.score[p.id] || 0); });
  state.totalScore = total;
  renderHudProbs();
}

function renderHudProbs(){
  const key = state.problems.map(p => p.id + '|' + (state.score[p.id] || 0)).join(',');
  if (key === lastHudProbsKey) return;
  lastHudProbsKey = key;
  hudProbs.innerHTML = state.problems.map(p => {
    const sc = state.score[p.id] || 0;
    return '<div class="row ' + (sc >= p.max ? 'ac' : '') + '">' +
             '<span>' + p.id + ' ' + p.name + '</span><b>' + sc + '</b>' +
           '</div>';
  }).join('');
}
