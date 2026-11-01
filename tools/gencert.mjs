/* =========================================================================
   gencert.mjs —— 用 Node 内置 crypto 签发本地自签证书（不需要 openssl）
   ---------------------------------------------------------------------
   为什么自己写 DER 编码：这台机器上没有 openssl、没有 mkcert、没有 git，
   而"为了本地 https 去装一个证书工具链"这件事本身就不划算。
   X.509 的结构是确定的，Node 自带 RSA 密钥生成与签名 —— 手工拼 DER 是
   完全可行且不到 200 行的活。

   产物（写入 certs/）：
     key.pem     PKCS#8 私钥
     cert.pem    X.509 证书，SAN 覆盖 localhost / 127.0.0.1 / ::1

   签发内容里每个字段的作用：
     basicConstraints  CA:FALSE       —— 它是终端证书，不是 CA
     keyUsage          digitalSignature|keyEncipherment
     extendedKeyUsage  serverAuth     —— 明确用于服务器身份
     subjectAltName    DNS:localhost, IP:127.0.0.1, IP:::1
       ← 这一条最关键。没有它，Chrome 会报 ERR_CERT_COMMON_NAME_INVALID，
         连"点击继续访问"的机会都不给（NET::ERR_CERT 类错误是硬阻断）。

   ⚠ 浏览器仍会显示"不安全"：自签证书不在任何受信任根里。
     Chrome 会给出 NET::ERR_CERT_AUTHORITY_INVALID 的拦截页，
     需要点一次"高级 → 继续前往 127.0.0.1（不安全）"。
     这是自签证书的固有代价，不是配置问题。
     想彻底消除警告：用 mkcert（会把它自己的根证书装进系统信任区）。
     详见 README。

   用法：node tools/gencert.mjs [天数]        默认 3650 天
   ========================================================================= */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'certs');
const DAYS = Number(process.argv[2]) || 3650;

/* ---------------------------------------------------------------------
   DER 编码小工具
   每个 TLV 都是：tag(1B) + length(1~3B) + value
   length 用短格式（<128）或长格式（0x81 xx / 0x82 xx xx）
   --------------------------------------------------------------------- */
function len_(n){
  /* 防御：这里只接受字节长度。若哪天又被传进字符串，立刻明确报错，
     而不是把一个"字符串长度"当成"内容长度"写进 DER —— 那会让整段结构错位，
     最终只换来 OpenSSL 一句 "asn1 encoding routines::too long"，
     完全指不出问题在哪一行。 */
  if (typeof n !== 'number'){
    throw new TypeError('len_() 需要字节长度，收到 ' + typeof n +
                       '。检查是不是把字符串直接传给了 tlv()/SEQ()。');
  }
  if (n < 0x80) return Buffer.from([n]);
  if (n < 0x100) return Buffer.from([0x81, n]);
  return Buffer.from([0x82, (n >> 8) & 0xff, n & 0xff]);
}
/* 统一把参数规范成 Buffer。手拼 DER 时最容易犯的错就是漏了一个包装函数、
   把字符串直接传进 SEQ —— 报出来的却是 buffer.js 内部的 ERR_INVALID_ARG_TYPE，
   完全看不出是哪一层。这里统一吸收掉这种失误，报错才指向真正的位置。 */
const buf_ = v => (Buffer.isBuffer(v) ? v : Buffer.from(String(v), 'latin1'));
function tlv(tag, val){
  const v = buf_(val);
  return Buffer.concat([Buffer.from([tag]), len_(v.length), v]);
}const SEQ = (...items) => tlv(0x30, Buffer.concat(items.map(buf_)));   /* SEQUENCE */
const SET = (...items) => tlv(0x31, Buffer.concat(items.map(buf_)));   /* SET */
const INT = n => {
  const b = typeof n === 'bigint' ? bigIntBytes(n) : intBytes(n);
  return tlv(0x02, b);
};
const BITSTR = (buf, unused = 0) => tlv(0x03, Buffer.concat([Buffer.from([unused]), buf]));
const OCTSTR = buf => tlv(0x04, buf);
const NULL_ = () => tlv(0x05, Buffer.alloc(0));
const BOOL = v => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const OID = str => {
  const parts = str.split('.').map(Number);
  const bytes = [40 * parts[0] + parts[1]];
  for (let i = 2; i < parts.length; i++){
    let v = parts[i], stack = [v & 0x7f];
    v >>= 7;
    while (v > 0){ stack.unshift((v & 0x7f) | 0x80); v >>= 7; }
    bytes.push(...stack);
  }
  return tlv(0x06, Buffer.from(bytes));
};
const UTF8 = s => tlv(0x0c, Buffer.from(s, 'utf8'));
/* 踩过的坑：这里必须显式 Buffer.from。tlv() 内部虽然也会兜底转换，但 len_()
   算的是【传进来的东西】的长度 —— 传字符串就会把字符串长度当内容长度写进 DER，
   于是 SEQUENCE 的边界整体错位，报出来却是 OpenSSL 那句毫无指向性的
   "asn1 encoding routines::too long"。用 tools/dercheck.mjs 才定位到这一行。 */
const PRINTABLE = s => tlv(0x13, Buffer.from(s, 'latin1'));
const IA5 = s => tlv(0x16, Buffer.from(s, 'latin1'));
const UTC = d => {
  const p = n => String(n).padStart(2, '0');
  const s = p(d.getUTCFullYear() % 100) + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
            p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + 'Z';
  return tlv(0x17, Buffer.from(s, 'ascii'));
};
/* 扩展用 [n] EXPLICIT 包裹 */
const CTX = (n, inner) => tlv(0xa0 + n, inner);

function intBytes(n){
  const out = [];
  let v = BigInt(n);
  while (v > 0n){ out.unshift(Number(v & 0xffn)); v >>= 8n; }
  if (!out.length) out.push(0);
  if (out[0] & 0x80) out.unshift(0);       /* 最高位为 1 要补 0，否则被当成负数 */
  return Buffer.from(out);
}
function bigIntBytes(v){ return intBytes(v); }

/* RSA 公钥 → DER：RSAPublicKey ::= SEQUENCE { modulus INTEGER, exponent INTEGER } */
function rsaPublicKeyDer(key){
  const jwk = key.export({ format: 'jwk' });
  const b64url = s => Buffer.from(s, 'base64url');
  return SEQ(INT(BigInt('0x' + Buffer.from(jwk.n, 'base64url').toString('hex'))),
             INT(BigInt('0x' + Buffer.from(jwk.e, 'base64url').toString('hex'))));
}

/* ---------------------------------------------------------------------
   构造证书
   --------------------------------------------------------------------- */
const ALG_SHA256_RSA = SEQ(OID('1.2.840.113549.1.1.11'), NULL_());
const OID_RSA = '1.2.840.113549.1.1.1';
const OID_CN = '2.5.4.3';
const OID_BC = '2.5.29.19';
const OID_KU = '2.5.29.15';
const OID_EKU = '2.5.29.37';
const OID_SAN = '2.5.29.17';

/* AttributeTypeAndValue ::= SEQUENCE { type OID, value ANY }
   注意 OID_CN 是字符串 '2.5.4.3'，必须过一遍 OID() 编码成 OBJECT IDENTIFIER 的
   字节。漏掉这一步会把 ASCII 原文直接当内容写进 DER，长度算出来还对得上，
   所以不报错 —— 直到 OpenSSL 解析时只给一句 "asn1 encoding routines::too long"。
   只有 tools/dercheck.mjs 那种逐层打印的解析器才能一眼看出是这一行。 */
function name_(cn){
  return SEQ(SET(SEQ(OID(OID_CN), PRINTABLE(cn))));
}

console.log('生成 RSA 2048 密钥对…');
/* 注意：不要在这里传 publicKeyEncoding / privateKeyEncoding —— 那样拿到的是
   PEM 字符串，`.export()` 不存在。默认返回 KeyObject，才能取 jwk 来拼公钥 DER。 */
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048
});
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });

const now = new Date();
const notBefore = new Date(now.getTime() - 24 * 3600 * 1000);          /* 往前一天，避免时钟偏差 */
const notAfter = new Date(now.getTime() + DAYS * 24 * 3600 * 1000);
const serial = BigInt('0x' + crypto.randomBytes(8).toString('hex')) | (1n << 63n);

/* subjectAltName：DNS localhost + IP 127.0.0.1 + IP ::1 */
const san = SEQ(
  tlv(0x82, Buffer.from('localhost', 'ascii')),                  /* [2] dNSName */
  tlv(0x87, Buffer.from([127, 0, 0, 1])),                        /* [7] iPAddress */
  tlv(0x87, Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]))  /* ::1 */
);

const tbs = SEQ(
  CTX(0, INT(2)),                                    /* version v3 */
  INT(serial),
  ALG_SHA256_RSA,
  name_('localhost'),                                /* issuer */
  SEQ(UTC(notBefore), UTC(notAfter)),                /* validity */
  name_('localhost'),                                /* subject */
  SEQ(                                            /* subjectPublicKeyInfo */
    SEQ(OID(OID_RSA), NULL_()),
    BITSTR(rsaPublicKeyDer(publicKey))
  ),
  CTX(3, SEQ(                                     /* extensions */
    SEQ(OID(OID_BC), BOOL(true), OCTSTR(SEQ(BOOL(false)))),          /* CA:FALSE */
    SEQ(OID(OID_KU), BOOL(true), OCTSTR(BITSTR(Buffer.from([0xa0])))),/* digitalSignature|keyEncipherment */
    SEQ(OID(OID_EKU), OCTSTR(SEQ(OID('1.3.6.1.5.5.7.3.1')))),        /* serverAuth */
    SEQ(OID(OID_SAN), OCTSTR(san))
  ))
);

console.log('签名中…');
const sig = crypto.sign('sha256', tbs, privateKey);
const certDer = SEQ(tbs, ALG_SHA256_RSA, BITSTR(sig));

const pem = (label, der) => {
  const b64 = der.toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
};

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'key.pem'), privatePem, { mode: 0o600 });
fs.writeFileSync(path.join(OUT, 'cert.pem'), pem('CERTIFICATE', certDer));

/* ---------------------------------------------------------------------
   自检：用 Node 的 X509Certificate 把刚签出来的证书读回来验一遍。
   不验就交付，等于把"结构编错"的风险留给浏览器那句含糊的 NET::ERR_CERT_*。
   --------------------------------------------------------------------- */
console.log('\n自检：');
const x = new crypto.X509Certificate(fs.readFileSync(path.join(OUT, 'cert.pem')));
/* UTCTime 只有到分钟的精度（秒被截掉），所以期望值也要截到分钟再比，
   否则会得到"差 12 秒"这种假失败。 */
const toMin = d => Math.floor(d.getTime() / 60000);
const checks = [
  ['解析成功', true],
  ['subject', x.subject === 'CN=localhost'],
  ['issuer', x.issuer === 'CN=localhost'],
  ['有效期起', toMin(new Date(x.validFrom)) <= toMin(notBefore)],
  ['有效期止', toMin(new Date(x.validTo)) >= toMin(notAfter)],
  ['签名可验证（自签 → 用自身公钥验）', x.verify(x.publicKey)],
  ['SAN 含 localhost', /DNS:localhost/i.test(x.subjectAltName || '')],
  ['SAN 含 127.0.0.1', /IP Address:127\.0\.0\.1/.test(x.subjectAltName || '')],
  ['指纹', /^[0-9A-F:]+$/i.test(x.fingerprint256)]
];
let bad = 0;
for (const [k, v] of checks){
  console.log('  ' + (v ? '✓' : '✗') + ' ' + k);
  if (!v) bad++;
}
console.log('  subjectAltName : ' + x.subjectAltName);
console.log('  validTo        : ' + x.validTo);
console.log('  fingerprint    : ' + x.fingerprint256);

console.log('\n已写入：');
console.log('  ' + path.join(OUT, 'cert.pem'));
console.log('  ' + path.join(OUT, 'key.pem'));
console.log('\n（如果 serve-tls.mjs 正在运行，无需重启 —— 它会自动热重载。）');
console.log('校验"服务器实际提供的证书"：node tools/certinfo.mjs 8443');
console.log('\n下一步：node tools/serve-tls.mjs   →  https://127.0.0.1:8443/');
if (bad) { console.log('\n自检有 ' + bad + ' 项未通过'); process.exit(1); }
