/* =========================================================================
   dinoshot.mjs —— 把小恐龙在各种状态下的画面截出来，存成 PNG
   ---------------------------------------------------------------------
   为什么要单独有这个工具："渲染看起来有点奇怪"是**肉眼判断**，
   靠读代码猜没有意义 —— 位图手绘的恐龙，一眼就能看出腿有没有接歪、
   眼睛有没有挖错位置，但纯读代码只会得到一堆坐标。
   所以这里直接驱动真实 Chrome 里的 dinoRender()，把帧导出来。

   除了原尺寸，还会导一张 4 倍最近邻放大的局部图：
   这个游戏是像素画，放大后有没有对齐、有没有半像素缝隙，一眼可见。

   用法：node tools/dinoshot.mjs [url] [chromePath]
   输出：tools/out/dino/*.png
   ========================================================================= */
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out', 'dino');
const URL_ = process.argv[2] || 'http://127.0.0.1:8848/index.html';
const CHROME = process.argv[3] || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
/* 端口写死会让"上一次的 Chrome 还没退干净"变成随机失败，让系统分配空闲端口。 */
const PORT = await pickFreePort();
function pickFreePort(){
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
const PROFILE = path.join(os.tmpdir(), 'oi-dino-' + Date.now());

function getJson(url){
  return new Promise((res, rej) => {
    http.get(url, r => { let s = ''; r.on('data', d => s += d);
      r.on('end', () => { try { res(JSON.parse(s)); } catch(e){ rej(e); } }); }).on('error', rej);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 删临时 profile：Chrome 的子进程（crashpad 等）在主进程被杀后还会短暂
   持有文件句柄，一次 rmSync 常常删不干净。带 maxRetries + 外层重试，
   直到目录真的消失 —— 否则反复跑这个工具会在 %TEMP% 里堆出上 GB 垃圾。 */
/* 兜底清理：中途抛异常时走不到下面那个 process.exit，
   临时 profile 就留在 %TEMP% 里了（实测漏过一份 16 MB 的）。
   exit 钩子只能同步，所以用同步 rmSync 再擦一遍。 */
process.on('exit', () => {
  if (!PROFILE) return;
  for (let i = 0; i < 3; i++){
    try { fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch(e){}
    if (!fs.existsSync(PROFILE)) return;
  }
});

async function removeProfile(){
  for (let i = 0; i < 10; i++){
    try { fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 }); } catch(e){}
    if (!fs.existsSync(PROFILE)) return;
    await sleep(250);
  }
}

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
          `GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\n` +
          `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${this.key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      });
      this.sock.on('data', chunk => {
        if (!this._upgraded){
          const all = Buffer.concat([this.buf, chunk]);
          const idx = all.indexOf('\r\n\r\n');
          if (idx < 0){ this.buf = all; return; }
          this._upgraded = true; this.buf = all.subarray(idx + 4); res();
          if (this.buf.length) this._drain();
          return;
        }
        this.buf = Buffer.concat([this.buf, chunk]); this._drain();
      });
      this.sock.on('error', rej);
    });
  }
  _drain(){
    for (;;){
      if (this.buf.length < 2) return;
      let len = this.buf[1] & 0x7f, off = 2;
      if (len === 126){ if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127){ if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
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
    else if (data.length < 65536){ header = Buffer.alloc(4); header[0]=0x81; header[1]=0x80|126; header.writeUInt16BE(data.length,2); }
    else { header = Buffer.alloc(10); header[0]=0x81; header[1]=0x80|127; header.writeBigUInt64BE(BigInt(data.length),2); }
    const masked = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
    this.sock.write(Buffer.concat([header, mask, masked]));
  }
  close(){ try { this.sock.destroy(); } catch(e){} }
}

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(PROFILE, { recursive: true });
const IS_TLS = /^https:/i.test(URL_);
const chromeArgs = [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE,
  '--window-size=1280,720', '--autoplay-policy=no-user-gesture-required', '--mute-audio'
];
if (IS_TLS) chromeArgs.push('--ignore-certificate-errors', '--allow-insecure-localhost');
chromeArgs.push('about:blank');
const chrome = spawn(CHROME, chromeArgs, { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill(); } catch(e){} });

async function targets(){
  for (let i = 0; i < 60; i++){
    try { return await getJson(`http://127.0.0.1:${PORT}/json/list`); }
    catch(e){ await sleep(250); }
  }
  throw new Error('Chrome 调试端口没起来');
}

let ws, msgId = 0;
const pending = new Map();
const pageErrors = [];
function call(method, params = {}){
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    setTimeout(() => { if (pending.has(id)){ pending.delete(id); rej(new Error('timeout ' + method)); } }, 20000);
  });
}
async function evaluate(expr){
  const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails)
    throw new Error('页面内异常: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
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
  if (m.method === 'Runtime.exceptionThrown'){
    const d = m.params.exceptionDetails;
    pageErrors.push((d.exception && d.exception.description) || d.text);
  }
};
await call('Runtime.enable');
await call('Page.enable');
await call('Page.navigate', { url: URL_ });
await sleep(4000);

/* ---- 页面内的小工具：把画布导成 PNG，并支持最近邻放大 ---- */
await evaluate(`
  window.__shot = function(kind){
    const src = dinoCanvas;
    if (kind === 'full') return src.toDataURL('image/png');
    /* 局部放大：像素画放大后对齐问题一眼可见 */
    const k = 5, sx = 30, sy = DINO.GROUND - 150, sw = 220, sh = 160;
    const c = document.createElement('canvas');
    c.width = sw * k; c.height = sh * k;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(src, sx, sy, sw, sh, 0, 0, sw * k, sh * k);
    return c.toDataURL('image/png');
  };
  'ok'
`);

/* 先把游戏带到"桌面 / 小恐龙"这个界面。直接置状态，不依赖点击。 */
await evaluate(`
  (() => {
    state.started = true; state.ended = false; state.view = 'launcher';
    openDesktop(); dinoOpen();
    return 'ok';
  })()
`);

const STATES = [
  { name: '1-待机', js: `dinoStop(); dinoReset(); dinoRunning = false; dinoOver = false; dinoRender(0);` },
  { name: '2-跑动-大小仙人掌', js: `
      dinoStop(); dinoReset(); dinoRunning = true; dinoLegFrame = 0;
      dinoObs = [ { kind:'cactus', x:560, w:57, h:74 },
                  { kind:'cactus', x:720, w:19, h:58 } ];
      dinoRender(0);` },
  { name: '3-跑动-翼龙低飞', js: `
      dinoStop(); dinoReset(); dinoRunning = true; dinoLegFrame = 1;
      dinoObs = [ { kind:'bird', x:520, w:66, h:30, y:DINO.GROUND - 22 } ];
      dinoRender(0);` },
  { name: '4-跳跃半空', js: `
      dinoStop(); dinoReset(); dinoRunning = true;
      dinoY = 95; dinoOnGround = false; dinoVY = 120;
      dinoObs = [ { kind:'cactus', x:560, w:57, h:74 } ];
      dinoRender(0);` },
  { name: '5-蹲下', js: `
      dinoStop(); dinoReset(); dinoRunning = true; dinoDuck = true; dinoLegFrame = 0;
      dinoObs = [ { kind:'bird', x:520, w:66, h:30, y:DINO.GROUND - 96 } ];
      dinoRender(0);` },
  { name: '6-撞死', js: `
      dinoStop(); dinoReset(); dinoRunning = false; dinoOver = true;
      dinoObs = [ { kind:'cactus', x:200, w:57, h:74 } ];
      dinoRender(0);` }
];

for (const st of STATES){
  const dataUrl = await evaluate(`(() => { ${st.js} return window.__shot('full'); })()`);
  const zoomUrl = await evaluate(`(() => { ${st.js} return window.__shot('zoom'); })()`);
  for (const [suffix, url] of [['', dataUrl], ['-放大', zoomUrl]]){
    const b64 = String(url).replace(/^data:image\/png;base64,/, '');
    fs.writeFileSync(path.join(OUT, st.name + suffix + '.png'), Buffer.from(b64, 'base64'));
  }
  console.log('  导出 ' + st.name);
}

/* 画布尺寸 vs CSS 尺寸：像素画最怕"内部分辨率被拉伸"，
   非整数缩放会让所有 1px 描边糊掉，这是"看起来奇怪"的常见来源。 */
const geom = await evaluate(`(() => {
  const r = dinoCanvas.getBoundingClientRect();
  const cs = getComputedStyle(dinoCanvas);
  return { 内部宽高: [dinoCanvas.width, dinoCanvas.height],
           显示宽高: [+r.width.toFixed(2), +r.height.toFixed(2)],
           缩放: [ +(r.width / dinoCanvas.width).toFixed(3), +(r.height / dinoCanvas.height).toFixed(3) ],
           css宽高: [cs.width, cs.height],
           imageRendering: cs.imageRendering };
})()`);
console.log('\n画布几何: ' + JSON.stringify(geom));

console.log('\n小恐龙像素常量: ' + JSON.stringify(await evaluate(`(() => ({
  PX: DINO.PX,
  位图行数: DINO_BODY.length,
  位图最宽: Math.max(...DINO_BODY.map(r => r.length)),
  站立判定盒: { w: 22 * DINO.PX, h: 24 * DINO.PX },
  地面线: DINO.GROUND
}))()`)));

if (pageErrors.length){
  console.log('\n页面异常:');
  pageErrors.forEach(e => console.log('  ' + e));
}
console.log('\n输出目录: ' + OUT);
ws.close(); chrome.kill();
await removeProfile();
process.exit(0);
