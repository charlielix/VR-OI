'use strict';
/* =========================================================================
   judge —— 本地评测机（确定性打分）
   ---------------------------------------------------------------------
   真评测要编译要跑数据，浏览器里做不到；但"随便写两行也 AC"会毁掉整个
   模拟器的意义。所以这里用一套可解释、可复现的启发式：

     关键字密度  0~40   命中题目相关关键词（每个 +3，封顶 40）
     代码长度    0~30   8 行起步，108 行封顶
     结构完整度  0~30   main / 输入 / 输出 / return 0 四件套，各 7~8 分
     算法进阶    0~10   前缀和、二分、记忆化、拓扑、并查集…… 有额外加分
     ───────────────────────────────────────────────
     基础分 0~110 → 钳到 100，再叠 ±10 确定性抖动

   抖动用 hash(code + 题目 id) 作种子 —— 同一份代码反复交，分数完全一样，
   不能靠刷提交碰运气；改了代码才可能变分。
   ========================================================================= */

/* 关键字正则预编译缓存：同一份关键词表只编译一次 */
let _kwRegexes = null, _kwSource = null;
function getKeywordRegexes(keywords){
  if (_kwSource === keywords && _kwRegexes) return _kwRegexes;
  _kwSource = keywords;
  _kwRegexes = keywords.map(kw => new RegExp('\\b' + kw.toLowerCase() + '\\b'));
  return _kwRegexes;
}

/* 进阶技巧表：命中即加 2 分，体现"确实写复杂了" */
const ADVANCED_PATTERNS = [
  /\bwhile\s*\(\s*(lo|low|l)\s*<=\s*(hi|high|r)\b/,          /* 二分 */
  /\b(lower_bound|upper_bound)\s*\(/,                          /* STL 二分 */
  /\bpre(fix)?\s*\[/,                                          /* 前缀和数组 */
  /\bmemo\b|\bdfs\s*\(|\bvis\[/,                               /* 记忆化 / 搜索 */
  /\bdp\s*\[|\bf\s*\[\s*i\s*\]/,                                /* 递推 */
  /\bu?f\s*\(|find\s*\(|union/,                                 /* 并查集 */
  /\bqueue\s*<|deque\s*</,                                      /* BFS */
  /\bpriority_queue\s*</,                                       /* 堆优化 */
  /\bseg\s*\[|tree\s*\[|bit\s*\[/,                              /* 树形结构 */
  /\bmod\s*=|%\s*1000000007|%\s*1e9/,                           /* 取模 */
  /\bpow\s*\(|qpow|ksm/,                                        /* 快速幂 */
  /\bfor\s*\([^;]*;[^;]*;[^)]*\)\s*\{\s*for/,                    /* 嵌套循环 */
  /\bsort\s*\([^)]*\)/,                                          /* 排序 */
  /\bmap\s*<|\bunordered_map\s*</,                               /* 哈希表 */
  /\blong\s+long\b/,                                             /* 明白要开 LL */
  /\bsetprecision|\bprintf\s*\(\s*"%.*lf/                        /* 浮点输出 */
];

/* 屏蔽词：赛场上可以打暴力，不能打嘴炮 */
const BANNED_WORDS = [
  'fuck', 'fucking', 'fucker', 'fucked', 'shit', 'bullshit',
  'bitch', 'asshole', 'bastard', 'ccf', 'ccccf',
  '傻逼', '妈的', '操你', '尼玛', '你妈', '滚蛋',
  '垃圾出题人', '垃圾比赛', '烂题'
];

function containsBannedWord(code){
  const lower = code.toLowerCase();
  for (const w of BANNED_WORDS){
    if (lower.includes(w.toLowerCase())) return w;
  }
  return null;
}

/* 字数统计（CJK 记 1，其他按词记）—— 只用于展示，不参与打分 */
function codeStats(code){
  const lines = code.split('\n').length;
  const chars = code.replace(/\s/g, '').length;
  return { lines: lines, chars: chars };
}

function judgeUnified(code, prob, keywords){
  /* ---------- 剥注释与字符串：一次 replace 搞定，避免多次中间副本 ----------
     字符串保留成 "" 占位，这样 `cout << "..."` 的 cout 仍能被识别 */
  const src = code.replace(
    /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g,
    m => {
      const c = m.charCodeAt(0);
      if (c === 47) return '';                       /* '/' → 注释 */
      return c === 34 ? '""' : "''";                 /* 引号 → 占位 */
    });

  /* ---------- CE：没有 main 或短得离谱 ---------- */
  if (!/\bint\s+main\s*\(/.test(src) || src.length < 40){
    return {
      status: 'CE', score: 0, passed: 0,
      cases: Array.from({ length: 10 }, (_, i) => ({ id: i + 1, status: 'CE', time: '-' })),
      detail: { kw: 0, len: 0, struct: 0, adv: 0, jitter: 0 }
    };
  }

  /* ---------- 1. 关键字密度（0~40） ---------- */
  const lower = src.toLowerCase();
  const regexes = getKeywordRegexes(keywords);
  let hits = 0;
  for (let i = 0; i < regexes.length; i++) if (regexes[i].test(lower)) hits++;
  const kwScore = Math.min(40, hits * 3);

  /* ---------- 2. 代码长度（0~30） ---------- */
  const lines = code.split('\n').length;
  const lenScore = clamp((lines - 8) / 100 * 30, 0, 30);

  /* ---------- 3. 结构完整度（0~30） ---------- */
  let structScore = 0;
  if (/int\s+main\s*\(/.test(src))             structScore += 8;
  if (/(cin\s*>>|scanf\s*\()/.test(src))       structScore += 8;
  if (/(cout\s*<<|printf\s*\()/.test(src))     structScore += 7;
  if (/return\s+0\s*;/.test(src))              structScore += 7;

  /* ---------- 4. 算法进阶（0~10） ---------- */
  let advScore = 0;
  for (const re of ADVANCED_PATTERNS) if (re.test(src)) advScore += 2;
  advScore = Math.min(10, advScore);

  let base = kwScore + lenScore + structScore + advScore;   /* 0 ~ 110 */

  /* ---------- 5. 确定性抖动 ±10 ---------- */
  const rng = mulberry32(hashStr(code + '|' + prob.id));
  const jitter = (rng() - 0.5) * 20;
  base = clamp(base + jitter, 0, 100);

  /* ---------- 6. 映射到 10 个测试点 ---------- */
  const passed = Math.round(base / 10);
  const cases = [];
  for (let i = 0; i < 10; i++){
    let st;
    if (i < passed){
      st = 'AC';
    } else {
      const r = rng();
      if (r < 0.30)      st = 'WA';
      else if (r < 0.55) st = 'TLE';
      else if (r < 0.75) st = 'RE';
      else               st = 'WA';
    }
    cases.push({
      id: i + 1, status: st,
      time: st === 'TLE' ? '>2.0s' : (rng() * 0.42 + 0.008).toFixed(3) + 's'
    });
  }

  const score = passed * 10;
  const status = passed === 10 ? 'AC' : (passed > 0 ? 'PART' : 'WA');

  return {
    status: status, score: score, passed: passed, cases: cases,
    detail: {
      kw: Math.round(kwScore), len: Math.round(lenScore),
      struct: structScore, adv: advScore, jitter: Math.round(jitter * 10) / 10
    }
  };
}

function judgeCode(code, prob){
  return judgeUnified(code, prob, KEYWORDS_LIST);
}
