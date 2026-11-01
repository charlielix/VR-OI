/* =========================================================================
   certinfo.mjs —— 打印某个 https 服务【当前实际提供】的证书指纹
   ---------------------------------------------------------------------
   为什么要单独有这个工具：验证"证书热重载"这件事，唯一可靠的判据是
   "同一个服务器进程，在重新签发前后，新连接拿到的证书指纹变了"。
   靠肉眼比对文件、靠重启后重跑，都分不清"生效了"和"重启顺便生效了"。

   用法：node tools/certinfo.mjs [端口]        默认 8443
   ========================================================================= */
import https from 'node:https';

const PORT = Number(process.argv[2]) || 8443;

https.get({
  host: '127.0.0.1', port: PORT, path: '/',
  rejectUnauthorized: false          /* 自签证书：这里要的就是看它长什么样 */
}, res => {
  const sock = res.socket;
  const c = sock.getPeerCertificate();
  console.log(JSON.stringify({
    port: PORT,
    tls: sock.getProtocol(),
    cipher: sock.getCipher().name,
    subject: c.subject,
    subjectAltName: c.subjectaltname,
    validTo: c.valid_to,
    fingerprint256: c.fingerprint256,
    /* 自签证书必然 false：它不在任何受信任根里 */
    authorized: sock.authorized,
    authorizationError: sock.authorizationError
  }, null, 2));
  res.resume();
  res.on('end', () => process.exit(0));
}).on('error', e => {
  console.error('连接失败 ' + PORT + '：' + e.message);
  process.exit(1);
});
