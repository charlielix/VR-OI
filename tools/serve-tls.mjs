/* =========================================================================
   serve-tls.mjs —— HTTPS 版静态服务器（复用 serve.mjs 的全部缓存破除逻辑）
   ---------------------------------------------------------------------
   证书用 tools/gencert.mjs 生成。不存在时会明确告诉你去跑哪条命令，
   而不是抛一个 ERR_SSL 让你猜。

   用法：node tools/serve-tls.mjs [端口]        默认 8443
   准备：node tools/gencert.mjs                 （先生成 certs/cert.pem|key.pem）

   ⚠ 第一次打开会出现 "您的连接不是私密连接 / NET::ERR_CERT_AUTHORITY_INVALID"。
     这是自签证书的固有现象 —— 它不在任何受信任根里。
     点「高级」→「继续前往 127.0.0.1（不安全）」即可。
     想彻底消掉警告：用 mkcert 签发（它会把根证书装进系统信任区），
     然后同样把产物放到 certs/ 下，本脚本不用改。见 README。
   ========================================================================= */
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeBuildIdProvider, handleRequest, onListenError } from './lib/staticServe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/* 端口：挑第一个纯数字参数（理由同 serve.mjs，别让行尾注释影响） */
const PORT = Number(process.argv.slice(2).find(a => /^\d+$/.test(a))) || 8443;
const CERT = path.join(ROOT, 'certs', 'cert.pem');
const KEY = path.join(ROOT, 'certs', 'key.pem');

if (!fs.existsSync(CERT) || !fs.existsSync(KEY)){
  console.error('找不到证书：');
  console.error('  ' + CERT + (fs.existsSync(CERT) ? '' : '   ← 不存在'));
  console.error('  ' + KEY + (fs.existsSync(KEY) ? '' : '   ← 不存在'));
  console.error('\n先跑这条生成（纯 Node，不需要 openssl）：');
  console.error('  node tools/gencert.mjs');
  process.exit(1);
}

const BUILD_ID = makeBuildIdProvider(ROOT);

/* ---------------------------------------------------------------------
   证书热重载
   ---------------------------------------------------------------------
   原本是启动时 readFileSync 一次。问题是 gencert.mjs 重新签发后，正在运行的
   服务仍握着旧证书 —— 浏览器看到的指纹和 certs/cert.pem 里那份对不上，
   而且"怎么刷都一样"，极易被误判成浏览器缓存或代码问题。
   【这个坑在一次会话里咬了两次】所以改成自动重载。

   关键实现细节：Node 的 https 在 createServer() 时固定证书，只换变量不生效。
   而且 cert / key 传【函数】是行不通的 —— 签名要求 Buffer|string，传函数会直接
   启动失败。正确做法是公有 API `server.setSecureContext()`（Node 11.6+），
   它是为这个场景设计的：热替换 TLS 上下文，不需要重启、不断已有连接。
   --------------------------------------------------------------------- */
let PEM = { cert: null, key: null }, tlsStamp = '';

function loadTls(force){
  const stamp = fs.statSync(CERT).mtimeMs + ':' + fs.statSync(KEY).mtimeMs;
  if (!force && stamp === tlsStamp) return false;
  /* 私钥和证书是配对的，必须一起换 —— 混用旧 key 新 cert 会握手失败 */
  PEM = { cert: fs.readFileSync(CERT), key: fs.readFileSync(KEY) };
  tlsStamp = stamp;
  return true;
}
loadTls(true);

const server = https.createServer({
  cert: PEM.cert,
  key: PEM.key,
  /* 只收 TLS 1.2+ ；本机自用不需要兼容老协议 */
  minVersion: 'TLSv1.2'
}, (req, res) => handleRequest(ROOT, BUILD_ID, req, res));

/* 端口冲突要给可照做的提示，而不是甩一段 Node 内部栈（详见 staticServe.mjs） */
server.on('error', (err) => onListenError(err, PORT, 'serve-tls.mjs', 9443));

server.listen(PORT, '127.0.0.1', () => {
  console.log('VR OI 考场  → https://127.0.0.1:' + PORT + '/');
  console.log('构建版本  → ' + BUILD_ID() + '   (改动任何源码后自动变化)');
  console.log('证书      → ' + CERT + '　（重新签发后自动热重载，无需重启）');
  console.log('');
  console.log('首次打开会有安全警告（自签证书的正常现象）：');
  console.log('  点「高级」→「继续前往 127.0.0.1（不安全）」');
  console.log('Ctrl+C 停止');
});

/* ---------------------------------------------------------------------
   证书热重载检查：每秒比对 cert/key 的 mtime，变了就换 TLS 上下文。
   开销是两次 statSync —— 相比"每次改完证书都要记得手动重启"这个会出错的手工
   步骤，这点开销换来的确定性非常划算。
   --------------------------------------------------------------------- */
function syncTls(){
  try {
    if (!loadTls(false)) return;
    server.setSecureContext({ cert: PEM.cert, key: PEM.key, minVersion: 'TLSv1.2' });
    console.log('检测到证书更新，已热重载（新连接立即生效）：' + CERT);
  } catch(e){
    console.log('证书热重载失败，继续用旧证书：' + e.message);
  }
}
setInterval(syncTls, 1000).unref();

server.on('tlsClientError', (err) => {
  console.log('TLS 握手失败（通常是客户端点了"取消"）：' + err.message);
});
