/* =========================================================================
   netcheck.mjs —— 在真实 Chrome 里逐个探测 three.js 源的可达性
   ---------------------------------------------------------------------
   为什么要用浏览器测而不是 Invoke-WebRequest：CDN 可能只对浏览器环境
   放行（或反之），而且这样连 Chrome 自己的报错也能看到。
   用法：node tools/netcheck.mjs
   ========================================================================= */
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

const CHROME = process.argv[2] || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9334;
const PROFILE = path.join(os.tmpdir(), 'oi-net-' + Date.now());

const SOURCES = [
  ['jsdelivr', 'https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js'],
  ['unpkg', 'https://unpkg.com/three@0.128.0/build/three.min.js'],
  ['cdnjs', 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js'],
  ['staticfile', 'https://cdn.staticfile.org/three.js/0.128.0/three.min.js'],
  ['本地 vendor', 'http://127.0.0.1:8848/vendor/three.min.js']
];

const getJson = url => new Promise((res, rej) =>
  http.get(url, r => { let s = ''; r.on('data', d => s += d); r.on('end', () => { try { res(JSON.parse(s)); } catch(e){ rej(e); } }); }).on('error', rej));
const sleep = ms => new Promise(r => setTimeout(r, ms));

class WS {
  constructor(url){
    const u = new URL(url);
    this.sock = net.connect(Number(u.port), u.hostname);
    this.key = crypto.randomBytes(16).toString('base64');
    this.buf = Buffer.alloc(0); this.onmsg = () => {};
    this.ready = new Promise((res, rej) => {
      this.sock.on('connect', () => this.sock.write(
        `GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\n` +
        `Connection: Upgrade\r\nSec-WebSocket-Key: ${this.key}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
      this.sock.on('data', chunk => {
        if (!this._up){
          const all = Buffer.concat([this.buf, chunk]);
          const i = all.indexOf('\r\n\r\n');
          if (i < 0){ this.buf = all; return; }
          this._up = true; this.buf = all.subarray(i + 4); res();
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
      const p = this.buf.subarray(off, off + len).toString('utf8');
      this.buf = this.buf.subarray(off + len); this.onmsg(p);
    }
  }
  send(s){
    const d = Buffer.from(s, 'utf8'), m = crypto.randomBytes(4);
    let h;
    if (d.length < 126) h = Buffer.from([0x81, 0x80 | d.length]);
    else if (d.length < 65536){ h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0x80 | 126; h.writeUInt16BE(d.length, 2); }
    else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(d.length), 2); }
    const md = Buffer.alloc(d.length);
    for (let i = 0; i < d.length; i++) md[i] = d[i] ^ m[i % 4];
    this.sock.write(Buffer.concat([h, m, md]));
  }
  close(){ try { this.sock.destroy(); } catch(e){} }
}

fs.mkdirSync(PROFILE, { recursive: true });
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE, 'about:blank'], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill(); } catch(e){} });

let list;
for (let i = 0; i < 60; i++){
  try { list = await getJson(`http://127.0.0.1:${PORT}/json/list`); if (list.length) break; }
  catch(e){ await sleep(250); }
}
const ws = new WS(list.find(t => t.type === 'page').webSocketDebuggerUrl);
await ws.ready;
let id = 0; const pend = new Map();
ws.onmsg = raw => { const m = JSON.parse(raw); if (m.id && pend.has(m.id)){ const p = pend.get(m.id); pend.delete(m.id); p.res(m.result); } };
const call = (method, params = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params }));
  return new Promise(res => pend.set(i, { res })); };
await call('Runtime.enable');

console.log('在真实 Chrome 里逐个探测 three.js 源：\n');
for (const [name, url] of SOURCES){
  const r = await call('Runtime.evaluate', {
    expression: `fetch(${JSON.stringify(url)}, {method:'GET', cache:'no-store'})
      .then(async r => ({ ok: r.ok, status: r.status, size: (await r.text()).length }))
      .catch(e => ({ ok:false, status:0, err: String(e) }))`,
    awaitPromise: true, returnByValue: true
  });
  const v = r.result && r.result.value || {};
  const verdict = v.ok ? `✓ HTTP ${v.status}　${(v.size / 1024).toFixed(0)} KB` : `✗ ${v.err || ('HTTP ' + v.status)}`;
  console.log(`  ${name.padEnd(12)} ${verdict}`);
}

ws.close(); chrome.kill(); process.exit(0);
