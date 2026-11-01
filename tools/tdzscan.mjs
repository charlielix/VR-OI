/* =========================================================================
   tdzscan.mjs —— 跨文件"暂时性死区"静态扫描
   ---------------------------------------------------------------------
   背景：本项目用传统 <script> 共享同一个全局作用域。此时：
     · function 声明被提升 → 任何文件都能提前调用
     · let / const 声明进入"全局词法环境"且带 TDZ → 在它的声明语句执行之前
       被访问，抛 ReferenceError: Cannot access 'X' before initialization
   "看起来完全对、实际在初始化阶段就炸"的故障几乎全出于此，而且只有真浏览器会复现。

   做法（两遍）：
     第 1 遍  mask()：把注释 / 字符串 / 正则 / 模板串内容抹成同长空白，
             只留一个"净化后源码"，行号严格对齐 —— 后面的分析只在这个净化层上做。
     第 2 遍  用净化层切出每个函数的 [起点, 终点] 区间，从而区分
             "文件里的顶层语句" 和 "函数体内的语句"。
   判定：
     A. 同一文件内对同一个名字既 let/const/class 又 var/let/const 重复声明 → SyntaxError
     B. 文件 X 在加载期就会执行的代码路径里引用了名字 N，而 N 的词法声明
        位于 X 之后的文件（或同文件更靠后）→ TDZ 风险
   用法：node tools/tdzscan.mjs
   ========================================================================= */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
/* 脚本列表来自 index.html。要剥掉 ?v=N 这类缓存破除串，否则 readFileSync 会 404。
   同时过滤掉 vendor/three.min.js —— 那是第三方压缩产物，不是我们的代码，
   拿它做词法分析既慢又只会得到噪声。 */
const files = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map(m => m[1].split('?')[0])
  .filter(f => !/^https?:/.test(f) && !f.startsWith('vendor/'));
const fileOrder = new Map(files.map((f, i) => [f, i]));

const KEYWORDS = new Set([
  'if','else','for','while','do','switch','case','default','break','continue','return',
  'function','class','extends','super','new','this','typeof','instanceof','in','of','void','delete',
  'try','catch','finally','throw','yield','await','async','let','const','var','static','get','set',
  'true','false','null','undefined','NaN','Infinity','import','export','from','as'
]);
const isIdent = ch => /[A-Za-z0-9_$]/.test(ch);

/* ------------------------------------------------------------------
   第 1 遍：净化。把注释 / 字符串 / 正则 / 模板串正文替换成等长空格。
   识别正则的关键：往前找最近的非空白字符，若它是 ) ] } 或标识符/数字结尾
   则当前 / 是除号，否则是正则起始。
   ------------------------------------------------------------------ */
function mask(src){
  const out = src.split('');
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' '; };
  let i = 0;

  const prevMeaningful = (p) => {
    for (let k = p - 1; k >= 0; k--){
      const c = src[k];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') continue;
      return c;
    }
    return '';
  };

  while (i < src.length){
    const c = src[i];

    if (c === '/' && src[i + 1] === '/'){ const s = i; while (i < src.length && src[i] !== '\n') i++; blank(s, i); continue; }
    if (c === '/' && src[i + 1] === '*'){
      const s = i; i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2; blank(s, Math.min(i, src.length)); continue;
    }
    if (c === '"' || c === "'"){
      const s = i; i++;
      while (i < src.length && src[i] !== c){
        if (src[i] === '\\') i++;
        if (src[i] === '\n') break;             /* 未闭合，别把整个文件吃掉 */
        i++;
      }
      i++;
      blank(s + 1, i - 1); continue;
    }
    if (c === '`'){
      const s = i; i++;
      let depth = 0;
      while (i < src.length){
        if (src[i] === '\\'){ i += 2; continue; }
        if (src[i] === '$' && src[i + 1] === '{'){ depth++; i += 2; continue; }
        if (src[i] === '}' && depth > 0){ depth--; i++; continue; }
        if (src[i] === '`' && depth === 0) break;
        i++;
      }
      i++;
      blank(s + 1, i - 1); continue;
    }
    if (c === '/'){
      const p = prevMeaningful(i);
      const isDivision = p && (isIdent(p) || p === ')' || p === ']' || p === '}');
      if (!isDivision){
        const s = i; i++;
        let inClass = false;
        while (i < src.length){
          const d = src[i];
          if (d === '\\'){ i += 2; continue; }
          if (d === '\n') break;
          if (d === '[') inClass = true;
          else if (d === ']') inClass = false;
          else if (d === '/' && !inClass) break;
          i++;
        }
        i++;
        /* /gimsuy 后缀保留原样即可，不影响标识符扫描 */
        blank(s, i - 1); continue;
      }
    }
    i++;
  }
  return out.join('');
}

/* ------------------------------------------------------------------
   第 2 遍：在净化层上求每个函数的 [start, end)
   ------------------------------------------------------------------ */
function functionRanges(clean){
  const ranges = [];
  const n = clean.length;
  const re = /\bfunction\b/g;
  let m;
  while ((m = re.exec(clean))){
    let p = m.index + 8;
    /* function* 生成器 */
    if (clean[p] === '*') p++;
    while (p < n && /\s/.test(clean[p])) p++;
    while (p < n && isIdent(clean[p])) p++;
    while (p < n && clean[p] !== '{' && clean[p] !== ';' && clean[p] !== '(') p++;
    if (clean[p] === '('){                              /* 跳过参数表（含默认值里的括号） */
      let depth = 0;
      while (p < n){
        if (clean[p] === '(') depth++;
        else if (clean[p] === ')'){ depth--; if (depth === 0){ p++; break; } }
        p++;
      }
    }
    while (p < n && /\s/.test(clean[p])) p++;
    if (clean[p] !== '{') continue;                     /* 函数声明但无体，跳过 */
    let depth = 0;
    while (p < n){
      if (clean[p] === '{') depth++;
      else if (clean[p] === '}'){ depth--; if (depth === 0){ p++; break; } }
      p++;
    }
    ranges.push([m.index, p]);
  }
  return ranges;
}

/* 箭头函数：=> { ... }  也当成一个函数体区间（保守处理，避免把它的局部 let 当成顶层） */
function arrowRanges(clean){
  const ranges = [];
  const n = clean.length;
  for (let i = 0; i + 1 < n; i++){
    if (clean[i] === '=' && clean[i + 1] === '>'){
      let p = i + 2;
      while (p < n && /\s/.test(clean[p])) p++;
      if (clean[p] !== '{') continue;
      let depth = 0;
      while (p < n){
        if (clean[p] === '{') depth++;
        else if (clean[p] === '}'){ depth--; if (depth === 0){ p++; break; } }
        p++;
      }
      ranges.push([i, p]);
    }
  }
  return ranges;
}

const allRanges = new Map();
function inFunction(file, pos){
  const rs = allRanges.get(file);
  if (!rs) return false;
  for (const [a, b] of rs) if (pos >= a && pos < b) return true;
  return false;
}

/* ------------------------------------------------------------------
   收集声明
   ------------------------------------------------------------------ */
const decls = new Map();          /* name -> { file, order, fn, pos } */
const redecl = [];
const declLookupDup = new Map();  /* name -> [ {file, kind} ] 只用于同文件重复检测 */

for (const f of files){
  const clean = mask(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  allRanges.set(f, [...functionRanges(clean), ...arrowRanges(clean)]);

  const seen = new Map();
  /* 必须紧跟标识符起始字符（允许 function 后跟 ( 这种无函数名情形）。
     紧凑写法要注意两个坑：
       1) "parameters" 里的 "var" 会被 \b 匹配到；
       2) `const { a, b } = x` 这种解构会让正则从花括号后面重新起跳，
          把每个属性名当成一次独立声明 → 海量误报。所以要显式跳过解构。 */
  const re = /\b(let|const|var|class|function)(\s*\*?\s*)([A-Za-z_$][A-Za-z0-9_$]*|[(])/g;
  let m;
  while ((m = re.exec(clean))){
    const kind = m[1];
    /* 同样必须限定在文件顶层，否则函数内部的 `const k = ...` 会被当成全局声明。
       这里用净化层上的花括号深度判断，比缩进可靠。 */
    {
      let d = 0;
      for (let k = 0; k < m.index; k++){
        const ch = clean[k];
        if (ch === '{') d++;
        else if (ch === '}') d--;
      }
      if (d !== 0) continue;
    }
    /* 解构声明：跳过整个模式，只记录一个占位，避免属性名被误认为声明 */
    if (m[3] === '(' || clean[m.index + m[0].length - 1] === '{' ||
        /^\s*\{/.test(clean.slice(m.index + kind.length))){
      if (kind === 'function') continue;              /* 匿名函数表达式 */
      let p = clean.indexOf('{', m.index);
      if (p >= 0 && p - m.index < 40){
        let depth = 0;
        while (p < clean.length){
          if (clean[p] === '{') depth++;
          else if (clean[p] === '}'){ depth--; if (depth === 0){ p++; break; } }
          p++;
        }
        re.lastIndex = p;
      }
      continue;
    }
    let p = m.index + kind.length;
    if (kind === 'function' && clean[p] === '*') p++;
    while (p < clean.length && (clean[p] === ' ' || clean[p] === '\t')) p++;
    let name = '';
    while (p < clean.length && isIdent(clean[p])) name += clean[p++];
    if (!name) continue;

    /* 只关心全局层：函数体内部的声明各自局部，不存在跨文件 TDZ */
    if (inFunction(f, m.index)) continue;

    const entry = { file: f, order: fileOrder.get(f), fn: kind === 'function', kind, pos: m.index };

    if (seen.has(name)){
      const prev = seen.get(name);
      if (!(prev.kind === 'function' && kind === 'function')){
        redecl.push(`${name}  (${prev.kind} @ ${prev.file}  →  ${kind} @ ${f})`);
      }
    }
    seen.set(name, entry);
    declLookupDup.set(name, (declLookupDup.get(name) || 0) + 1);

    const old = decls.get(name);
    if (!old || (old.fn && !entry.fn)) decls.set(name, entry);
  }
}

/* ------------------------------------------------------------------
   检查引用
   ------------------------------------------------------------------ */
const issues = [];
/* 判断某个引用位置是否处在"加载期就会执行"的路径上：
   函数体内的引用只有在被顶层语句调用时才会在加载期跑。
   这里做两级判定：
     L1（确定风险）引用位于顶层语句 → 加载期必执行
     L2（潜在风险）引用位于函数体，但 X 文件在声明之前就调用了那类函数 —— 太保守，
        这级不报，避免噪音淹没真问题。 */
for (const f of files){
  const clean = mask(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  const re = /\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g;
  let m;
  while ((m = re.exec(clean))){
    const name = m[1];
    if (KEYWORDS.has(name)) continue;
    const d = decls.get(name);
    if (!d || d.fn) continue;                       /* function 声明提升，安全 */
    if (d.order > fileOrder.get(f)){                /* 声明在后面的文件 → 加载期仍处 TDZ */
      const line = clean.slice(0, m.index).split('\n').length;
      const text = clean.split('\n')[line - 1] || '';
      /* 顶层的自引用（自己声明那一行）不算 */
      if (d.file === f && d.pos > m.index) continue;
      issues.push({ f, line, name, declFile: d.file, text: text.trim(),
                    inFn: inFunction(f, m.index) });
    }
  }
}

console.log('== A. 同名重复声明（let/const/var/class 冲突 → SyntaxError） ==');
if (redecl.length) redecl.forEach(r => console.log('  ✗ ' + r));
else console.log('  ✓ 无');

const hard = issues.filter(x => !x.inFn);
console.log('\n== B1. 顶层语句引用了"后面文件"才声明的 let/const（加载期必炸） ==');
if (hard.length){
  for (const x of hard) console.log(`  ✗ ${x.f}:${x.line}  '${x.name}' 要到 ${x.declFile} 才初始化`);
} else console.log('  ✓ 无');

/* 函数体里的跨文件引用：只有该函数在加载期被顶层语句调用才会炸，人工确认用 */
const soft = issues.filter(x => x.inFn);
console.log('\n== B2. 函数体内引用了"后面文件"才声明的 let/const（仅在被加载期调用时才炸，供人工复核） ==');
const softKey = new Set();
for (const x of soft){
  const k = x.name + '@' + x.declFile;
  if (softKey.has(k)) continue;
  softKey.add(k);
  console.log(`  · ${x.f}:${x.line}  '${x.name}' → 声明在 ${x.declFile}`);
}
if (!soft.length) console.log('  ✓ 无');

console.log('\n== C. 结论 ==');
const bad = redecl.length + hard.length;
console.log(bad ? `  有 ${bad} 个必须处理的时序问题` : '  加载期时序干净：不存在"先访问后初始化"的路径');
process.exit(bad ? 1 : 0);
