/* =========================================================================
   browsercheck.mjs —— 用真实 Chrome 打开页面并核对运行状态
   ---------------------------------------------------------------------
   为什么需要它：无头桩测试（tools/smoke.mjs）用的是我自己写的 DOM/THREE 桩，
   它测不出两类问题：
     1) 浏览器真实解析期错误（跨文件 TDZ、重复声明）
     2) three.js 真实 API 与桩的差异
   本脚本用 CDP 连上 headless Chrome，拿到真正的 console / exception，
   并在页面里直接读 window.__OI__ 的状态。
   用法：node tools/browsercheck.mjs [url] [chromePath]
   ========================================================================= */
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const URL_ = process.argv[2] || 'http://127.0.0.1:8848/index.html';
const CHROME = process.argv[3] ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

/* 调试端口不能写死。上一次跑完的 Chrome 若还没退干净，端口仍然被它占着，
   这一次 Chrome 就起不来监听 —— 表现成"Chrome 调试端口没起来"这种
   看起来随机的失败（实测大约 8 次里 1 次）。更阴险的是：端口被占时
   `/json/list` 其实会**成功**返回，只是返回的是上一个实例的 target，
   于是新跑的分支可能连到旧页面上去。
   让系统分配一个空闲端口，从根上消除这件事。 */
const PORT = await pickFreePort();
const PROFILE = path.join(os.tmpdir(), 'oi-cdp-' + Date.now());

function getJson(url){
  return new Promise((res, rej) => {
    http.get(url, r => {
      let s = '';
      r.on('data', d => s += d);
      r.on('end', () => { try { res(JSON.parse(s)); } catch(e){ rej(e); } });
    }).on('error', rej);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 删临时 profile：Chrome 的子进程（crashpad 等）在主进程被杀后还会短暂
   持有文件句柄，一次 rmSync 常常删不干净。带 maxRetries + 外层重试，
   直到目录真的消失 —— 否则反复跑这个工具会在 %TEMP% 里堆出上 GB 垃圾。 */
async function removeProfile(){
  for (let i = 0; i < 10; i++){
    try { fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 }); } catch(e){}
    if (!fs.existsSync(PROFILE)) return;
    await sleep(250);
  }
}

/* Windows 上 chrome.kill() 只结束启动器，渲染进程和 crashpad 还活着，
   继续攥着 profile 目录里的句柄 —— 这时候怎么 rmSync 都删不掉，
   exit 钩子又是同步的、等不了。所以整棵树一起杀。 */
function killTree(child){
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32'){
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'],
                { stdio: 'ignore', windowsHide: true });
      return;
    }
  } catch(e){}
  try { child.kill('SIGKILL'); } catch(e){}
}

/* 上一轮没删干净的兜底：开跑前把 30 分钟前的 oi-cdp-* 擦掉。
   只动旧的 —— 免得删掉同时并行在跑的另一份。 */
function sweepOldProfiles(){
  let n = 0;
  try {
    for (const name of fs.readdirSync(os.tmpdir())){
      if (!name.startsWith('oi-cdp-')) continue;
      const p = path.join(os.tmpdir(), name);
      try {
        if (Date.now() - fs.statSync(p).mtimeMs < 30 * 60 * 1000) continue;
        fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
        n++;
      } catch(e){}
    }
  } catch(e){}
  return n;
}
const sweptProfiles = sweepOldProfiles();
if (sweptProfiles) console.log('  （清掉了上次没删干净的临时 profile ' + sweptProfiles + ' 份）');

/* 兜底清理：中途抛异常时走不到下面两个 process.exit，
   临时 profile 就留在 %TEMP% 里了（实测漏过一份 16 MB 的）。
   exit 钩子只能是同步的，所以这里用同步 rmSync 再擦一遍。 */
process.on('exit', () => {
  if (!PROFILE) return;
  for (let i = 0; i < 3; i++){
    try { fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch(e){}
    if (!fs.existsSync(PROFILE)) return;
  }
});

/* 向系统要一个当前空闲的端口（listen(0) 之后读回实际分配的端口）。 */function pickFreePort(){
  return new Promise((res, rej) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => res(p));
    });
  });
}

/* --- 极简 WebSocket 客户端（够用即可：文本帧 + 屏蔽位 + 分片接收） --- */
import net from 'node:net';
import crypto from 'node:crypto';

class WS {
  constructor(url){
    const u = new URL(url);
    this.sock = net.connect(Number(u.port), u.hostname);
    this.key = crypto.randomBytes(16).toString('base64');
    this.buf = Buffer.alloc(0);
    this.onmsg = () => {};
    this.ready = new Promise((res, rej) => {
      this.sock.on('connect', () => {
        this.sock.write(
          `GET ${u.pathname}${u.search} HTTP/1.1\r\n` +
          `Host: ${u.host}\r\n` +
          `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${this.key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      });
      this.sock.on('data', chunk => {
        if (!this._upgraded){
          const s = chunk.toString('latin1');
          if (!s.includes('\r\n\r\n')){ this.buf = Buffer.concat([this.buf, chunk]); return; }
          const idx = Buffer.concat([this.buf, chunk]).indexOf('\r\n\r\n');
          const all = Buffer.concat([this.buf, chunk]);
          this._upgraded = true;
          this.buf = all.subarray(idx + 4);
          res();
          if (this.buf.length) this._drain();
          return;
        }
        this.buf = Buffer.concat([this.buf, chunk]);
        this._drain();
      });
      this.sock.on('error', rej);
    });
  }
  _drain(){
    for (;;){
      if (this.buf.length < 2) return;
      const b1 = this.buf[1];
      let len = b1 & 0x7f, off = 2;
      if (len === 126){
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2); off = 4;
      } else if (len === 127){
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2)); off = 10;
      }
      if (this.buf.length < off + len) return;
      const payload = this.buf.subarray(off, off + len).toString('utf8');
      this.buf = this.buf.subarray(off + len);
      this.onmsg(payload);
    }
  }
  send(str){
    const data = Buffer.from(str, 'utf8');
    const mask = crypto.randomBytes(4);
    let header;
    if (data.length < 126) header = Buffer.from([0x81, 0x80 | data.length]);
    else if (data.length < 65536){
      header = Buffer.alloc(4);
      header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(data.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(data.length), 2);
    }
    const masked = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
    this.sock.write(Buffer.concat([header, mask, masked]));
  }
  close(){ try { this.sock.destroy(); } catch(e){} }
}

/* ---------------------------- 启动 Chrome ---------------------------- */
/* 访问自签证书的 https 时必须加 --ignore-certificate-errors，
   否则 Chrome 会停在 NET::ERR_CERT_AUTHORITY_INVALID 拦截页，
   脚本量到的就只是那张警告页，而不是我们的游戏。
   仅在目标是 https 时加，避免掩盖 http 下的真实证书问题。 */
const IS_TLS = /^https:/i.test(URL_);
fs.mkdirSync(PROFILE, { recursive: true });
const chromeArgs = [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + PROFILE,
  '--window-size=1280,720',
  '--autoplay-policy=no-user-gesture-required',
  '--mute-audio'
];
if (IS_TLS){
  chromeArgs.push('--ignore-certificate-errors', '--allow-insecure-localhost');
  console.log('（目标为 https，已加 --ignore-certificate-errors 跳过自签证书警告）');
}
chromeArgs.push('about:blank');
const chrome = spawn(CHROME, chromeArgs, { stdio: 'ignore' });

process.on('exit', () => {
  try { if (chrome && chrome.pid) spawnSync('taskkill', ['/pid', String(chrome.pid), '/T', '/F'],
                                             { stdio: 'ignore', windowsHide: true }); } catch(e){}
});
async function targets(){
  for (let i = 0; i < 60; i++){
    try { return await getJson(`http://127.0.0.1:${PORT}/json/list`); }
    catch(e){ await sleep(250); }
  }
  throw new Error('Chrome 调试端口没起来');
}

let ws, msgId = 0;
const pending = new Map();
const logs = [];
const errors = [];

function call(method, params = {}){
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    setTimeout(() => { if (pending.has(id)){ pending.delete(id); rej(new Error('timeout ' + method)); } }, 20000);
  });
}
async function evaluate(expr){
  const r = await call('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true
  });
  if (r.exceptionDetails) throw new Error('页面内异常: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
  return r.result && r.result.value;
}

const list = await targets();
const page = list.find(t => t.type === 'page');
ws = new WS(page.webSocketDebuggerUrl);
await ws.ready;

ws.onmsg = raw => {
  let m; try { m = JSON.parse(raw); } catch(e){ return; }
  if (m.id && pending.has(m.id)){
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    return;
  }
  if (m.method === 'Runtime.consoleAPICalled'){
    const text = (m.params.args || []).map(a => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' ');
    logs.push({ type: m.params.type, text });
  }
  if (m.method === 'Runtime.exceptionThrown'){
    const d = m.params.exceptionDetails;
    errors.push((d.exception && d.exception.description) || d.text);
  }
  if (m.method === 'Log.entryAdded'){
    const e = m.params.entry;
    if (e.level === 'error') errors.push('[log] ' + e.text + ' @ ' + (e.url || ''));
    else logs.push({ type: e.level, text: e.text });
  }
};

await call('Runtime.enable');
await call('Log.enable');
await call('Page.enable');

console.log('导航到 ' + URL_);
await call('Page.navigate', { url: URL_ });
await sleep(3000);
/* 数据采集完再补一次，等 init() 与首帧渲染都落定 */
await sleep(3000);
/* 记录真实生效的 URL：Chrome 可能把 http://127.0.0.1 规范化，
   也可能停在证书拦截页 —— 不记录的话，后面所有指标都可能是在量那张警告页 */
const finalUrl = (await evaluate('location.href')) || URL_;

/* ---------------------------- 结果 ---------------------------- */
console.log('\n== 1. 未捕获异常 ==');
if (errors.length) errors.forEach(e => console.log('  ✗ ' + e));
else console.log('  ✓ 无');

console.log('\n== 2. console 输出 ==');
logs.slice(0, 25).forEach(l => console.log(`  [${l.type}] ${l.text}`));

console.log('\n== 3. 页面状态 ==');
const probe = await evaluate(`(() => {
  const g = window;
  const q = id => g.document.getElementById(id);
  const boot = q('bootErr');
  return {
    threeSrc: g.__THREE_SRC__ || null,
    threeRev: (g.THREE && g.THREE.REVISION) || null,
    hasOI: !!g.__OI__,
    started: g.__OI__ ? g.__OI__.state.started : null,
    problems: g.__OI__ ? g.__OI__.state.problems.map(p => p.id) : null,
    playerPos: g.__OI__ ? [ +g.__OI__.state.pos.x.toFixed(2), +g.__OI__.state.pos.y.toFixed(2), +g.__OI__.state.pos.z.toFixed(2) ] : null,
    sceneChildren: g.__OI__ ? g.__OI__.scene.children.length : null,
    canvasSize: (() => { const c = q('scene'); return c ? [c.width, c.height] : null; })(),
    crosshairHidden: q('crosshair') ? q('crosshair').classList.contains('hidden') : null,
    bootErrText: boot ? boot.textContent.slice(0, 120) : null,
    /* 构建版本戳：用来一眼判断"浏览器是不是在跑旧缓存"。
       若这里是 null/旧值，而磁盘上的源码是新的，就是缓存问题，不是代码问题。 */
    buildTag: (() => { const b = q('buildTag'); return b ? b.textContent : null; })(),
    buildGlobal: g.__OI_BUILD__ || null,
    /* 安全上下文：这是"要不要上 https"这个问题的唯一客观答案。
       file:// 与 http://非环回 都拿不到安全上下文，localStorage 会直接抛错。 */
    location: g.location.href,
    protocol: g.location.protocol,
    isSecureContext: g.isSecureContext,
    /* localStorage 是否真的可用（安全上下文才可用） */
    storageOK: (() => { try { g.localStorage.setItem('__t','1'); g.localStorage.removeItem('__t'); return true; }
                        catch(e){ return false; } })(),
    pointerLockAPI: typeof g.document.body.requestPointerLock === 'function',
    fullscreenAPI: typeof g.document.documentElement.requestFullscreen === 'function',
    bodyChildren: g.document.body.children.length,
    /* 同上：安全上下文不成立时（https 自签、隐身模式…）读 localStorage
       本身就会抛 SecurityError。上面那条 storageOK 已经考虑了这种情况，
       这里也必须包起来 —— 否则整个探针在这个 origin 上直接崩掉。 */
    localStoreKeys: (() => { try { return Object.keys(g.localStorage); } catch(e){ return null; } })(),
    fnMouseSens: typeof g.mouseSens,
    fnInit: typeof g.init,
    fnJudge: typeof g.judgeCode
  };
})()`);
console.log('  ' + JSON.stringify(probe, null, 2).replace(/\n/g, '\n  '));

console.log('\n== 4. 模拟点击"进入考场"并跑 3 秒 ==');
/* 点之前先量一次开始界面：按钮得在视口里，滚轮也不能被快捷栏抓走。
   这是同一个症状的两半 —— 按钮落在折线以下（要滚才点得到），
   而 main.js 的 wheel 监听又把它 preventDefault 了，于是"滚轮用不了"。 */
const startUI = await evaluate(`(() => {
  const st = document.getElementById('start');
  const b = document.getElementById('btnStart');
  if (!st || !b) return { err: '开始界面或按钮不存在' };
  const r = b.getBoundingClientRect();
  const card = st.querySelector('.card');
  const idxBefore = window.__OI__ ? window.__OI__.state.hotbarIdx : null;
  /* 真派发一次滚轮：还没点进入考场，它必须原样交还给浏览器 */
  document.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }));
  return {
    vw: innerWidth, vh: innerHeight,
    btnTop: +r.top.toFixed(1), btnBottom: +r.bottom.toFixed(1), btnH: +r.height.toFixed(1),
    pageScrollH: document.documentElement.scrollHeight,
    startScrollH: st.scrollHeight, startClientH: st.clientHeight,
    cardScrolls: card ? (card.scrollHeight > card.clientHeight + 1) : null,
    wheelStole: (idxBefore !== null) ? (window.__OI__.state.hotbarIdx !== idxBefore) : null
  };
})()`);
console.log('  ' + JSON.stringify(startUI));

const after = await evaluate(`(() => {
  if (!window.__OI__) return { err: '初始化没完成，__OI__ 不存在' };
  const b = document.getElementById('btnStart');
  if (!b) return { err: '没有按钮' };
  b.click();
  return { started: __OI__.state.started, elapsed: __OI__.state.elapsed };
})()`);
console.log('  ' + JSON.stringify(after));
if (!after || after.err){
  console.log('\n== 结论：初始化未完成，跳过后续步骤 ==');
  ws.close(); killTree(chrome);
/* 收尾：删掉本次的临时 profile。这个工具会被反复跑（找偶发问题），
   不清理的话 %TEMP% 里会堆出上百个目录、上 GB 的垃圾。 */
await sleep(400);
await removeProfile();
process.exit(1);
}
await sleep(3000);
const running = await evaluate(`(() => ({
  elapsed: +__OI__.state.elapsed.toFixed(1),
  worldTime: +__OI__.state.worldTime.toFixed(2),
  fpsSample: (() => { let n = 0; const t0 = performance.now();
    return new Promise(r => { const tick = () => { n++; if (performance.now() - t0 > 1000) r(n); else requestAnimationFrame(tick); }; requestAnimationFrame(tick); }); })()
}))()`);
console.log('  ' + JSON.stringify(running));

console.log('\n== 5. 真实 three.js 路径：判题 / 打开 IDE / 提交 ==');
const judge = await evaluate(`(() => {
  const s = __OI__.state;
  const r = judgeCode(s.problems[0].starter, s.problems[0]);
  return { id: s.problems[0].id, keys: Object.keys(r), score: r.score, status: r.status };
})()`);
console.log('  判题返回字段: ' + judge.keys.join(', '));
console.log('  ' + judge.id + ' 模板得分 ' + judge.score + '（' + judge.status + '）');

const ide = await evaluate(`(() => {
  openCode();
  const v = state.view;
  const list = document.getElementById('problemList');
  const rows = list ? list.children.length : -1;
  codeArea.value = state.problems[0].starter;
  submitCode();
  return { view: v, 题面行数: rows, 提交前分: state.score[state.curProb] || 0 };
})()`);
console.log('  打开 IDE: view=' + ide.view + '，题目列表 ' + ide.题面行数 + ' 行');
await sleep(1200);            /* 等评测进度条跑完 */
const afterSubmit = await evaluate(`(() => ({
  score: state.score[state.curProb] || 0,
  submitCount: state.submitCount[state.curProb] || 0,
  verdictHTML: (document.getElementById('verdict').innerHTML || '').length,
  view: state.view
}))()`);
console.log('  提交后: 得分 ' + afterSubmit.score +
            '，提交次数 ' + afterSubmit.submitCount +
            '，评测面板 ' + afterSubmit.verdictHTML + ' 字符');
await evaluate('closeCode()');

console.log('\n== 6. 渲染路径核对（逐 pass 拆开看，别被 info 的自动重置骗了） ==');
/* renderer.info.render 在每次 render() 时自动重置，所以直接读它只能看到
   【最后一个 pass】的数据。这里给 renderer.render 打一层计数包装，
   把一帧内所有 pass 的 draw call 累加起来，才能确认世界真的被画了。 */
const fx = await evaluate(`(() => {
  const c = document.getElementById('scene');
  const gl = c.getContext('webgl2') || c.getContext('webgl');
  const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');

  const r = __OI__.renderer;
  const orig = r.render.bind(r);
  const acc = { calls: 0, tris: 0, passes: 0, targets: [] };
  r.render = function(sc, cam){
    orig(sc, cam);
    acc.calls += r.info.render.calls;
    acc.tris += r.info.render.triangles;
    acc.passes++;
    acc.targets.push(r.getRenderTarget() ? 'rt' : 'screen');
  };
  return new Promise(res => {
    let frames = 0;
    const t0 = performance.now();
    const tick = () => {
      frames++;
      if (performance.now() - t0 > 1500){
        r.render = orig;
        const fps = frames / ((performance.now() - t0) / 1000);
        res({
          canvas: c.width + 'x' + c.height,
          gl: gl.getParameter(gl.VERSION),
          gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
          '一帧内 render() 次数': Math.round(acc.passes / frames),
          '一帧内 draw calls 合计': Math.round(acc.calls / frames),
          '一帧内三角数合计': Math.round(acc.tris / frames),
          'pass 种类': [...new Set(acc.targets)].join(','),
          fps: +fps.toFixed(1),
          'scene 子节点': __OI__.scene.children.length,
          'shader 程序数': r.info.programs ? r.info.programs.length : null
        });
      } else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
})()`);
console.log('  ' + JSON.stringify(fx, null, 2).replace(/\n/g, '\n  '));
console.log('  说明：3 个 pass = 世界→rtFrame + 累积到 rtAcc + blit 到屏幕；');
console.log('        随后还有一次只画 layer 1（准星/弹窗）的 UI 叠加 pass。');

console.log('\n== 7. 世界空间弹窗（走真实射线拾取） ==');
/* 必须在打老师【之前】问：打完之后 callTeacher() 会正确地拒绝服务，
   否则这个探针量到的是"老师已倒下"而不是"弹窗坏了"。 */
const dlg = await evaluate(`(() => {
  callTeacher();
  const d = dialogs.length ? dialogs[dialogs.length - 1] : null;
  return { open: hasDialog(), count: dialogs.length,
           hasMesh: !!(d && d.mesh), layer: d && d.mesh ? d.mesh.layers.mask : null,
           textLength: d ? String(d.text || '').length : 0 };
})()`);
console.log('  ' + JSON.stringify(dlg));
const dlgAfter = await evaluate(`(() => { for (let i = 0; i < 40; i++) updateDialogs(0.02);
  return { stillOpen: hasDialog(),
           pos: dialogs.length ? dialogs[0].mesh.position.toArray().map(v => +v.toFixed(2)) : null }; })()`);
console.log('  跟随相机后的弹窗位置: ' + JSON.stringify(dlgAfter));
await evaluate('dismissDialogs()');

console.log('\n== 8. 校园段：站在门口到底能不能进楼（真 three.js 射线） ==');
/* 这一段回答 smoke.mjs 答不了的问题：准星在**几何上**够不够得着门。
   smoke 用 __hit 标记模拟命中，等于预先假定"瞄准一定成立"；这里跑真射线。
   把"从多远开始能瞄到"量出来 —— 它决定玩家会不会在门外空按 E 却没反应。 */
const reach = await evaluate(`(() => {
  const saved = { area: state.area, ps: state.passedSecurity,
                  x: state.pos.x, z: state.pos.z, yaw: state.yaw };
  window.__campusSaved = saved;
  const az = CP.z + CAMPUS_AUDIT_Z;
  const out = [];
  for (const d of [6, 5, 4, 3, 2.5, 2, 1.5, 1]){
    state.pos.x = CP.x; state.pos.z = az + d;
    state.yaw = 0; yawTarget = 0; state.pitch = 0; pitchTarget = 0;
    state.passedSecurity = false;
    updatePlayer(0);                       /* 走游戏自己的相机更新路径，别手搓相机 */
    /* 关键：这 8 次是同一个同步循环里跑完的，中间没有渲染帧，
       而真实游戏里 matrixWorld 是每帧 render() 顺带刷新的。
       不显式刷新，射线用的就是上一帧的旧矩阵 —— 会得到"任何距离都瞄不到"
       这种看似严重、其实是探针造的假象。 */
    camera.updateMatrixWorld(true);
    updateInteract();
    const p = String(promptEl.textContent || '');
    out.push(d + 'm:' + (/过安检/.test(p) ? '中' : '—'));
  }
  return out;
})()`);
console.log('  准星够得着的距离: ' + reach.join('  '));

/* ---- 成就「跑路了兄弟」：跑到校园最外沿 → 解锁 + 被拎回校门口 ----
   验两件事：
     ① 真实 DOM 路径（achNotify 真挂上了名字和那句"出发之后记得回来"）
     ② 触发后玩家真的回到了校门口的站位（x / z / 朝向 全部复位） */
const runaway = await evaluate(`(() => {
  state.area = 'campus'; state.bounds = AREA_BOUNDS.campus;
  state.achievements.delete('runaway');
  dismissDialogs();
  achNotify.classList.remove('show');
  state.pos.x = CAMPUS_SPAWN.x;
  state.pos.z = CP.z + CAMPUS_SPAWN.z;
  state.yaw = 0; yawTarget = 0;

  /* ① 出生点 / 校园里 / 校门口 —— 都不该触发 */
  updateCampusArea(1/60, 0);
  const atSpawn = state.achievements.has('runaway');
  state.pos.z = CP.z - 6;
  updateCampusArea(1/60, 0);
  const inside = state.achievements.has('runaway');
  state.pos.z = CP.z + CAMPUS_GATE_Z;
  updateCampusArea(1/60, 0);
  const atGate = state.achievements.has('runaway');

  /* ② 跑到最外墙：触发，并把人拎回门口 */
  state.pos.z = AREA_BOUNDS.campus.zMax;
  state.pos.x = CP.x - 3.3;
  state.yaw = 2.2;
  updateCampusArea(1/60, 0);

  const html = String(achNotify.innerHTML || '');
  return { atSpawn: atSpawn, inside: inside, atGate: atGate,
           fired: state.achievements.has('runaway'),
           shown: achNotify.classList.contains('show'),
           有名字: html.indexOf('跑路了兄弟') >= 0,
           有那句: html.indexOf('记得回来') >= 0,
           回到门口: Math.abs((state.pos.z - CP.z) - CAMPUS_GATE_STAND.z) < 1e-6 &&
                     Math.abs((state.pos.x - CP.x) - CAMPUS_GATE_STAND.x) < 1e-6 &&
                     state.yaw === CAMPUS_GATE_STAND.yaw,
           落点: (state.pos.z - CP.z).toFixed(2) + ',' + (state.pos.x - CP.x).toFixed(2) };
})()`);
console.log('  跑路了兄弟: ' + JSON.stringify(runaway));

/* ---- 上面那组是"直接改 state.pos.z"：它证明的是**函数**能触发。
   但玩家不是瞬移的，玩家是走过去的 —— 而且是从**出生点**掉头就往外跑。
   最初版本要求"先进校园再穿出校门"，于是这条路永远走不到判定线，
   成就根本触发不了（就是玩家报的那个 bug）。所以这里必须真按 S 走一遍。 */
const runawayWalk = await evaluate(`(() => {
  state.area = 'campus'; state.bounds = AREA_BOUNDS.campus;
  state.achievements.delete('runaway');
  dismissDialogs();
  state.pos.x = CAMPUS_SPAWN.x;
  state.pos.z = CP.z + CAMPUS_SPAWN.z;
  state.yaw = 0; yawTarget = 0; state.pitch = 0; pitchTarget = 0;
  /* yaw=0 时 W = -Z（进校园），S = +Z（往外跑）。
     这里只按 S —— 复现玩家的真实操作：一开局就掉头跑。 */
  state.keys['s'] = true;
  let firedAt = -1, minZ = 1e9, maxZ = -1e9, afterZ = 0, afterX = 0, retreats = 0;
  let lastZ = state.pos.z - CP.z;
  for (let i = 0; i < 600; i++){
    updatePlayer(1/60);
    updateCampusArea(1/60, i / 60);
    const lz = state.pos.z - CP.z;
    if (lz < minZ) minZ = lz;
    if (lz > maxZ) maxZ = lz;
    /* 被拎回来的那一刻：z 会往回跳一大截。数一下发生了几次。 */
    if (lz < lastZ - 3) retreats++;
    lastZ = lz;
    if (firedAt < 0 && state.achievements.has('runaway')){
      firedAt = i;
      /* 触发那一帧 updateCampusArea 已经把玩家挪回门口了 —— 就在这里采点。
         别等到循环结束：按着 S 不放会继续往外走，那是另一回事。 */
      afterZ = lz; afterX = state.pos.x - CP.x;
    }
  }
  state.keys['s'] = false;
  return { firedAt: firedAt, 最远到: maxZ.toFixed(2), 最近到: minZ.toFixed(2),
           触发瞬间落点: afterZ.toFixed(2) + ',' + afterX.toFixed(2),
           门口站位: CAMPUS_GATE_STAND.z + ',' + CAMPUS_GATE_STAND.x,
           被拎回次数: retreats,
           瞬间被判回门口: Math.abs(afterZ - CAMPUS_GATE_STAND.z) < 1e-6 &&
                            Math.abs(afterX - CAMPUS_GATE_STAND.x) < 1e-6 };
})()`);
console.log('  真实按键跑路: ' + JSON.stringify(runawayWalk));

/* ---- 员工通道（侧门）：真射线找门 → 真进楼 → 手机跟着进去 ----
   这不是"成就判定"级别的测试：它必须证明这条路**走得通**，
   所以① 用真实探针射线验"站在夹道里能不能瞄到门"，② 真的把弹窗点掉，
   ③ 验状态机（没过安检却进了楼、手机还在）。 */
const sideDoor = await evaluate(`(() => {
  dismissDialogs();
  state.area = 'campus'; state.bounds = AREA_BOUNDS.campus;
  state.enteredRoom = false; state.sneakedIn = false;
  state.passedSecurity = false; state.hasPhone = true; state.phoneUsed = false;
  state.achievements.delete('sideentry');

  /* 站到东墙外的夹道里，正对墙上的门。
     这里不用 state.yaw —— 相机朝向是渲染循环每帧从 yaw 推出来的，
     在一个 evaluate 内部不会自己刷新，只改 yaw 再 updateMatrixWorld
     等于拿旧矩阵去射线（第一版就是这样，命中为 null）。直接摆相机。 */
  const bz = CP.z + CAMPUS_BUILD_Z;
  state.pos.x = CP.x + 12.0; state.pos.z = bz - 3;
  state.pitch = 0; pitchTarget = 0;
  camera.position.set(state.pos.x, PLAYER_EYE, state.pos.z);
  camera.lookAt(CP.x + 11, PLAYER_EYE, bz - 3);
  camera.updateMatrixWorld(true);

  raycaster.setFromCamera(CENTER, camera);
  raycaster.far = 3.6;
  const hits = raycaster.intersectObjects(campusAuditTargets.map(a => a.obj), false);
  const rec = hits.length ? campusAuditTargets.find(a => a.obj === hits[0].object) : null;

  campusInteract();
  const prompt = String(promptEl.textContent || '');
  const fn = actionE && actionE.fn ? String(actionE.fn.name) : '';

  /* 真的把弹窗点掉（走玩家那条路：E → 选 1） */
  enterSideDoor();
  const dlgTitle = dialogs.length ? String(dialogs[dialogs.length - 1].title || '') : '';
  selectDialogOption(0);

  return {
    kind: rec ? rec.kind : '', dist: hits.length ? +hits[0].distance.toFixed(2) : null,
    prompt: prompt, fn: fn, dlgTitle: dlgTitle,
    area: state.area, entered: state.enteredRoom, sneaked: state.sneakedIn,
    passedSecurity: state.passedSecurity, hasPhone: state.hasPhone,
    broom: bagCount('broom'),
    ach: state.achievements.has('sideentry'),
    leftoverDlg: dialogs.length
  };
})()`);
console.log('  员工通道: ' + JSON.stringify(sideDoor));

/* ---- 手机：带进来了 → 能掏出来看战况 → 老师那一眼会没收 ---- */
const phoneFlow = await evaluate(`(() => {
  dismissDialogs();
  state.area = 'room'; state.bounds = AREA_BOUNDS.room;
  state.view = 'world'; state.ended = false; state.frozen = false;
  /* 用 initBag 而不是只把 hasPhone 设成 true：手机是背包里的真物品，
     "有这个布尔量但背包里没有"正是这一段要抓的那种分裂。 */
  initBag();
  state.phoneUsed = false;
  /* 开头的背包状态要在"还没被没收"时采 —— 末尾那次老师会把它收走 */
  const bagStart = bagCount('phone'), flagStart = state.hasPhone;
  /* 站到座位上：老师最近只能走到离座位 2.5m 的地方，
     而 switchArea 会把人放在座位前方 0.92 —— 那是 3.42m，够不着触发半径。 */
  state.pos.x = SEAT_CENTER_X; state.pos.z = SEAT_CENTER_Z;
  state.achievements.delete('phone');
  state.achievements.delete('phone_caught');

  /* ① 掏出来。先推进比赛时钟 —— 群聊的内容是按 elapsed 推出来的，
     时间太早群里当然是空的（第一版就是这样：切过去只有 1 条） */
  state.elapsed = Math.max(state.elapsed, 90 * 60);
  togglePhone();
  const opened = state.view === 'phone';
  const visible = !phoneUI.classList.contains('hidden');
  const rows = String(phRows.textContent || '');
  const rankText = String(phRank.textContent || '');
  const stored = state.phoneUsed && state.achievements.has('phone');
  /* class 不 hidden ≠ 看得见：面板可能被压成 0 高、或者被父级裁掉。
     量一次真实盒子 —— 这条会抓住"CSS 写坏了但断言还是绿的"。 */
  const boxEl = document.querySelector('.phonebox');
  const boxR = boxEl ? boxEl.getBoundingClientRect() : null;
  const boxSize = boxR ? Math.round(boxR.width) + 'x' + Math.round(boxR.height) : 'none';

  /* ② 三个"软件"：真点 DOM 上的按钮，不是只调函数 */
  const tabBtns = Array.from(phTabs.querySelectorAll('button'));
  phTabs.querySelector('[data-tab="chat"]').click();
  const chatOn = !phChat.classList.contains('hidden') && phStatus.classList.contains('hidden');
  const chatText = String(phChatLog.textContent || '');
  const chatMsgs = phChatLog.querySelectorAll('.pn-msg').length;
  const chatTabLit = phTabs.querySelector('[data-tab="chat"]').classList.contains('on');
  /* 置顶那句：必须是**第一个** .pn-msg、带 pin 类、而且不带时间戳。
     只看 textContent 有没有这几个字是不够的 —— 那句的意义就是"一打开在最上面"。 */
  const chatFirst = phChatLog.querySelector('.pn-msg');
  const chatFirstPin = !!chatFirst && chatFirst.classList.contains('pin');
  const chatFirstText = chatFirst ? String(chatFirst.textContent || '') : '';
  const chatFirstNoClock = !!chatFirst && !chatFirst.querySelector('.pn-when');

  phTabs.querySelector('[data-tab="calc"]').click();
  const calcOn = !phCalc.classList.contains('hidden');
  phCalcPad.querySelector('[data-k="1"]').click();
  phCalcPad.querySelector('[data-k="+"]').click();
  phCalcPad.querySelector('[data-k="2"]').click();
  const calcBefore = String(phCalcOut.textContent || '');
  phCalcPad.querySelector('[data-k="="]').click();
  const calcAfter = String(phCalcOut.textContent || '');
  const divZero = calcEval('1/0');

  /* ④ 2048：真键盘事件。document 上的 keydown 才是游戏真正的入口，
     直接调 g2048Step 不算"能玩"。 */
  phTabs.querySelector('[data-tab="game"]').click();
  const gameOn = !phGame.classList.contains('hidden');
  state.g2048 = { cells: [2, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
                  score: 0, won: false, dead: false };
  phoneRenderGame();
  const cellsBefore = phGameBoard.children.length;
  const boardBefore = state.g2048.cells.join(',');
  document.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowUp', bubbles: true }));
  const boardAfter = state.g2048.cells.join(',');
  /* 空格键不该把页面滚走 / 也不该被游戏吃掉 */
  const scaled0 = state.g2048.score;

  /* ③ 收起来 */
  phTabs.querySelector('[data-tab="status"]').click();
  togglePhone();
  const closed = state.view === 'world' && phoneUI.classList.contains('hidden');

  /* ③ 老师那一眼：把老师挪到座位旁边再跑一次检查。
     注意 updateTeacherWhenPaused 内部**自己就会调 checkTeacherPeek**，
     所以警告数要在调用之前采，别再补一次 checkTeacherPeek（那次会撞冷却）。 */
  if (!teacher) teacher = buildTeacher(2.4, 0);
  state.view = 'world';
  togglePhone();                       /* 再打开，找死 */
  const T_NEAR = Math.PI * 1.5 / 0.15; /* 离座位最近的那个巡逻点 */
  const warnBefore = state.warnCount;
  state.worldTime += 999;              /* 跳过冷却 */
  updateTeacherWhenPaused(T_NEAR);
  const dBefore = Math.hypot(teacher.group.position.x - state.pos.x,
                             teacher.group.position.z - state.pos.z);
  const warned = state.warnCount - warnBefore;
  /* 放掉冷却：后面还有一组老师测试要吃这个全局量 */
  teacherPeekUntil = 0;

  return { opened: opened, visible: visible, rows: rows.length,
           hasName: rows.length > 0, rank: rankText, stored: stored, closed: closed,
           box: boxSize,
           tabs: tabBtns.length, tabNames: tabBtns.map(b => b.textContent).join('/'),
           chatOn: chatOn, chatMsgs: chatMsgs, chatTabLit: chatTabLit,
           chatHasSubmit: /交了/.test(chatText), chatHasRival: /小明|小红|小刚|小强|小丽/.test(chatText),
           /* 友情客串：名字全部来自 PHONE_CHAT_FLAVOR，不是随机串 */
           chatHasCameo: /(凉宫春日|黑猫|蕾姆|桂木桂马|哆啦A梦|坂本)/.test(chatText),
           chatFirstPin: chatFirstPin, chatFirstText: chatFirstText,
           chatFirstNoClock: chatFirstNoClock,
           calcOn: calcOn, calcBefore: calcBefore, calcAfter: calcAfter, divZero: divZero,
           gameOn: gameOn, cells: cellsBefore, boardBefore: boardBefore,
           boardAfter: boardAfter, gameScore: state.g2048.score,
           bagPhone: bagStart, hasPhoneFlag: flagStart,
           bagAfterCatch: bagCount('phone'),
           dist: +dBefore.toFixed(2),
           caught: state.achievements.has('phone_caught'),
           confiscated: !state.hasPhone,
           viewAfter: state.view, panelHidden: phoneUI.classList.contains('hidden'),
           warned: warned };
})()`);
console.log('  手机（带进来）: ' + JSON.stringify(phoneFlow));

/* ---- 过安检就没收：正规入场那条路拿不到手机 ---- */
const phoneAudit = await evaluate(`(() => {
  dismissDialogs();
  state.area = 'campus'; state.bounds = AREA_BOUNDS.campus;
  state.passedSecurity = false; state.hasPhone = true;
  doSecurityCheck();
  selectDialogOption(0);
  const off = !state.hasPhone;
  /* 没手机的时候按 P 应该开不出来 */
  state.area = 'room'; state.view = 'world';
  togglePhone();
  return { hasPhoneAfterAudit: state.hasPhone, view: state.view,
           toast: String(toastStack.dataset.last || '') };
})()`);
console.log('  手机（过安检）: ' + JSON.stringify(phoneAudit));

/* ---- 入场预留：倒计时必须看得见；迟到能进但扣时；4.5 小时后才缺考 ----
   "看得见"这件事是这条规矩公平的前提：玩家不知道 30 分钟预留，
   第一次撞上就是"我走慢了点，怎么时间没了"。 */
const entryLimit = await evaluate(`(() => {
  dismissDialogs();
  state.area = 'campus'; state.bounds = AREA_BOUNDS.campus;
  state.enteredRoom = false; state.missedEntry = false; state.entryWarned = false;
  state.examStarted = false; state.elapsed = 0; state.admitElapsed = 0;
  state.passedSecurity = false; state.ended = false; state.view = 'world';

  /* 站在校园中段（离传送圈、安检口都远）—— 落到"往考场走"那条提示上 */
  state.pos.x = CP.x + 2; state.pos.z = CP.z - 5;
  state.admitElapsed = 5 * 60;
  updateInteract();
  const early = String(promptEl.textContent || '');

  state.admitElapsed = EXAM_ENTRY_LIMIT + 60;
  updateInteract();
  const late = String(promptEl.textContent || '');

  /* 迟到 1 分钟：侧门仍然能进，但考试时钟从 60 秒开始 */
  const bz = CP.z + CAMPUS_BUILD_Z;
  state.pos.x = CP.x + 12.0; state.pos.z = bz - 3;
  camera.position.set(state.pos.x, PLAYER_EYE, state.pos.z);
  camera.lookAt(CP.x + 11, PLAYER_EYE, bz - 3);
  camera.updateMatrixWorld(true);
  campusInteract();
  const lateFn = actionE && actionE.fn ? String(actionE.fn.name) : '';
  enterSideDoor();
  const lateDlg = dialogs.length
    ? String(dialogs[dialogs.length - 1].title || '').replace(/\\s/g, '') : '';
  if (dialogs.length) selectDialogOption(0);
  const lateArea = state.area, lateEntered = state.enteredRoom;
  const lateStarted = state.examStarted, lateElapsed = state.elapsed;
  dismissDialogs();

  /* 入场预留 + 4 小时都过完：侧门也得拦，弹「考试已结束」 */
  state.area = 'campus'; state.bounds = AREA_BOUNDS.campus;
  state.enteredRoom = false; state.examStarted = false;
  state.elapsed = 0; state.admitElapsed = EXAM_ENTRY_LIMIT + CONTEST_LEN;
  state.missedEntry = false;
  state.pos.x = CP.x + 12.0; state.pos.z = bz - 3;
  campusInteract();
  enterSideDoor();
  const cutDlg = dialogs.length
    ? String(dialogs[dialogs.length - 1].title || '').replace(/\\s/g, '') : '';
  const cutArea = state.area, cutEntered = state.enteredRoom, cutMissing = state.missedEntry;
  dismissDialogs();

  return { early: early, late: late, lateFn: lateFn, lateDlg: lateDlg,
           lateArea: lateArea, lateEntered: lateEntered, lateStarted: lateStarted,
           lateElapsed: lateElapsed, cutDlg: cutDlg, cutArea: cutArea,
           cutEntered: cutEntered, cutMissing: cutMissing,
           limit: EXAM_ENTRY_LIMIT, margin: EXAM_RUSH_MARGIN };
})()`);
console.log('  入场截止: ' + JSON.stringify(entryLimit));

/* 把世界还原成"刚进校园、还没安检"，别让后面校园段那几条断言
   吃我这里留下的 enteredRoom / passedSecurity（第一版没还原，
   结果后面"门口按 E 没弹出安检窗"直接红了）。 */
await evaluate(`(() => {
  dismissDialogs();
  if (typeof phoneUI !== 'undefined') phoneUI.classList.add('hidden');
  state.view = 'world';
  state.enteredRoom = false; state.sneakedIn = false;
  state.passedSecurity = false; state.hasPhone = true;
  state.area = 'campus'; state.bounds = AREA_BOUNDS.campus;
  state.pos.x = CP.x + CAMPUS_SPAWN.x;
  state.pos.z = CP.z + CAMPUS_SPAWN.z;
  state.yaw = 0; yawTarget = 0; state.pitch = 0; pitchTarget = 0;
  state.elapsed = 0;
  state.examStarted = false; state.admitElapsed = 0;
  state.missedEntry = false; state.entryWarned = false; state.ended = false;
  return 1;
})()`);

/* 真跑一遍完整流程：门口 E → 选选项 → 再看提示 → E → 进 404
   ------------------------------------------------------------------
   每个 await evaluate 之间都会让出事件循环，**真实的 rAF 主循环会在缝隙里
   跑上几帧**：它按当时玩家的位置重算并刷新 camera.matrixWorld。
   所以这里绝不能依赖"上一段测试刚好把相机留在合适的位置" ——
   必须自己 updateMatrixWorld(true)，否则射线用的是别人留下的旧矩阵。
   （之前它没写这句，只是碰巧前一个 reach 测试把玩家停在门口 1m 处，
     于是渲染循环留下的矩阵恰好也能瞄到 —— 加了"跑路"探针把玩家挪到校门外
     之后，这个隐藏依赖立刻暴露成"门口按 E 没反应"。） */
const campusFlow = await evaluate(`(() => {
  const log = [];
  state.pos.x = CP.x; state.pos.z = CP.z + CAMPUS_AUDIT_Z + 1.6;
  state.yaw = 0; yawTarget = 0; state.pitch = 0; pitchTarget = 0;
  state.passedSecurity = false; state.enteredRoom = false; state.examStarted = false;
  dismissDialogs();
  updatePlayer(0);
  camera.updateMatrixWorld(true);        /* 见上面的注释：别用别人的旧矩阵 */
  updateInteract();
  log.push('提示=' + String(promptEl.textContent || '').slice(0, 18));
  doInteract('e');
  log.push('弹窗=' + dialogs.length);
  if (dialogs.length) selectDialogOption(0);
  log.push('选完:弹窗=' + dialogs.length + ' 安检=' + state.passedSecurity + ' 区域=' + state.area);
  /* 已落在电梯间（hall1）：走到 404 门洞，走进房间 */
  state.pos.set(7.5, 1.65, 0);
  checkBuildingDoors();
  log.push('进404:区域=' + state.area + ' 弹窗=' + dialogs.length);
  return log;
})()`);
console.log('  实跑: ' + campusFlow.join('  |  '));
/* 还原：后面的"打老师 / 补给 / 停留进度环"都要在房间区域里跑。
   这里原来写的是 switchArea(s.area) —— 而 s.area 是**进校园段之前**抓的，
   也就是 'campus'。于是第 9 节之后所有探针其实都站在校园区域里，
   和这句注释说的正好相反；只是因为那几个探针都不读 state.area，一直没人发现。
   也不能把校园坐标一起还原回来：switchArea('room') 已经把玩家放到座位上，
   再覆盖成校园坐标，人就站在房间坐标系外面了。 */
await evaluate(`(() => {
  dismissDialogs();
  switchArea('room');
  state.enteredRoom = true;
  delete window.__campusSaved;
})()`);

console.log('\n== 9. 真实物理：一拳打爆监考老师 ==');
const punch = await evaluate(`(() => {
  const t = teacher;
  if (!t) return { err: '没有 teacher' };
  state.pos.x = t.group.position.x + 1.2;
  state.pos.z = t.group.position.z;
  state.yaw = Math.atan2(-(t.group.position.x - state.pos.x), -(t.group.position.z - state.pos.z));
  /* 观测窗口内先临时调慢保安：默认速度已经接近疾跑，1.5 秒就会把玩家抓住并清场，
     那样"保安刷出"就观察不到了。5 秒后由 afterPunch 还原。 */
  window.__gScaleSave = guardSpeedScale;
  guardSpeedScale = 0.12;
  punchTeacher();
  return { teacherDown: state.teacherDown, hpVisible: state.hpVisible, hp: state.hp,
           debris: debrisList.length, guards: securityGuards.length };
})()`);
console.log('  命中瞬间: ' + JSON.stringify(punch));
/* 保安是延时增援（不是同帧刷出），所以要等超过那个延迟再看 */
const afterPunch = await evaluate(`(() => new Promise(r => setTimeout(() => {
  /* 观测结束：把保安速度还原（观测期间临时调慢，免得它们 1.5 秒就把玩家抓走） */
  if (window.__gScaleSave !== undefined){ guardSpeedScale = window.__gScaleSave; delete window.__gScaleSave; }
  r({
    debris: debrisList.length,
    guards: securityGuards.length,
    tension: +getTension().toFixed(3),
    filter: document.getElementById('scene').style.filter || '（无）',
    vignette: document.getElementById('tenseVignette').style.opacity || '0',
    hpBarVisible: !document.getElementById('hpBar').classList.contains('hidden')
  });
}, 5000)))()`);
console.log('  5s 后（等增援到位）: ' + JSON.stringify(afterPunch));

console.log('\n== 9.5 背包 / 物品栏（真 DOM · 真按键） ==');
/* smoke.mjs 的 DOM 是自造的桩：它能证明数据模型对不对，
   证明不了"#hotbar 里到底有没有 4 个格子""按 B 到底开不开"。
   这一节专门盯这些只能靠真 DOM 才看得出来的东西。 */
const bagUI = await evaluate(`(() => {
  const log = {};
  try { hideAllPanels(); } catch(e){}
  state.view = 'world'; state.ended = false; state.frozen = false;
  initBag();

  const hb = document.getElementById('hotbar');
  log.格子数 = hb.querySelectorAll('.slot').length;
  log.快捷栏可见 = !hb.classList.contains('hidden');
  log.首格 = (hb.querySelector('.slot') || {}).textContent || '';
  const n0 = hb.querySelector('.slot .n');
  log.首格数量 = n0 ? n0.textContent : '';

  /* ---- 真按 B 开背包 ---- */
  document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyB', bubbles: true }));
  log.开包后_view = state.view;
  log.背包可见 = !document.getElementById('bagUI').classList.contains('hidden');
  log.物品条目 = document.querySelectorAll('#bagGrid .bitem').length;

  /* ---- 点第 4 个快捷栏格子，再把「臭水」放进去（测交换，不是覆盖） ---- */
  const bslots = document.querySelectorAll('#bagSlots .bslot');
  if (bslots[3]) bslots[3].onclick();
  log.选中格 = state.hotbarIdx;
  const firstItem = document.querySelector('#bagGrid .bitem');
  if (firstItem) firstItem.onclick();
  log.交换后快捷栏 = state.hotbar.slice().join(',');

  /* ---- 关包 ---- */
  document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyB', bubbles: true }));
  log.关包后_view = state.view;
  log.关包后隐藏 = document.getElementById('bagUI').classList.contains('hidden');

  /* ---- 滚轮切格：数字键已经让给弹窗选项，切格只能靠滚轮 ----
     这里派发的是真的 WheelEvent，走 main.js 挂在 window 上的监听器，
     不是直接调 cycleHotbar —— 否则"监听器压根没挂上"就测不出来。 */
  const wheelTo = (want) => {
    let last = state.hotbarIdx, guard = 0;
    while (state.hotbarIdx !== want && guard++ < 12){
      const dir = (want - state.hotbarIdx + HOTBAR_SLOTS) % HOTBAR_SLOTS <= HOTBAR_SLOTS / 2 ? 1 : -1;
      document.dispatchEvent(new WheelEvent('wheel', {
        deltaY: dir * 120, bubbles: true, cancelable: true
      }));
      if (state.hotbarIdx === last) break;      /* 卡住就别死循环 */
      last = state.hotbarIdx;
    }
    return state.hotbarIdx;
  };

  /* 数字键不该再抢快捷栏 */
  wheelTo(0);
  document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit3', bubbles: true }));
  log.数字键没抢格 = (state.hotbarIdx === 0);

  /* ---- 滚到空格，按 Q 不该有任何消耗 ---- */
  log.空格索引 = wheelTo(0);
  const beforeEmpty = JSON.stringify(state.bag);
  document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyQ', bubbles: true }));
  log.空格按Q无消耗 = (JSON.stringify(state.bag) === beforeEmpty);

  /* ---- 滚到臭水那一格，按 Q 真扔出去 ---- */
  log.臭水索引 = wheelTo(3);
  const before = bagCount('stink');
  document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyQ', bubbles: true }));
  log.扔前 = before;
  log.扔后 = bagCount('stink');
  /* 读玩家真正看得见的那句字幕。以前这里写的是 __OI__.lastToast() ——
     那个方法根本不存在，所以字段永远返回空串，看着像"没问题"，其实什么都没测。 */
  const ts = document.getElementById('toastStack');
  const lastToastEl = ts ? ts.lastElementChild : null;
  log.最后一条提示 = lastToastEl ? String(lastToastEl.textContent || '').trim() : '';
  const badge = document.querySelectorAll('#hotbar .slot')[3];
  log.角标 = badge ? (badge.querySelector('.n') || {}).textContent : '';

  /* ---- 干呕姿势：桩能让 updateGuards 不报错，但不代表真实的 Object3D
         旋转真的被写进去了（head 引用拿错对象、父子关系不对，桩都看不出来）。 ---- */
  try {
    const g = securityGuards[0];
    if (g){
      g.userData.alive = true;
      g.group.position.set(state.pos.x + 2.5, 0, state.pos.z);
      g.group.rotation.z = 0;
      g.head.rotation.x = 0;
      g.userData.stinkUntil = state.worldTime + 2;
      updateGuards(1/60, 1.0);
      log.干呕_身体歪 = +(g.group.rotation.z).toFixed(3);
      log.干呕_头低 = +(g.head.rotation.x).toFixed(3);
      g.userData.stinkUntil = 0;
      updateGuards(1/60, 1.02);
      log.解除_身体歪 = +(g.group.rotation.z).toFixed(3);
      log.解除_头低 = +(g.head.rotation.x).toFixed(3);
    } else {
      log.干呕_身体歪 = '没有保安可测';
    }
  } catch(e){ log.干呕_身体歪 = '异常：' + e.message; }

  initBag();   /* 还原，别把后面几节的状态带走 */
  renderHotbar();

  /* ---- 提示条不能压在快捷栏上（窗口一矮就叠） ---- */
  const pr = document.getElementById('prompt');
  const prWasHidden = pr.classList.contains('hidden');
  pr.classList.remove('hidden');
  pr.textContent = '样例提示文字';
  const rb = hb.getBoundingClientRect(), rp = pr.getBoundingClientRect();
  log.提示条下沿 = Math.round(window.innerHeight - rp.bottom);
  log.快捷栏上沿 = Math.round(window.innerHeight - rb.top);
  log.窗口高 = window.innerHeight;
  if (prWasHidden) pr.classList.add('hidden');

  /* ---- 地面补给：真 three.js 里真的进场景、真的走过去捡得到 ---- */
  try {
    ensurePickups();
    log.补给数 = pickups.length;
    log.补给应有 = PICKUP_SPOTS.length;   /* 期望值从数据推，不写死 */
    log.补给在场景里 = pickups.length ? (pickups[0].mesh.parent === scene) : false;
    const t0 = pickups.filter(p => p.id === 'water')[0] || pickups[0];
    if (t0){
      const beforeN = bagCount(t0.id);
      /* 还原用：先记下原来站的地方 */
      const sx = state.pos.x, sz = state.pos.z;
      state.pos.x = t0.x; state.pos.z = t0.z;
      log.捡取条件 = {
        view: state.view, area: state.area, started: state.started,
        ended: state.ended, frozen: state.frozen,
        dist: +Math.hypot(state.pos.x - t0.x, state.pos.z - t0.z).toFixed(3),
        id: t0.id, n: t0.n, 半径: PICKUP_RADIUS
      };
      updatePickups(1/60, 0);
      log.走过去捡到 = bagCount(t0.id) - beforeN;
      log.捡完还剩 = pickups.length;
      state.pos.x = sx; state.pos.z = sz;
    }
  } catch(e){ log.补给数 = '异常：' + e.message; }

  /* ---- 打死保安掉的补给：玩家看不看得见（这是用户实测报上来的那条） ---- */
  try {
    initBag();
    pickups.length = 0; pickupsPlaced = true;
    /* 先用光一摞臭水 —— 这一步会把快捷栏那一格清空，正是 bug 的触发条件 */
    state.hotbarIdx = 0;
    for (let i = 0; i < 3; i++) useSelectedItem();
    log.用光后_臭水格 = state.hotbar[0];

    /* 模拟"打死第 3 个保安"：掉一瓶臭水在他倒下的地方，然后人走过去 */
    maybeDropFromGuard(3, state.pos.x, state.pos.z);
    log.掉落数 = pickups.length;
    updatePickups(1/60, 0);
    log.捡后_数量 = bagCount('stink');
    log.捡后_在快捷栏 = state.hotbar.indexOf('stink') >= 0;
    const badge2 = document.querySelectorAll('#hotbar .slot');
    const bi = state.hotbar.indexOf('stink');
    log.捡后_角标 = bi >= 0 && badge2[bi]
      ? ((badge2[bi].querySelector('.n') || {}).textContent || '') : '';
    log.捡后_提示 = String((document.getElementById('toastStack').dataset || {}).last || '');

    /* 真打一个：killGuard → maybeDropFromGuard → addPickup 这条链要真的通，
       不能只在"手动调掉落函数"这一层验。 */
    const savedKills = state.guardKills;
    state.guardKills = 2;                 /* 下一个打死就是第 3 个，必然掉臭水 */
    const g0 = pickups.length;
    const victim = securityGuards.filter(x => x.userData.alive)[0];
    if (victim) killGuard(victim);
    log.真打死第3个_掉落 = pickups.length - g0;
    log.真打死第3个_击杀数 = state.guardKills;
    state.guardKills = savedKills;
  } catch(e){ log.用光后_臭水格 = '异常：' + e.message; }

  return log;
})()`);
console.log('  ' + JSON.stringify(bagUI));

console.log('\n== 9.4 同学的电脑：开的是他的，不是你的 ==');
/* 真浏览器里的交互挂在 buildDesk 建的 mesh 上 —— smoke 用的是自造桩，
   证明不了"每张桌子真的各自挂了自己的动作"。这里查的就是那批真 mesh。 */
const classPC = await evaluate(`(() => {
  const log = {};
  try {
    hideAllPanels();
    state.view = 'world'; state.area = 'room'; state.bounds = AREA_BOUNDS.room;
    state.ended = false; state.frozen = false;

    const faces = interactables.filter(o => o.userData && o.userData.interact &&
                                            /电脑|桌面/.test(o.userData.interact.label));
    log.总数 = faces.length;
    log.桌面 = faces.filter(o => o.userData.interact.label.indexOf('CSP-S114514') >= 0).length;
    log.看别人 = faces.filter(o => o.userData.interact.label.indexOf('看一眼') >= 0).length;
    log.看别人的标签 = faces
      .filter(o => o.userData.interact.label.indexOf('看一眼') >= 0)
      .map(o => o.userData.interact.label);

    /* 真人不在时点它：应该打开他那一台（标题是他的名字） */
    const target = faces.find(o => o.userData.interact.label.indexOf('看一眼') >= 0);
    const saved = npcs.map(n => n.userData.state);
    npcs.forEach(n => { n.userData.state = 'seated'; });
    if (target) target.userData.interact.action();
    log.坐着_view = state.view;

    npcs.forEach(n => { n.userData.state = 'away'; });
    if (target) target.userData.interact.action();
    log.走了_view = state.view;
    const head = document.getElementById('npcCompHead');
    log.走了_标题 = head ? String(head.textContent || '') : '';
    const tag = document.getElementById('npcCompTag');
    log.走了_标签 = tag ? String(tag.textContent || '') : '';
    closeNPCComputer();
    npcs.forEach((n, i) => { n.userData.state = saved[i]; });
    state.view = 'world';
  } catch(e){ log.异常 = String(e && e.message || e); }
  return log;
})()`);
console.log('  ' + JSON.stringify(classPC));
if (classPC.异常) problems.push('同学的电脑这一节抛异常：' + classPC.异常);
if (classPC.桌面 !== 1)
  problems.push('能把桌面（CSP-S114514）开起来的应只有你自己那台，实际 ' + classPC.桌面 + ' 台');
if (classPC.看别人 !== 5)
  problems.push('五台同学的电脑没有各自的"看一眼"，实际 ' + classPC.看别人 + ' 台');
if (classPC.坐着_view !== 'world')
  problems.push('同学还坐着就把他的电脑打开了（view=' + classPC.坐着_view + '）');
if (classPC.走了_view !== 'npcComputer')
  problems.push('同学走了却打不开他的电脑（view=' + classPC.走了_view + '）');
if (String(classPC.走了_标题).indexOf('的电脑') < 0)
  problems.push('打开的面板标题不是"某个人的电脑"：' + classPC.走了_标题);
if (String(classPC.走了_标题).indexOf(classPC.看别人的标签[0] || '看一眼') >= 0)
  problems.push('面板标题直接把标签塞进去了：' + classPC.走了_标题);

console.log('\n== 9.6 对手 · 名次 · 老师的眼睛（真 DOM / 真引擎） ==');
/* 名次：HUD 是 animate 每帧画的，所以改完状态要让出一帧再看 DOM —— 
   直接读会读到上一帧的内容。 */
await evaluate(`(() => {
  state.area = 'room'; state.started = true; state.ended = false;
  state.totalScore = 320;
  hudScore.dataset.key = '';        /* 逼它下一帧重画 */
})()`);
await sleep(140);
const rankUI = await evaluate(`(() => {
  /* 先让 HUD 真的可见。上一次量到 0px —— 元素在 display:none 的祖先里时
     getBoundingClientRect 全返回 0，那条"单行"断言就白过了。 */
  hud.classList.remove('hidden');
  const r = hudScore.getBoundingClientRect();
  /* "折没折行"用差分判据：强制 nowrap 前后高度变不变。
     不用任何像素阈值 —— 这一行里有个 18px 的 <b>，单行高 44px，
     拿 h<34 当判据会误报；按矩形 top 去重也会误报，因为 18px 的内联盒
     和 13px 正文的 top 差 2~3px，看着像两行。 */
  const oneLine = (() => {
    const prev = hudScore.style.whiteSpace;
    const h0 = hudScore.getBoundingClientRect().height;
    hudScore.style.whiteSpace = 'nowrap';
    const r1 = hudScore.getBoundingClientRect();
    hudScore.style.whiteSpace = prev;
    return { same: Math.abs(h0 - r1.height) < 1,
             h0: Math.round(h0), h1: Math.round(r1.height),
             w: Math.round(r1.width) };
  })();
  return {
    text: String(hudScore.textContent || ''),
    count: rivalCount(),
    rank: playerRank(state.elapsed),
    oneLine: oneLine,
    h: Math.round(r.height),
    w: Math.round(r.width),
    vw: innerWidth,
    rightEdge: Math.round(r.right),
    probsLeft: Math.round(document.getElementById('hudProbs').getBoundingClientRect().left),
    visible: r.height > 0
  };
})()`);
console.log('  HUD 总分行: ' + rankUI.text + '　（rank=' + rankUI.rank + ' / ' + rankUI.count +
            '，高 ' + rankUI.h + 'px　' + (rankUI.oneLine.same ? '单行' : '折行了！') + '）');
console.log('  布局: 盒子 ' + rankUI.w + 'px（nowrap 时 ' + rankUI.oneLine.w + 'px），视口 ' + rankUI.vw +
            'px，右缘 ' + rankUI.rightEdge + ' vs 右栏左缘 ' + rankUI.probsLeft);

/* ---- 名次变化必须出声，而且战况里要看得到榜首 ----
   "我怎么一直是第一名、从没看见别人得分" 这条反馈的另一半：
   名次变了却什么都不说，敌人涨分你却看不出。 */
const rankFeedback = await evaluate(`(async () => {
  const log = {};
  const wait = ms => new Promise(r => setTimeout(r, ms));
  state.area = 'room'; state.started = true; state.ended = false;
  /* 必须把比赛时钟推到"已经有人交过卷"的位置 —— 开跑半秒时全场都是 0 分，
     那时排第一是**正确**的，测不出"被超过"。 */
  const savedElapsed = state.elapsed;
  state.elapsed = CONTEST_LEN * 0.3;
  state.totalScore = 0;
  state.lastRank = 0;
  hudScore.dataset.key = '';
  await wait(180);
  log.firstRank = state.lastRank;
  log.bottomText = String(hudScore.textContent || '');

  /* 分数抬到最高：应当出现"你超过了 X" */
  state.totalScore = 9999;
  hudScore.dataset.key = '';
  await wait(180);
  const ts = document.getElementById('toastStack');
  log.toast = ts && ts.dataset ? String(ts.dataset.last || '') : '';
  log.rankStillFirst = playerRank(state.elapsed) === 1;

  /* 战况面板：别人在榜首时，要写出他是谁、多少分 */
  state.totalScore = 0;
  state.phoneTab = 'status';
  openPhone();
  phoneRender();
  log.statusBehind = String(document.getElementById('phRank').textContent || '');
  closePhone();

  state.totalScore = 320;
  state.elapsed = savedElapsed;
  state.lastRank = 0;
  hudScore.dataset.key = '';
  return log;
})()`);
console.log('  名次反馈: ' + JSON.stringify(rankFeedback));

const peekUI = await evaluate(`(() => {
  const log = {};
  const hadTeacher = !!teacher;
  if (!teacher) teacher = buildTeacher(2.4, 0);
  const saved = { view: state.view, warn: state.warnCount, wt: state.worldTime,
                  x: state.pos.x, z: state.pos.z, mode: teacher.userData.mode,
                  area: state.area, ended: state.ended };
  try {
    state.area = 'room'; state.ended = false; state.frozen = false;
    state.pos.x = SEAT_CENTER_X; state.pos.z = SEAT_CENTER_Z;
    state.view = 'world';
    teacher.userData.mode = 'patrol';
    state.warnCount = 0;
    state.worldTime = 500;

    /* 走真实入口打开桌面，而不是手改 state.view —— 这才是在验玩家看见的那条路 */
    openDesktop();
    log.开桌面_view = state.view;
    log.开桌面_可见 = !desktopUI.classList.contains('hidden');

    const T_NEAR = Math.PI * 1.5 / 0.15;   /* 巡逻轨迹最靠近座位的时刻 */
    updateTeacherWhenPaused(T_NEAR);

    log.被抓_view = state.view;
    log.被抓_警告 = state.warnCount;
    log.被抓_桌面隐藏 = desktopUI.classList.contains('hidden');
    log.被抓_距离 = +Math.hypot(teacher.group.position.x - state.pos.x,
                                teacher.group.position.z - state.pos.z).toFixed(2);
    log.提示 = String((document.getElementById('toastStack').dataset || {}).last || '');
  } finally {
    state.view = saved.view; state.warnCount = saved.warn;
    state.worldTime = saved.wt; state.area = saved.area; state.ended = saved.ended;
    state.pos.x = saved.x; state.pos.z = saved.z;
    teacher.userData.mode = saved.mode;
    if (!hadTeacher){ closeDesktop(); scene.remove(teacher.group); teacher = null; }
  }
  return log;
})()`);
console.log('  ' + JSON.stringify(peekUI));

console.log('\n== 10. 停留进度环：鼠标提前关掉弹窗后必须消失（真 three.js / 真事件） ==');
/* smoke.mjs 那条断言走的是同一段逻辑，但用的是 DOM 桩。
   这里再跑一遍真的 MouseEvent，确认真实浏览器里这条链路也成立 ——
   它对应玩家看得见的症状："那个圆圈一直停在屏幕上"。 */
const dwell = await evaluate(`(() => {
  dismissDialogs();
  state.view = 'world';
  state.passedSecurity = false;          /* doSecurityCheck 里有已过安检就早退的保护 */
  doSecurityCheck();
  if (!dialogs.length) return { err: '安检没弹出窗，探针前置不成立' };

  const dlg = dialogs[dialogs.length - 1];
  dlg.buttons = dlg.buttons.length ? dlg.buttons : [{ x:0, y:0, w:10, h:10, label:'x' }];
  dlgHoverBtn = { dlg: dlg, idx: 0 };
  dwellProgress = 0.5; dwellKey = dlg.id + ':0';   /* 视线停了一半就点鼠标 */

  const before = dialogDwell().progress;
  const el = renderer.domElement;
  const orig = el.requestPointerLock;
  el.requestPointerLock = function(){ return undefined; };
  try { el.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true })); }
  finally { el.requestPointerLock = orig; }

  const after = dialogDwell().progress;            /* 不跑帧，直接看状态 */
  updateReticle(1/60);
  return { before: before, after: after, closed: !hasDialog(),
           reticleVisible: reticle.visible, ringVisible: retRing.visible };
})()`);
console.log('  ' + JSON.stringify(dwell));

console.log('\n== 11. 小恐龙：一次跳跃真的能过仙人掌（真浏览器） ==');
const dino = await evaluate(`(() => {
  openDesktop(); dinoOpen();
  const DX = 26 * DINO.PX, DW = 22 * DINO.PX, SPEED = 320;
  const rows = [];
  for (const spec of DINO_OBS.filter(s => s.kind === 'cactus')){
    let win = 0;
    for (let gap = 300; gap >= 0; gap -= 2){
      dinoReset(); dinoRunning = true; dinoOver = false; dinoSpeed = SPEED;
      dinoSpawnAt = 1e9; dinoObs.length = 0;
      dinoObs.push({ kind: spec.kind, x: DX + DW + gap + 700, w: spec.w, h: spec.h });
      let jumped = false, ok = true;
      for (let f = 0; f < 4000; f++){
        const cur = dinoObs[0]; if (!cur) break;
        if (!jumped && (cur.x + 4) - (DX + DW) <= gap){ dinoJump(); jumped = true; }
        dinoStep(1/60);
        if (dinoOver){ ok = false; break; }
        if (cur.x + cur.w < -20) break;
      }
      if (ok && !dinoOver) win += 2;
    }
    rows.push({ id: spec.id, h: spec.h, win: win });
  }
  /* 用固定步长积分算顶点，和 smoke 里那份算法一致，互相印证 */
  let v = DINO.JUMP_V, y = 0, apex = 0;
  for (let i = 0; i < 2000 && (v > 0 || y > 0); i++){
    v -= DINO.G / 60; y += v / 60; if (y > apex) apex = y; if (y <= 0) break;
  }
  dinoStop();
  return { rows: rows, apex: +apex.toFixed(1), jumpV: DINO.JUMP_V };
})()`);
console.log('  跳跃顶点 ' + dino.apex + 'px（JUMP_V=' + dino.jumpV + '，速度取最慢的 320px/s）');
dino.rows.forEach(r => console.log('  ' + r.id + ' h=' + r.h + ' 起跳窗口=' + r.win + 'px'));

console.log('\n== 12. 渲染对齐：小恐龙和障碍"画出来的"必须和"会撞的"一致 ==');
const align = await evaluate(`(() => {
  openDesktop(); dinoOpen();
  const ctx = dinoCanvas.getContext('2d');
  const W = DINO.W, H = DINO.H;
  const clear = () => { ctx.fillStyle = '#f7f7f7'; ctx.fillRect(0, 0, W, H); };
  const scan = () => {
    const d = ctx.getImageData(0, 0, W, H).data;
    let top = null, bottom = null, left = null, right = null;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++){
      const i = (y * W + x) * 4;
      if ((d[i] + d[i+1] + d[i+2]) / 3 < 160){
        if (top === null || y < top) top = y;
        if (bottom === null || y > bottom) bottom = y;
        if (left === null || x < left) left = x;
        if (right === null || x > right) right = x;
      }
    }
    return { top: top, bottom: bottom, left: left, right: right };
  };
  const s = DINO.PX, bodyX = 26 * s;
  const poses = {};
  /* 身体和腿**分开画**，才量得出"腿到底接在哪儿" */
  for (const p of [{ n: '站立', duck: false, sq: 1 }, { n: '蹲下', duck: true, sq: DINO_SQUASH }]){
    const bodyY = DINO.GROUND - DINO_BODY.length * s * p.sq - 12;
    clear(); dinoDrawShape(ctx, bodyX, bodyY, s, p.duck);
    const body = scan();
    /* 五官：眼睛和嘴是位图里挖的洞。以前每行多画 0.6px 会把一行的洞糊死，
       只能另画一个白方块顶替眼睛 —— 所以这里必须逐像素验它是空的。 */
    const darkIn = (x, y, w, h) => {
      const d = ctx.getImageData(x, y, w, h).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if ((d[i] + d[i + 1] + d[i + 2]) / 3 < 160) n++;
      return n;
    };
    if (p.n === '站立'){
      /* 坐标跟位图绑定：眼在列 19..20 / 行 2..3，嘴是列 25..31 / 行 8 的前缘缺口。
         位图一改就得跟着改，所以 dinoart.mjs 的字符画是这两个数字的来源。 */
      poses.眼睛 = darkIn(bodyX + 19 * s, bodyY + 2 * s, 2 * s, 2 * s);
      poses.嘴 = darkIn(bodyX + 26 * s, bodyY + 8 * s, 4 * s, s);
    }
    clear(); dinoDrawLegs(ctx, bodyX + 4 * s, bodyY, s, p.duck, 0);
    const legs = scan();
    poses[p.n] = { 腿脱节: legs.top - body.bottom, 腿穿地: legs.bottom - DINO.GROUND };
  }
  /* 每个障碍、每种姿态：判定盒有没有伸到画面之外（= 隐形杀伤区），画面有没有画穿地面 */
  const bad = [];
  for (const spec of DINO_OBS){
    const o = { kind: spec.kind, x: 400, w: spec.w, h: spec.h };
    if (spec.kind === 'bird'){
      for (const fr of [0, 1]) for (const dy of DINO_BIRD_HEIGHTS){
        o.y = DINO.GROUND + dy;
        clear(); dinoDrawBird(ctx, o, fr);
        const vis = scan(), g = dinoBirdGeom(o);
        const over = Math.max(0, vis.left - g.left) +
                     Math.max(0, (g.right - 1) - vis.right) +
                     Math.max(0, vis.top - g.top);
        const below = vis.bottom - DINO.GROUND;
        if (over > 0 || below > 0)
          bad.push(spec.id + ' dy=' + dy + ' 帧' + fr + ' 盒超出=' + over + ' 画穿地=' + below);
      }
    } else {
      clear(); dinoDrawCactus(ctx, o);
      const vis = scan(), g = dinoCactusGeom(o);
      const over = Math.max(0, vis.left - g.left) +
                   Math.max(0, (Math.ceil(g.right) - 1) - vis.right) +
                   Math.max(0, vis.top - g.top);
      const below = vis.bottom - DINO.GROUND;
      if (over > 0 || below > 0) bad.push(spec.id + ' 盒超出=' + over + ' 画穿地=' + below);
    }
  }
  const r = dinoCanvas.getBoundingClientRect();
  return { poses: poses, bad: bad,
           缩放: [+(r.width / W).toFixed(4), +(r.height / H).toFixed(4)],
           imageRendering: getComputedStyle(dinoCanvas).imageRendering };
})()`);
console.log('  站姿/蹲姿 腿与身体关系: ' + JSON.stringify(align.poses));
console.log('  画布 内部→显示 缩放 = ' + align.缩放.join(' × ') +
            '   image-rendering=' + align.imageRendering);
console.log('  判定盒伸出画面之外的障碍: ' + (align.bad.length ? align.bad.join(' | ') : '无'));

console.log('\n== 12.5 结算：名次与榜单（真 DOM） ==');
/* 放在最后做：endContest 会清存档、清保安、置 ended，
   放在中间会把后面几节的前提全拆掉。 */
const boardUI = await evaluate(`(() => {
  /* endContest 是按 state.score 逐题累加的，改 state.totalScore 不算数 ——
     这里把四题都设成 80，总分确定是 320，断言才有可比性。 */
  state.problems.forEach(p => { state.score[p.id] = 80; });
  state.totalScore = 320;
  endContest(true);
  return {
    title: String(endTitle.textContent || ''),
    sub: String(endSub.textContent || ''),
    detail: String(endDetail.textContent || ''),
    score: String(endScore.textContent || ''),
    visible: !endingUI.classList.contains('hidden')
  };
})()`);
console.log('  标题: ' + boardUI.title + '　副标题: ' + boardUI.sub);
console.log('  榜单: ' + boardUI.detail.split('\n').filter(l => l.indexOf('名') >= 0).join(' | '));

console.log('\n== 13. 结论 ==');
const realErrors = errors.filter(e => !/favicon|404/.test(e));
const problems = [];
/* ---- 开始界面：按钮必须在视口里，滚轮不能被抓 ----
   这两条量的时候还没点"进入考场"，坏了就是肉眼可见的进不去。 */
if (!startUI || startUI.err)
  problems.push('开始界面没量到：' + ((startUI && startUI.err) || '缺失'));
else {
  if (startUI.btnTop < 0 || startUI.btnBottom > startUI.vh + 0.5)
    problems.push('「进入考场」按钮不在视口里（top=' + startUI.btnTop +
                  ' bottom=' + startUI.btnBottom + ' 视口高=' + startUI.vh +
                  '）—— 玩家得先往下滚才点得到');
  if (startUI.pageScrollH > startUI.vh + 1)
    problems.push('整个页面还要滚动（' + startUI.pageScrollH + ' > ' + startUI.vh +
                  '）：滚动该关在 .card 里');
  if (startUI.startScrollH > startUI.startClientH + 1)
    problems.push('#start 自己还在滚（' + startUI.startScrollH + ' > ' +
                  startUI.startClientH + '）：overflow 该是 hidden');
  if (startUI.wheelStole)
    problems.push('开始界面上滚轮被快捷栏吃了（hotbarIdx 变了）—— 这就是"滚轮用不了"');
}
if (realErrors.length) problems.push('未捕获异常 ' + realErrors.length + ' 处');
if (!probe.hasOI) problems.push('__OI__ 未挂载');
if (!probe.threeRev) problems.push('three 未加载');
if (probe.bootErrText) problems.push('出现了启动失败横幅');if (!dlg.open) problems.push('弹窗没打开');
if (!/中/.test(reach.join(' '))) problems.push('门口的真射线完全瞄不到安检门（进不了楼）');
if (campusFlow[1] !== '弹窗=1') problems.push('门口按 E 没弹出安检窗：' + campusFlow[1]);
if (!/弹窗=0 安检=true 区域=hall1/.test(campusFlow[2]))
  problems.push('选完选项没关窗/没落在电梯间（输入会被永久吞掉）：' + campusFlow[2]);
if (!/区域=room/.test(campusFlow[3])) problems.push('没能走进 404 教室：' + campusFlow[3]);

/* 员工通道 / 手机：这条路必须真的走得通，否则"不正规入场"又是一个空名字 */
if (sideDoor.kind !== 'sidedoor')
  problems.push('夹道里瞄不到员工通道的门（射线命中 ' + (sideDoor.kind || '空') +
                '，距离 ' + sideDoor.dist + '）');
if (!/员工通道/.test(sideDoor.prompt))
  problems.push('对着侧门没出"员工通道"提示：' + sideDoor.prompt);
if (sideDoor.fn !== 'enterSideDoor')
  problems.push('对着侧门按 E 挂的不是 enterSideDoor：' + sideDoor.fn);
if (sideDoor.area !== 'room')
  problems.push('从员工通道没能进楼（区域还是 ' + sideDoor.area + '）');
if (!sideDoor.sneaked || !sideDoor.ach)
  problems.push('进了楼却没记成"不正规入场"');
if (sideDoor.passedSecurity) problems.push('走侧门不该把安检标记成已过');
if (!sideDoor.hasPhone) problems.push('走侧门进来手机却没了 —— 这条路就没意义了');
if (sideDoor.broom !== 1) problems.push('走侧门没拿到扫把（实际 ' + sideDoor.broom + ' 把）');
if (sideDoor.leftoverDlg) problems.push('侧门弹窗没关掉，输入会被吞');

if (!phoneFlow.opened || !phoneFlow.visible)
  problems.push('带着手机按 P 掏不出来');
if (!phoneFlow.hasName) problems.push('手机面板里没有题目行');
if (!/^\d+x\d+$/.test(phoneFlow.box) || +phoneFlow.box.split('x')[0] < 200)
  problems.push('手机面板没画出来（实际 ' + phoneFlow.box + '）');
/* 四个软件 */
if (phoneFlow.tabs !== 4) problems.push('手机应有四软件 tab，实际 ' + phoneFlow.tabs);
if (!/战况\/群聊\/2048\/计算器/.test(phoneFlow.tabNames))
  problems.push('tab 名字不对：' + phoneFlow.tabNames);
if (!phoneFlow.chatOn) problems.push('点「群聊」没切过去');
if (!phoneFlow.chatTabLit) problems.push('群聊 tab 没高亮');
if (phoneFlow.chatMsgs < 3) problems.push('群聊里只有 ' + phoneFlow.chatMsgs + ' 条消息');
if (!phoneFlow.chatHasSubmit) problems.push('群聊里没有"交了"这类进度消息');
if (!phoneFlow.chatHasRival) problems.push('群聊里没有对手的名字 —— 消息不是从 rivals 推的');
if (!phoneFlow.chatHasCameo) problems.push('群聊里没有客串角色（PHONE_CHAT_FLAVOR 没生效）');
if (!phoneFlow.chatFirstPin)
  problems.push('群聊第一条不是置顶的 Cherry_Pop（没有 .pin）—— 那句应该一打开就在最上面');
if (String(phoneFlow.chatFirstText).indexOf('Cherry_Pop') < 0 ||
    String(phoneFlow.chatFirstText).indexOf('又在摸鱼呢？') < 0)
  problems.push('群聊第一条不是「Cherry_Pop 又在摸鱼呢？」：' + phoneFlow.chatFirstText);
if (!phoneFlow.chatFirstNoClock)
  problems.push('置顶那条带了时间戳（会显示成比下面还晚，看着像 bug）');
if (!phoneFlow.calcOn) problems.push('点「计算器」没切过去');
if (phoneFlow.calcBefore !== '3') problems.push('计算器没随按键刷新（显示 ' + phoneFlow.calcBefore + '）');
if (phoneFlow.calcAfter !== '3') problems.push('计算器按 = 之后结果不是 3（显示 ' + phoneFlow.calcAfter + '）');
if (phoneFlow.divZero !== '错误') problems.push('计算器 1/0 没报错（显示 ' + phoneFlow.divZero + '）');
/* 2048：键盘真的能玩 */
if (!phoneFlow.gameOn) problems.push('点「2048」没切过去');
if (phoneFlow.cells !== 16) problems.push('2048 盘面不是 16 格（' + phoneFlow.cells + '）');
if (phoneFlow.boardBefore === phoneFlow.boardAfter)
  problems.push('按 ↑ 盘面没动 —— 方向键没路由到游戏');
if (phoneFlow.gameScore !== 4) problems.push('两个 2 竖着合并应得 4 分，实际 ' + phoneFlow.gameScore);
/* 手机得是真物品 */
if (phoneFlow.bagPhone !== 1) problems.push('背包里没有手机（' + phoneFlow.bagPhone + ' 台）');
if (!phoneFlow.hasPhoneFlag) problems.push('背包里有手机，hasPhone 却是假');
if (phoneFlow.bagAfterCatch !== 0)
  problems.push('被老师没收之后，背包里还留着手机（' + phoneFlow.bagAfterCatch + ' 台）');
if (!phoneFlow.stored) problems.push('掏了手机却没记"夹带"');
if (!phoneFlow.closed) problems.push('手机收不起来（会卡在 phone 视图）');
if (phoneFlow.dist > 3.4)
  problems.push('老师没站到位（离座位 ' + phoneFlow.dist + 'm，触发半径 3.4）');
if (!phoneFlow.caught) problems.push('在老师旁边看手机没触发"人赃并获"');
if (!phoneFlow.confiscated) problems.push('被老师抓到手机却没没收');
if (phoneFlow.viewAfter !== 'world' || !phoneFlow.panelHidden)
  problems.push('手机被没收了面板还开着（view=' + phoneFlow.viewAfter + '）');
if (phoneFlow.warned !== 1) problems.push('抓到看手机没记一次警告');

if (phoneAudit.hasPhoneAfterAudit)
  problems.push('过了安检手机还在兜里 —— 那"封存"是假的');
if (phoneAudit.view !== 'world')
  problems.push('没手机也把手机面板打开了（view=' + phoneAudit.view + '）');

/* 入场预留 */
if (entryLimit.limit !== 1800 || entryLimit.margin !== 180)
  problems.push('入场预留/压线窗口不对：' + entryLimit.limit + ' / ' + entryLimit.margin);
if (!/入场预留/.test(entryLimit.early))
  problems.push('校园提示里没有入场预留倒计时：' + entryLimit.early);
if (!/迟到/.test(entryLimit.late) || !/入场后剩/.test(entryLimit.late))
  problems.push('迟到后提示没有说明扣时：' + entryLimit.late);
if (entryLimit.lateFn !== 'enterSideDoor')
  problems.push('迟到时侧门的动作不对：' + entryLimit.lateFn);
if (entryLimit.lateArea !== 'room' || !entryLimit.lateEntered || !entryLimit.lateStarted)
  problems.push('迟到 1 分钟却进不去楼');
if (entryLimit.lateElapsed !== 60)
  problems.push('迟到 1 分钟进场后考试时钟不是 60：' + entryLimit.lateElapsed);
if (entryLimit.cutDlg.indexOf('考试已结束') < 0)
  problems.push('4.5 小时后侧门没弹「考试已结束」：' + entryLimit.cutDlg);
if (entryLimit.cutArea === 'room' || entryLimit.cutEntered)
  problems.push('4.5 小时后还能从侧门进楼 —— 时限是假的');
if (!entryLimit.cutMissing)
  problems.push('4.5 小时后没记 missedEntry');
if (!punch.teacherDown) problems.push('打老师没生效');
if (afterPunch.guards <= 0) problems.push('保安没刷出');
if (dwell.err) problems.push('进度环探针没跑起来：' + dwell.err);
else {
  if (!dwell.closed) problems.push('真浏览器里点鼠标没关掉弹窗');
  if (dwell.after > 0.002)
    problems.push('弹窗关了但停留进度还留着 ' + dwell.after + '（进度环会挂在屏幕上）');
  if (dwell.reticleVisible && dwell.ringVisible)
    problems.push('弹窗关了，准星外的进度环还亮着');
}
if (dino.apex < 82) problems.push('跳跃顶点只有 ' + dino.apex + 'px，跳不过仙人掌');
for (const r of dino.rows){
  if (r.win === 0) problems.push('这个障碍任何时机起跳都过不去：' + r.id + ' (h=' + r.h + ')');
  else if (r.win < 24) problems.push('起跳窗口只有 ' + r.win + 'px，实际上按不出来：' + r.id);
}

/* 渲染对齐：这几条以前全是错的 —— 蹲下时腿悬在身体下方 16px 还戳穿地面 13px；
   "成组仙人掌"的判定盒比画出来的宽 12~13px（没碰到就死）；
   低飞翼龙扇翅画到地面线以下 11px；画布被非整数拉伸 1.0111。 */
/* 判据是"中间有没有空出一行"，不是"下标是否完全相等"。
   身体最后一个像素在 233、腿从 234 起时差值是 1，但那是相邻 ——
   以前写成 !== 0，只是因为老绘制每行多画 0.6px 把身体底撑到了 234。
   差到 2 以上才是真的悬空。 */
if (align.poses.站立.腿脱节 > 1)
  problems.push('站立时腿没接在身体底部（差 ' + align.poses.站立.腿脱节 + 'px，中间空了一行）');
if (align.poses.蹲下.腿脱节 > 1)
  problems.push('蹲下时腿和身体脱节 ' + align.poses.蹲下.腿脱节 + 'px（会悬空）');
if (align.poses.眼睛 > 0)
  problems.push('眼睛那一格被糊住了（' + align.poses.眼睛 + ' 个深色像素）—— 恐龙没有五官');
if (align.poses.嘴 > 0)
  problems.push('嘴那条缝被糊住了（' + align.poses.嘴 + ' 个深色像素）');
if (align.poses.站立.腿穿地 > 0)
  problems.push('站立时腿画到地面线以下 ' + align.poses.站立.腿穿地 + 'px');
if (align.poses.蹲下.腿穿地 > 0)
  problems.push('蹲下时腿画到地面线以下 ' + align.poses.蹲下.腿穿地 + 'px');
if (align.bad.length)
  problems.push('障碍有隐形杀伤区 / 画穿地面：' + align.bad.join(' | '));
if (align.imageRendering !== 'pixelated')
  problems.push('画布丢了 image-rendering:pixelated（像素画会被插值糊掉）');
for (let i = 0; i < 2; i++){
  if (Math.abs(align.缩放[i] - Math.round(align.缩放[i])) > 0.001)
    problems.push('画布是非整数缩放 ' + align.缩放.join('×') +
                  '（像素画会出现摩尔纹、竖边粗细不匀）');
}

if (runaway.atSpawn) problems.push('成就「跑路了兄弟」在出生点站着就解锁了');
if (runaway.inside) problems.push('在校园里走着走着就解锁了「跑路了兄弟」');
if (runaway.atGate) problems.push('站在校门口就解锁了「跑路了兄弟」，应该跑到最外沿才算');
if (!runaway.fired) problems.push('跑到校园最外墙没解锁「跑路了兄弟」');
if (runaway.fired && !runaway.shown)
  problems.push('成就解锁了但弹窗没显示（achNotify 没加 show）');
if (runaway.fired && !runaway.有名字)
  problems.push('成就弹窗里没有名字「跑路了兄弟」');
if (runaway.fired && !runaway.有那句)
  problems.push('成就弹窗里没有那句「出发之后记得回来」');
if (runaway.fired && !runaway.回到门口)
  problems.push('成就触发后没被拎回校门口：落点 ' + runaway.落点);
if (runawayWalk.firedAt < 0)
  problems.push('从出生点一路按 S 往外跑，跑到底都没触发「跑路了兄弟」');
if (runawayWalk.firedAt >= 0 && !runawayWalk.瞬间被判回门口)
  problems.push('真实走路触发后没回到门口：触发瞬间落点 ' + runawayWalk.触发瞬间落点 +
                '，应为 ' + runawayWalk.门口站位);

/* 背包 / 物品栏：这些只有真 DOM 才测得出（smoke 用的是自造的桩） */
if (bagUI.格子数 !== 4) problems.push('快捷栏格数不是 4：' + bagUI.格子数);
if (!bagUI.快捷栏可见) problems.push('开局后快捷栏还是隐藏的');
if (bagUI.首格数量 !== '3')
  problems.push('快捷栏首格的数量角标不对：' + bagUI.首格数量 + '（应为 3）');
if (bagUI.开包后_view !== 'bag')
  problems.push('按 B 没打开背包（view=' + bagUI.开包后_view + '）');
if (!bagUI.背包可见) problems.push('按 B 之后 #bagUI 还是隐藏的');
if (bagUI.物品条目 !== 4)
  problems.push('背包里应有 4 种物品（3 种消耗品 + 手机），实际 ' + bagUI.物品条目);
if (bagUI.交换后快捷栏 !== ',water,spicy,stink')
  problems.push('把物品放进快捷栏时是覆盖而不是交换：[' + bagUI.交换后快捷栏 + ']');
if (bagUI.关包后_view !== 'world')
  problems.push('再按一次 B 没关掉背包（view=' + bagUI.关包后_view + '）');
if (!bagUI.关包后隐藏) problems.push('再按一次 B 之后 #bagUI 还挂在屏幕上');
if (bagUI.空格索引 !== 0) problems.push('滚轮回不到第 1 格（索引 ' + bagUI.空格索引 + '）');
if (!bagUI.数字键没抢格)
  problems.push('数字键还在改快捷栏 —— 会和弹窗的"按 2 选第二项"撞键');
if (!bagUI.空格按Q无消耗) problems.push('对着空的快捷栏格按 Q，却消耗了物品');
if (bagUI.扔前 - bagUI.扔后 !== 1)
  problems.push('按 Q 扔臭水，数量 ' + bagUI.扔前 + ' → ' + bagUI.扔后 + '（应恰好 -1）');
if (bagUI.角标 !== '2')
  problems.push('扔完之后快捷栏角标没跟着刷新：' + bagUI.角标 + '（应为 2）');
if (!bagUI.最后一条提示)
  problems.push('扔出臭水之后屏幕上没有半句反馈（玩家会以为没扔出去）');
if (bagUI.干呕_身体歪 === 0 || bagUI.干呕_头低 === 0)
  problems.push('被熏的保安没有任何干呕姿势（身体歪 ' + bagUI.干呕_身体歪 +
                ' / 头 ' + bagUI.干呕_头低 + '）—— 玩家看不出他废了');
if (bagUI.解除_身体歪 !== 0 || bagUI.解除_头低 !== 0)
  problems.push('臭水效果结束之后保安没站直（身体 ' + bagUI.解除_身体歪 +
                ' / 头 ' + bagUI.解除_头低 + '）');
if (!(bagUI.提示条下沿 >= bagUI.快捷栏上沿))
  problems.push('交互提示条压在快捷栏上：提示下沿距底 ' + bagUI.提示条下沿 +
                'px，快捷栏上沿距底 ' + bagUI.快捷栏上沿 + 'px（窗口高 ' + bagUI.窗口高 + 'px）');
/* 补给点数量跟着 PICKUP_SPOTS 走（现在是 3 补给 + 拖把 + 板凳）。
   写死数字会在每次加东西时误报 —— 断言只该管"每个点都真的挂进场景了"。 */
if (bagUI.补给数 !== bagUI.补给应有)
  problems.push('考场里的固定补给点数量不对：' + bagUI.补给数 +
                '（PICKUP_SPOTS 有 ' + bagUI.补给应有 + ' 条）');
if (!bagUI.补给在场景里)
  problems.push('补给物没有真的挂进场景（捡不到，也看不见）');
if (bagUI.走过去捡到 !== 1)
  problems.push('走到补给点上没捡到东西（背包 +' + bagUI.走过去捡到 + '）');
if (!(bagUI.捡完还剩 === bagUI.补给数 - 1))
  problems.push('捡走之后地上的补给数量不对：' + bagUI.补给数 + ' → ' + bagUI.捡完还剩);

/* 用光一摞 → 捡到保安掉的同种东西：必须回到快捷栏，玩家要看得见、按得出来 */
if (bagUI.用光后_臭水格 !== '')
  problems.push('前置条件不对：用光之后快捷栏那一格没被清空（' + bagUI.用光后_臭水格 + '）');
if (bagUI.掉落数 !== 1)
  problems.push('第 3 个保安没掉补给（场上 ' + bagUI.掉落数 + ' 个）');
if (bagUI.捡后_数量 !== 1)
  problems.push('走过去之后背包里没有臭水（数量 ' + bagUI.捡后_数量 + '）');
if (!bagUI.捡后_在快捷栏)
  problems.push('捡到了但没回到快捷栏 —— 玩家只看到提示，物品栏里还是空的（这就是用户报的那条）');
if (bagUI.捡后_角标 !== '1')
  problems.push('快捷栏角标没显示捡到的数量：[' + bagUI.捡后_角标 + ']（应为 1）');
if (bagUI.捡后_提示.indexOf('臭水') < 0)
  problems.push('捡东西的提示里没说是臭水：' + bagUI.捡后_提示);
/* 战斗中不该出现"去开背包整理物品"这种要玩家办手续的提示 ——
   正常玩（3 种物品 / 4 格）就不该有放不下的情况。 */
if (bagUI.捡后_提示.indexOf('按 B') >= 0)
  problems.push('捡东西的提示在战斗中要求玩家开背包：' + bagUI.捡后_提示);
if (bagUI.真打死第3个_掉落 !== 1)
  problems.push('真打死第 3 个保安掉了 ' + bagUI.真打死第3个_掉落 +
                ' 样东西（killGuard → 掉落这条链没通）');

/* ---- 名次 / 老师的眼睛 / 榜单 ---- */
if (rankUI.count !== 6)
  problems.push('全场人数应为 6（5 选手 + 你），实际 ' + rankUI.count);
if (rankUI.rank !== 1 && rankUI.text.indexOf('第 ' + rankUI.rank + '/' + rankUI.count + ' 名') < 0)
  problems.push('HUD 名次和 playerRank 对不上：' + rankUI.text);
if (!/超过/.test(String(rankFeedback.toast)))
  problems.push('名次变了却没有任何通报（toast="' + rankFeedback.toast +
                '"）—— 玩家永远只知道"我一直第一"');
if (rankFeedback.firstRank <= 1)
  problems.push('0 分时名次还是第 ' + rankFeedback.firstRank +
                ' —— 前沿条件不成立，名次通报这条等于空跑');
if (!/榜首/.test(String(rankFeedback.statusBehind)) ||
    !/榜首\s*[^\s]+/.test(String(rankFeedback.statusBehind)))
  problems.push('手机战况里看不到榜首是谁：' + rankFeedback.statusBehind);
if (/榜首是你/.test(String(rankFeedback.statusBehind)))
  problems.push('我 0 分却把"榜首是你"写在战况里：' + rankFeedback.statusBehind);
/* 判据：强制 nowrap 之后高度降下来了 —— 那才是真折行 */
if (!rankUI.oneLine.same)
  problems.push('HUD 总分行折行了（高 ' + rankUI.oneLine.h0 + 'px，单行时 ' +
                rankUI.oneLine.h1 + 'px）：' + rankUI.text);
if (!rankUI.visible)
  problems.push('量 HUD 时它是隐藏的（0px），折行检查没生效');
if (rankUI.rightEdge >= rankUI.probsLeft)
  problems.push('HUD 总分行撞到右边题目栏了：右缘 ' + rankUI.rightEdge +
                ' ≥ 右栏左缘 ' + rankUI.probsLeft);

if (peekUI.开桌面_view !== 'launcher' || !peekUI.开桌面_可见)
  problems.push('前置条件不对：桌面没打开（view=' + peekUI.开桌面_view + '）');
if (!(peekUI.被抓_距离 <= 3.4))
  problems.push('前置条件不对：老师离你有 ' + peekUI.被抓_距离 + ' 米');
if (peekUI.被抓_警告 !== 1)
  problems.push('老师就在身后，警告数应为 1，实际 ' + peekUI.被抓_警告);
if (peekUI.被抓_view === 'launcher')
  problems.push('被抓到玩电脑了，桌面却没关掉（view 还是 launcher）');
if (!peekUI.被抓_桌面隐藏)
  problems.push('桌面面板还挂在屏幕上');
if (peekUI.提示.indexOf('小恐龙') < 0)
  problems.push('玩家看不到被老师抓到的那句话：' + peekUI.提示);

if (boardUI.sub.indexOf('名') < 0)
  problems.push('结算副标题没提名次：' + boardUI.sub);
if (boardUI.detail.indexOf('榜 单') < 0)
  problems.push('结算正文没排出榜单');
if (boardUI.detail.indexOf('←') < 0)
  problems.push('榜单上没标出哪个是你');
if (boardUI.detail.indexOf('第 6 名') < 0)
  problems.push('榜单不足 6 行（找不到第 6 名）');
if (!boardUI.visible || boardUI.score !== '320')
  problems.push('结算面板没正确显示（visible=' + boardUI.visible + ' score=' + boardUI.score + '）');

if (problems.length){
  problems.forEach(p => console.log('  ✗ ' + p));
  realErrors.forEach(e => console.log('    ' + e));
} else {
  console.log('  ✓ 真实浏览器里：启动 / 运行 / 提交评测 / 弹窗 / 战斗 / 紧张氛围 全部正常');
}

ws.close();
killTree(chrome);
await sleep(400);          /* 等 taskkill 真的收干净，再删 profile */
await removeProfile();
process.exit(problems.length ? 1 : 0);
