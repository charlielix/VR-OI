/* 独立 DER 校验器：把证书解回来，逐层打印结构长度。
   遇到 "too long" 这类 OpenSSL 报错时，只有自己解一遍才知道是哪一层长度写错了。 */
import fs from 'node:fs';

const der = fs.readFileSync(new URL('../certs/cert.pem', import.meta.url), 'utf8')
  .replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
const buf = Buffer.from(der, 'base64');
console.log('证书 DER 总长 ' + buf.length + ' 字节');

const TAGS = {
  0x30: 'SEQUENCE', 0x31: 'SET', 0x02: 'INTEGER', 0x03: 'BIT STRING',
  0x04: 'OCTET STRING', 0x05: 'NULL', 0x06: 'OID', 0x0c: 'UTF8String',
  0x13: 'PrintableString', 0x16: 'IA5String', 0x17: 'UTCTime', 0x01: 'BOOLEAN'
};

let problems = 0;
function parse(off, end, depth){
  let i = off;
  while (i < end){
    const start = i;
    const tag = buf[i++];
    let len = buf[i++];
    if (len === undefined) break;
    let lenBytes = 1;
    if (len & 0x80){
      const n = len & 0x7f;
      if (n === 0 || n > 4){ console.log(pad(depth) + '✗ 非法长度字节数 ' + n + ' @' + start); problems++; return i; }
      len = 0;
      for (let k = 0; k < n; k++){ len = (len << 8) | buf[i++]; lenBytes++; }
      /* 最小长度编码检查：长格式表示的值必须 >= 128 */
      if (len < 128){ console.log(pad(depth) + '✗ 非最小长度编码（值 ' + len + ' 却用了长格式）@' + start); problems++; }
    }
    const head = i - start;
    const name = TAGS[tag] || ('0x' + tag.toString(16));
    const ctx = (tag & 0xe0) === 0xa0 ? '  [CTX ' + (tag & 0x1f) + ']' : '';
    console.log(pad(depth) + name + ctx + '  len=' + len + '  hdr=' + head + '  @' + start);

    if (i + len > end){
      console.log(pad(depth + 1) + '✗ 内容超出父级边界：需要到 ' + (i + len) + '，父级只到 ' + end);
      problems++; return end;
    }
    /* 递归进构造类型 */
    if ((tag & 0x20) || tag === 0x30 || tag === 0x31 || (tag & 0xe0) === 0xa0){
      parse(i, i + len, depth + 1);
    }
    i += len;
  }
  return i;
}
const pad = d => '  '.repeat(d);

parse(0, buf.length, 0);
console.log(problems ? '\n发现 ' + problems + ' 处结构问题' : '\nDER 结构自洽');
