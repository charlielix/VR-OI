/* =========================================================================
   dinomap.mjs —— 把小恐龙/仙人掌/翼龙的**实际渲染结果**打印成 ASCII 图
   ---------------------------------------------------------------------
   为什么要这样：判断"渲染是不是有点奇怪"，最直接的办法是看图。
   但位图手绘的东西，光读坐标很难在脑子里拼出来 —— 把渲染结果按
   位图网格降采样成字符画，就能直接和 DINO_BODY 逐行对照、逐格找差异。

   输出三样东西：
     1) 渲染结果的字符画（每个字符 = 一个位图像素）
     2) 源位图 DINO_BODY
     3) 两者的差异图（! = 对不上）

   只做只读分析，不改任何状态。
   用法：node tools/dinomap.mjs [url] [chromePath]
   ========================================================================= */
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import crypto from 'node:crypto';

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
const PROFILE = path.join(os.tmpdir(), 'oi-map-' + Date.now());

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
    this.buf = Buffer.alloc(0); this.onmsg = () => {};
    this.ready = new Promise((res, rej) => {
      this.sock.on('connect', () => {
        this.sock.write(`GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\n` +
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

fs.mkdirSync(PROFILE, { recursive: true });
const chromeArgs = [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE,
  '--window-size=1280,720', '--mute-audio'
];
if (/^https:/i.test(URL_)) chromeArgs.push('--ignore-certificate-errors', '--allow-insecure-localhost');
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
ws = new WS(list.find(t => t.type === 'page').webSocketDebuggerUrl);
await ws.ready;
ws.onmsg = raw => {
  let m; try { m = JSON.parse(raw); } catch(e){ return; }
  if (m.id && pending.has(m.id)){
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
  }
};
await call('Runtime.enable');
await call('Page.enable');
await call('Page.navigate', { url: URL_ });
await sleep(4000);
await evaluate(`(() => { state.started = true; state.view = 'launcher'; openDesktop(); dinoOpen(); return 'ok'; })()`);

/* ---------------------------------------------------------------------
   把画布上一块区域按 PX 网格降采样成字符。
   采样点取每个位图像素的左上角那一格 —— PX=2 时正好一像素一格。
   --------------------------------------------------------------------- */
await evaluate(`
  window.__map = function(sx, sy, cols, rows, px){
    const ctx = dinoCanvas.getContext('2d');
    const img = ctx.getImageData(sx, sy, cols * px, rows * px).data;
    const out = [];
    for (let r = 0; r < rows; r++){
      let line = '';
      for (let c = 0; c < cols; c++){
        const i = ((r * px) * cols * px + (c * px)) * 4;
        /* 背景是 #f7f7f7（247），前景 #535353（83）。取中间值判黑。 */
        const lum = (img[i] + img[i+1] + img[i+2]) / 3;
        line += lum < 160 ? '#' : '.';
      }
      out.push(line);
    }
    return out;
  };
  'ok'
`);

function show(title, lines){
  console.log('\n' + title);
  lines.forEach((l, i) => console.log(String(i).padStart(3) + ' |' + l + '|'));
}

/* ---- 1. 站立姿：渲染结果 vs 源位图 ---- */
const stand = await evaluate(`
  (() => {
    dinoStop(); dinoReset(); dinoRunning = false; dinoOver = false;
    dinoRender(0);
    const s = DINO.PX;
    const bodyX = 26 * s;
    const bodyY = DINO.GROUND - DINO_BODY.length * s - 0 - 12;
    /* 多采 8 行，把腿也包进来（腿画在身体下方 bodyY+24*s 起） */
    return { x: bodyX, y: bodyY,
             rendered: window.__map(bodyX, bodyY, 32, 32, s),
             body: DINO_BODY };
  })()
`);

console.log('='.repeat(72));
console.log('小恐龙【站立】实际渲染（每字符 = 1 个位图像素，行号 = 相对位图顶部）');
console.log('位图起点: x=' + stand.x + ' y=' + stand.y + '  (DINO.PX=' + 2 + ')');
show('渲染结果:', stand.rendered);
show('源位图 DINO_BODY:', stand.body);
const diff = [];
for (let r = 0; r < stand.body.length; r++){
  const a = stand.rendered[r] || ''.padEnd(32, '.');
  const b = stand.body[r];
  let line = '';
  for (let c = 0; c < 32; c++) line += (a[c] === b[c] ? ' ' : '!');
  diff.push(line);
}
show('差异（! 表示渲染和位图对不上）:', diff);

/* ---- 2. 仙人掌：可见范围 vs 碰撞盒 ---- */
const cac = await evaluate(`
  (() => {
    dinoStop(); dinoReset(); dinoRunning = true; dinoOver = false;
    DINO_OBS[0] && dinoObs.push({ kind:'cactus', x: 400, w: 57, h: 74 });
    dinoRender(0);
    const ctx = dinoCanvas.getContext('2d');
    /* 找出这一株仙人掌在画面上真实占的包围盒（只看它的列范围） */
    const x0 = 400, w = 57;
    const ox = 400 + 4, ow = 57 - 8;                     /* 判定盒横向 */
    const oy = DINO.GROUND - 74, oh = 74;                /* 判定盒纵向 */
    const d = ctx.getImageData(x0 - 6, DINO.GROUND - 90, w + 12, 96).data;
    let top = null, bot = null, left = null, right = null;
    for (let y = 0; y < 96; y++) for (let x = 0; x < w + 12; x++){
      const i = (y * (w + 12) + x) * 4;
      const lum = (d[i] + d[i+1] + d[i+2]) / 3;
      const dark = lum < 160;
      /* 排除地面线本身（y = GROUND 那一行是整条线） */
      const absY = DINO.GROUND - 90 + y;
      if (dark && absY < DINO.GROUND){
        if (top === null || absY < top) top = absY;
        if (bot === null || absY > bot) bot = absY;
        if (left === null || x0 - 6 + x < left) left = x0 - 6 + x;
        if (right === null || x0 - 6 + x > right) right = x0 - 6 + x;
      }
    }
    return { 可见: { top: top, bottom: bot, left: left, right: right },
             判定盒: { top: oy, bottom: oy + oh, left: ox, right: ox + ow },
             地面: DINO.GROUND };
  })()
`);
console.log('\n' + '='.repeat(72));
console.log('仙人掌【可见范围 vs 碰撞盒】');
console.log('  可见: top=' + cac.可见.top + ' bottom=' + cac.可见.bottom +
            ' left=' + cac.可见.left + ' right=' + cac.可见.right);
console.log('  判定: top=' + cac.判定盒.top + ' bottom=' + cac.判定盒.bottom +
            ' left=' + cac.判定盒.left + ' right=' + cac.判定盒.right);
console.log('  可见顶部比判定盒顶高出 ' + (cac.判定盒.top - cac.可见.top) + 'px' +
            '（>0 = 视觉上戳出判定盒，擦到尖端不会死）');

/* ---- 3. 精确测量：把身体和腿**分开单独画**，量出各自的绝对坐标 ----
   这是关键一步：肉眼看整体图会被"身体和腿叠在一起"糊弄过去，
   分开画才能证明"腿到底长在哪儿"。全部用像素扫描得出，不重算公式。 */
const measure = await evaluate(`
  (() => {
    const ctx = dinoCanvas.getContext('2d');
    const s = DINO.PX, bodyX = 26 * s;
    const scan = () => {
      const d = ctx.getImageData(0, 0, DINO.W, DINO.H).data;
      let top = null, bot = null, left = null, right = null, n = 0;
      for (let y = 0; y < DINO.H; y++) for (let x = 0; x < DINO.W; x++){
        const i = (y * DINO.W + x) * 4;
        if ((d[i] + d[i+1] + d[i+2]) / 3 < 160){
          n++;
          if (top === null || y < top) top = y;
          if (bot === null || y > bot) bot = y;
          if (left === null || x < left) left = x;
          if (right === null || x > right) right = x;
        }
      }
      return { top: top, bottom: bot, left: left, right: right, 像素数: n, 高: bot - top + 1 };
    };
    const clean = () => { ctx.fillStyle = '#f7f7f7'; ctx.fillRect(0, 0, DINO.W, DINO.H); };

    const out = { 地面线: DINO.GROUND, PX: s, 身体起点x: bodyX };
    for (const p of [{ name: '站立', duck: false, sq: 1 }, { name: '蹲下', duck: true, sq: 0.58 }]){
      const bodyY = DINO.GROUND - DINO_BODY.length * s * p.sq - 12;   /* 游戏里就是这么算的 */
      clean(); dinoDrawShape(ctx, bodyX, bodyY, s, p.duck);
      const body = scan();
      clean(); dinoDrawLegs(ctx, bodyX + 4 * s, bodyY, s, p.duck, 0);
      const legs = scan();
      clean();
      dinoDrawShape(ctx, bodyX, bodyY, s, p.duck);
      dinoDrawLegs(ctx, bodyX + 4 * s, bodyY, s, p.duck, 0);
      const both = scan();
      out[p.name] = {
        bodyY: +bodyY.toFixed(2),
        身体: { top: body.top, bottom: body.bottom, 高: body.高 },
        腿:   { top: legs.top, bottom: legs.bottom, 高: legs.高, left: legs.left, right: legs.right },
        整体: { top: both.top, bottom: both.bottom, 高: both.高 },
        腿超出地面: legs.bottom - DINO.GROUND,
        腿顶减身体底: legs.top - body.bottom,
        判定盒高: (p.duck ? 16 : 24) * s
      };
    }

    /* 站立时"后腿"有没有和身体连上：逐列找腿顶，再往上找最近的深色像素 */
    const bodyY0 = DINO.GROUND - DINO_BODY.length * s - 12;
    clean();
    dinoDrawShape(ctx, bodyX, bodyY0, s, false);
    dinoDrawLegs(ctx, bodyX + 4 * s, bodyY0, s, false, 0);
    const img = ctx.getImageData(0, 0, DINO.W, DINO.H).data;
    const dark = (x, y) => {
      const i = (y * DINO.W + x) * 4;
      return (img[i] + img[i+1] + img[i+2]) / 3 < 160;
    };
    const cols = [];
    for (let x = bodyX + 24; x <= bodyX + 44; x++){
      let legTop = null;
      for (let y = bodyY0; y < DINO.H; y++){ if (dark(x, y)){ legTop = y; break; } }
      let bodyBot = null;
      for (let y = (legTop === null ? DINO.H - 1 : legTop - 1); y >= 0; y--){
        if (dark(x, y)){ bodyBot = y; break; }
      }
      cols.push({ 位图列: x - bodyX, 腿顶: legTop, 上方最近深色: bodyBot,
                  空隙: (legTop !== null && bodyBot !== null) ? legTop - bodyBot - 1 : null });
    }
    out.后腿逐列 = cols;
    return out;
  })()
`);

console.log('\n' + '='.repeat(72));
console.log('精确测量（全部由像素扫描得出，不重算公式）');
console.log('  地面线 y=' + measure.地面线 + '   PX=' + measure.PX + '   身体起点 x=' + measure.身体起点x);
for (const pose of ['站立', '蹲下']){
  const m = measure[pose];
  console.log('\n  【' + pose + '】 bodyY=' + m.bodyY);
  console.log('    身体: y ' + m.身体.top + ' .. ' + m.身体.bottom + '  (高 ' + m.身体.高 + ')');
  console.log('    腿  : y ' + m.腿.top + ' .. ' + m.腿.bottom + '  (高 ' + m.腿.高 +
              '，x ' + m.腿.left + '..' + m.腿.right + ')');
  console.log('    整体: y ' + m.整体.top + ' .. ' + m.整体.bottom + '  (高 ' + m.整体.高 + ')');
  console.log('    腿底 - 地面线 = ' + m.腿超出地面 + 'px' +
              (m.腿超出地面 > 0 ? '   ← 腿画到地面线以下了' : '   ✓ 踩在地面上'));
  /* 注意量的是"像素行下标之差"：身体最后一个像素在 233、腿从 234 起时，
     差值是 1，但它们是**相邻**的，并不是缝。差成 2 以上才是真的空了一行。 */
  console.log('    腿顶 - 身体底 = ' + m.腿顶减身体底 + 'px' +
              (m.腿顶减身体底 < 0 ? '（重叠）'
               : m.腿顶减身体底 <= 1 ? '   ✓ 接上了'
               : '   ← 中间空了一行，腿是悬空的'));
  console.log('    判定盒高 ' + m.判定盒高 + 'px  vs  整体可见高 ' + m.整体.高 + 'px');
}

console.log('\n站立时腿逐列：腿顶和它上方最近深色像素之间的空隙（空隙>0 = 悬空，没接上）');
console.log('  位图列  腿顶y  上方最近深色y  空隙');
for (const c of measure.后腿逐列){
  console.log('   ' + String(c.位图列).padStart(4) + '   ' +
              String(c.腿顶).padStart(5) + '   ' + String(c.上方最近深色).padStart(9) + '   ' +
              String(c.空隙).padStart(4) + (c.空隙 > 0 ? '  ← 悬空' : '  ok'));
}

/* ---- 4. 画布缩放：像素画最怕非整数拉伸 ---- */
const geom = await evaluate(`(() => {
  const r = dinoCanvas.getBoundingClientRect();
  const cs = getComputedStyle(dinoCanvas);
  return { 内部: [dinoCanvas.width, dinoCanvas.height],
           显示: [+r.width.toFixed(3), +r.height.toFixed(3)],
           缩放: [+(r.width / dinoCanvas.width).toFixed(4), +(r.height / dinoCanvas.height).toFixed(4)],
           imageRendering: cs.imageRendering,
           设备像素比: window.devicePixelRatio };
})()`);
console.log('\n' + '='.repeat(72));
console.log('画布缩放: ' + JSON.stringify(geom));
if (Math.abs(geom.缩放[0] - Math.round(geom.缩放[0])) > 0.001 ||
    Math.abs(geom.缩放[1] - Math.round(geom.缩放[1])) > 0.001){
  console.log('  ⚠ 非整数缩放：1 个源码像素不会映射成整数个设备像素，' +
              '同一张图里有的列/行会宽 1px、有的窄 1px —— 竖边粗细不匀。');
} else {
  console.log('  ✓ 整数缩放');
}
/* 位图里的行高被 +0.6 撑高了，顺带量一下真实总高 */
console.log('\n  DINO_BODY 名义高 ' + (24 * measure.PX) + 'px；' +
            '每行实际画成 s*sq+0.6 高 → 单行高出 0.6px，24 行累计 ' +
            (24 * 0.6).toFixed(1) + 'px。');
console.log('  换算成设备像素（上面那个缩放）：0.6 × ' + geom.缩放[0] + ' = ' +
            (0.6 * geom.缩放[0]).toFixed(2) + 'px —— 小于 1 个设备像素。');

/* ---- 5. 障碍：画出来的范围 vs 碰撞盒，逐个比对 ----
   这一类偏差玩家看不到"盒子"，但能感觉到："明明擦过去了却死了"，
   或者反过来"明明碰到了却没死"。所以必须逐项量出来。 */
const obst = await evaluate(`
  (() => {
    const ctx = dinoCanvas.getContext('2d');
    const out = [];
    const clear = () => { ctx.fillStyle = '#f7f7f7'; ctx.fillRect(0, 0, DINO.W, DINO.H); };
    const scan = () => {
      const d = ctx.getImageData(0, 0, DINO.W, DINO.H).data;
      let top = null, bot = null, left = null, right = null;
      for (let y = 0; y < DINO.H; y++) for (let x = 0; x < DINO.W; x++){
        const i = (y * DINO.W + x) * 4;
        if ((d[i] + d[i+1] + d[i+2]) / 3 < 160){
          if (top === null || y < top) top = y;
          if (bot === null || y > bot) bot = y;
          if (left === null || x < left) left = x;
          if (right === null || x > right) right = x;
        }
      }
      return { top: top, bottom: bot, left: left, right: right };
    };

    /* 仙人掌：两种 */
    for (const spec of DINO_OBS.filter(s => s.kind === 'cactus')){
      const o = { kind: 'cactus', x: 400, w: spec.w, h: spec.h };
      clear(); dinoDrawCactus(ctx, o);
      const vis = scan();
      /* 判定盒**必须**调游戏自己那个函数来算 —— 探针另抄一份公式的话，
         量的就是探针的假设，而不是游戏的行为（这段一开始就犯了这个错）。 */
      const g = dinoCactusGeom(o);
      /* 判定盒覆盖的**整数像素列**：fillRect 的右边界是开区间，
         要和扫描出的"最后一个深色列"对齐才能比出有意义的差。 */
      const hl = Math.ceil(g.left), hr = Math.ceil(g.right) - 1;
      out.push({ 名称: spec.id, 规格: 'w=' + spec.w + ' h=' + spec.h,
                 可见: vis, 判定: { left: hl, right: hr, top: g.top, bottom: g.bottom },
                 可见宽: vis.right - vis.left + 1, 判定宽: hr - hl + 1,
                 /* 判定盒伸出画面之外多少 —— 正值才是"没碰到就死" */
                 盒超出画面: { 左: Math.max(0, vis.left - hl), 右: Math.max(0, hr - vis.right),
                               上: Math.max(0, vis.top - g.top) },
                 /* 画面伸出判定盒之外多少 —— 正值是宽容方向（碰到也不死） */
                 画面超出盒: { 左: Math.max(0, hl - vis.left), 右: Math.max(0, vis.right - hr) } });
    }
    /* 翼龙：三种高度，读游戏里那份高度表 */
    for (let hi = 0; hi < DINO_BIRD_HEIGHTS.length; hi++){
      for (const fr of [0, 1]){
        const o = { kind: 'bird', x: 400, w: 66, h: 30, y: DINO.GROUND + DINO_BIRD_HEIGHTS[hi] };
        clear(); dinoDrawBird(ctx, o, fr);
        const vis = scan();
        /* 同样读游戏自己的几何函数，别另抄公式 */
        const bg = dinoBirdGeom(o);
        const hl = bg.left, hr = bg.right - 1, ht = bg.top;
        out.push({ 名称: 'bird-' + (-DINO_BIRD_HEIGHTS[hi]) + '-帧' + fr,
                   规格: 'y=GROUND' + DINO_BIRD_HEIGHTS[hi] + ' h=30',
                   可见: vis, 判定: { left: hl, right: hr, top: ht, bottom: bg.bottom },
                   可见宽: vis.right - vis.left + 1, 判定宽: hr - hl + 1,
                   底部低于地面线: vis.bottom - DINO.GROUND,
                   盒超出画面: { 左: Math.max(0, vis.left - hl), 右: Math.max(0, hr - vis.right),
                                 上: Math.max(0, vis.top - ht) },
                   画面超出盒: { 左: Math.max(0, hl - vis.left), 右: Math.max(0, vis.right - hr) } });
      }
    }
    return { 地面线: DINO.GROUND, 列表: out };
  })()
`);

console.log('\n' + '='.repeat(72));
console.log('障碍：画出来的范围 vs 碰撞盒（地面线 y=' + obst.地面线 + '）');
console.log('  「盒超出画面」>0 = 没碰到图形就死了（坏）；「画面超出盒」>0 = 碰到也不死（宽容）');
let obstBad = 0;
for (const o of obst.列表){
  const b = o.盒超出画面;
  const bad = b.左 > 0 || b.右 > 0 || b.上 > 0;
  if (bad) obstBad++;
  console.log('\n  ' + o.名称 + '  (' + o.规格 + ')');
  console.log('    可见: x ' + o.可见.left + '..' + o.可见.right + '  y ' + o.可见.top + '..' + o.可见.bottom +
              '   (宽 ' + o.可见宽 + ')');
  console.log('    判定: x ' + o.判定.left + '..' + o.判定.right + '  y ' + o.判定.top + '..' + o.判定.bottom +
              '   (宽 ' + o.判定宽 + ')');
  console.log('    盒超出画面 左/右/上 = ' + b.左 + ' / ' + b.右 + ' / ' + b.上 + 'px' +
              (bad ? '   ← 有隐形杀伤区' : '   ✓ 判定盒没超出画面'));
  const f = o.画面超出盒;
  if (f.左 > 0 || f.右 > 0)
    console.log('    画面超出盒 左/右 = ' + f.左 + ' / ' + f.右 + 'px（宽容，正确方向）');
  if (o.底部低于地面线 !== undefined && o.底部低于地面线 > 0){
    obstBad++;
    console.log('    ⚠ 画到地面线以下 ' + o.底部低于地面线 + 'px');
  }
}
console.log('\n障碍几何问题合计: ' + obstBad + ' 处' + (obstBad ? '' : '　✓ 全部对齐'));

ws.close(); chrome.kill();
await removeProfile();
process.exit(0);
