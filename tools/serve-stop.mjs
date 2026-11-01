/* =========================================================================
   serve-stop.mjs —— 关掉本项目的静态服务器
   ---------------------------------------------------------------------
   为什么需要它：启动很容易（node tools/serve.mjs），但"怎么关"经常没答案 ——
   尤其是用 Start-Process / 后台起的服务，根本没有终端窗口可以按 Ctrl+C。
   结果就是下次启动撞上 EADDRINUSE，或者电脑上莫名多出好几个 node 进程。

   安全性：**不会**按端口号盲杀。先查到这个 PID 占着端口，再核对它的命令行
   确实是本项目的 serve 脚本，两个条件都满足才动手；
   对不上就只报告、不杀 —— 免得把别的程序（或别人的服务）干掉。

   用法：
     node tools/serve-stop.mjs                默认关 8848 和 8443
     node tools/serve-stop.mjs 9000           关指定端口
     node tools/serve-stop.mjs --all          扫全盘，关掉所有本项目的 serve 进程
     node tools/serve-stop.mjs --list         只看谁占着，不动手

   注意：命令行匹配用的是 ASCII 的文件名 serve.mjs / serve-tls.mjs，
   刻意不匹配项目路径 —— 路径里有中文，跨编码容易出错。
   ========================================================================= */
import { execFileSync } from 'node:child_process';

const DEFAULT_PORTS = [8848, 8443];
/* 认这些脚本名，说明"这是我们自己起的服务" */
const SERVE_RE = /serve(-tls)?\.mjs/i;

const argv = process.argv.slice(2);
const LIST_ONLY = argv.includes('--list') || argv.includes('-n');
const ALL = argv.includes('--all');
const ports = argv.filter(a => /^\d+$/.test(a)).map(Number);
const targets = ALL ? [] : (ports.length ? ports : DEFAULT_PORTS);

/* ---------------------------------------------------------------------
   1. 找谁占着端口。
   netstat -ano 的 LISTENING 行长这样：
     TCP    127.0.0.1:8848    0.0.0.0:0    LISTENING    50004
   --------------------------------------------------------------------- */
function listeningMap(){
  let out = '';
  try { out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' }); }
  catch(e){ console.error('跑不了 netstat：' + e.message); process.exit(1); }

  const byPid = new Map();          /* pid -> Set(port) */
  for (const line of out.split(/\r?\n/)){
    /* 一定要认 LISTENING：同一条连接会有 ESTABLISHED 行，
       不筛的话会把"正在被访问"也算成"在监听" */
    if (!/LISTENING/i.test(line)) continue;
    const m = line.trim().match(/^TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i);
    if (!m) continue;
    const port = Number(m[2]), pid = Number(m[3]);
    if (!byPid.has(pid)) byPid.set(pid, new Set());
    byPid.get(pid).add(port);
  }
  return byPid;
}

/* ---------------------------------------------------------------------
   2. 核对身份：这个 PID 到底是什么进程。
   一次 PowerShell 批量取，避免一个 PID 起一次子进程。
   --------------------------------------------------------------------- */
function commandLinesOf(pids){
  if (!pids.length) return new Map();
  const filter = pids.map(p => 'ProcessId=' + p).join(' or ');
  const ps = '$ErrorActionPreference="SilentlyContinue";' +
             '[Console]::OutputEncoding=[Text.Encoding]::UTF8;' +
             'Get-CimInstance Win32_Process -Filter "' + filter + '" |' +
             'Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress';
  let raw = '';
  try {
    raw = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
                       { encoding: 'utf8' });
  } catch(e){ return new Map(); }

  const map = new Map();
  try {
    let j = JSON.parse(raw.trim() || '[]');
    if (!Array.isArray(j)) j = [j];
    for (const r of j) if (r && r.ProcessId != null) map.set(Number(r.ProcessId), r.CommandLine || '');
  } catch(e){ /* 解析不了就当没查到：宁可少杀，不可错杀 */ }
  return map;
}

/* ---------------------------------------------------------------------
   3. 主流程
   --------------------------------------------------------------------- */
const byPid = listeningMap();
const cmdlines = commandLinesOf([...byPid.keys()]);

/* 选出候选：按端口，或者 --all 时扫全部监听进程里像 serve 的 */
const candidates = [];
for (const [pid, portSet] of byPid){
  const cmd = cmdlines.get(pid) || '';
  const isOurs = SERVE_RE.test(cmd);
  const portList = [...portSet].sort((a, b) => a - b);
  const wanted = ALL ? isOurs : portList.some(p => targets.includes(p));
  if (wanted) candidates.push({ pid, ports: portList, cmd, isOurs });
}

if (!candidates.length){
  console.log(ALL ? '没找到本项目的 serve 进程 —— 已经是关着的。'
                  : '端口 ' + targets.join(' / ') + ' 上没有在监听的进程 —— 已经是关着的。');
  process.exit(0);
}

let killed = 0, skipped = 0;
for (const c of candidates){
  const tag = '  PID ' + String(c.pid).padEnd(7) + ' 端口 ' + c.ports.join(',');
  if (!c.isOurs){
    /* 只有"端口是我们要的、但进程不是我们的"才会走到这里 */
    skipped++;
    console.log('  · 跳过 ' + tag);
    console.log('      原因：命令行不像本项目的 serve 脚本，不替你动手。');
    console.log('      命令行：' + (c.cmd || '（读不到）'));
    continue;
  }
  if (LIST_ONLY){
    console.log('  · ' + tag + '　← 本项目的 serve');
    continue;
  }
  try {
    process.kill(c.pid, 'SIGTERM');
    killed++;
    console.log('  ✓ 已停止 ' + tag);
  } catch(e){
    console.log('  ✗ 停不掉 ' + tag + '　' + e.message);
  }
}

console.log('');
if (LIST_ONLY){
  console.log('（--list 模式，什么都没动）');
} else {
  console.log('已停止 ' + killed + ' 个服务' + (skipped ? '，跳过 ' + skipped + ' 个不属于本项目的进程' : '') + '。');
  console.log('想再开起来：node tools/serve.mjs　/　node tools/serve-tls.mjs');
}
