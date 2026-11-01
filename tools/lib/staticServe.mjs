/* =========================================================================
   lib/staticServe.mjs —— 静态服务的共用逻辑（HTTP / HTTPS 两个入口都用它）
   ---------------------------------------------------------------------
   抽出这一层的目的：缓存破除的规则只能有一份实现。
   如果 http 和 https 各写一套，早晚会出现"http 下是新的、https 下是旧的"
   这种最让人怀疑人生的现象。
   ========================================================================= */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

/* 不参与 BUILD_ID 计算的目录：第三方代码、工具自身、证书、版本控制 */
const SKIP_DIRS = new Set(['vendor', 'tools', 'node_modules', 'certs', '.git']);

/* ---------------------------------------------------------------------
   版本戳：只要任何源码文件被动过，它就变。
   用 size + mtimeMs 而不是内容哈希 —— 快得多，而且这里的目的只是"变了就换
   URL"，不是做内容寻址。
   --------------------------------------------------------------------- */
export function computeBuildId(root){
  const h = crypto.createHash('sha1');
  const walk = dir => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch(e){ return; }
    for (const e of entries){
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()){
        if (SKIP_DIRS.has(e.name)) continue;
        walk(p);
        continue;
      }
      if (!/\.(js|mjs|css|html)$/.test(e.name)) continue;
      const st = fs.statSync(p);
      h.update(e.name + ':' + st.size + ':' + st.mtimeMs + ';');
    }
  };
  walk(root);
  return h.digest('hex').slice(0, 10);
}

/* ---------------------------------------------------------------------
   版本戳提供者：每次请求现算，但用 mtime 摘要挡住无谓的重算。

   为什么不能只在启动时算一次（这是修掉的一个真 bug）：
   版本戳存在的唯一目的是回答"浏览器跑的是不是当前代码"。可它在启动时被冻结，
   之后你改了源码、刷新页面，那行 `构建 xxxxxxxx` **纹丝不动** ——
   于是你会怀疑"是不是缓存没破掉"，而真相是服务器自己拿着旧值。
   更糟的是反过来：服务器还在按旧 BUILD_ID 发 `?v=`，浏览器便合法地复用旧资源，
   版本戳却在告诉你"没变化"。这个坑把"判断依据"本身变成了误导源。

   成本：每请求一次 stat 遍历（几十个文件），比一次磁盘读还便宜；
   mtime 摘要没变就直接返回缓存值，不做哈希。
   --------------------------------------------------------------------- */
export function makeBuildIdProvider(root){
  let cached = null, lastStamp = null;

  /* 只用 stat 算一个"有没有变"的摘要 —— 不读内容、不算哈希 */
  const statStamp = () => {
    const parts = [];
    const walk = dir => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch(e){ return; }
      for (const e of entries){
        if (e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()){
          if (SKIP_DIRS.has(e.name)) continue;
          walk(p);
          continue;
        }
        if (!/\.(js|mjs|css|html)$/.test(e.name)) continue;
        try { const st = fs.statSync(p); parts.push(e.name + ':' + st.size + ':' + st.mtimeMs); }
        catch(e){}
      }
    };
    walk(root);
    return parts.join(';');
  };

  const get = () => {
    const stamp = statStamp();
    if (stamp !== lastStamp){ lastStamp = stamp; cached = computeBuildId(root); }
    return cached;
  };
  /* peek：不触发重算，只看当前值（给"检测到变化"的日志用） */
  get.peek = () => cached;
  return get;
}

/* 把 index.html 里所有 ?v=xxx 统一重写成当前版本戳 */
export function stampHtml(root, buildId){
  const raw = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  return raw.replace(/\?v=[A-Za-z0-9_.-]+/g, '?v=' + buildId);
}

/* ---------------------------------------------------------------------
   请求处理。返回 true 表示已处理，false 表示调用方可以忽略。

   buildId 可以是字符串（固定值，测试用）或 makeBuildIdProvider() 返回的函数。
   每次请求调一次，所以入口页上的版本戳永远是磁盘当前的状态。
   --------------------------------------------------------------------- */
export function handleRequest(root, buildIdProvider, req, res){
  const buildId = typeof buildIdProvider === 'function' ? buildIdProvider() : buildIdProvider;
  let rel;
  try { rel = decodeURIComponent(req.url.split('?')[0]); }
  catch(e){ res.writeHead(400).end('400'); return true; }
  if (rel === '/' || rel === '') rel = '/index.html';

  /* 路径穿越防护：解析后必须仍在 root 之内 */
  const file = path.resolve(root, '.' + rel);
  if (file !== root && !file.startsWith(root + path.sep)){
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('403');
    return true;
  }

  /* 入口页：每次请求都重新注版本戳，且绝不缓存 */
  if (rel === '/index.html'){
    let body;
    try { body = Buffer.from(stampHtml(root, buildId), 'utf8'); }
    catch(e){
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
         .end('500 读不到 index.html：' + rel);
      return true;
    }
    res.writeHead(200, {
      'Content-Type': MIME['.html'],
      'Content-Length': body.length,
      'Cache-Control': 'no-store, must-revalidate'
    });
    res.end(body);
    return true;
  }

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()){
      /* 静默掉 favicon 之外的 404 噪音没意义，这里照常回 404 */
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 ' + rel);
      return;
    }
    /* 带版本戳的资源可以放心长缓存：同版本内容永不变，换版本必换 URL */
    const versioned = /[?&]v=/.test(req.url);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': versioned
        ? 'public, max-age=31536000, immutable'
        : 'no-store, must-revalidate',
      'ETag': '"' + buildId + '-' + st.size + '"'
    });
    fs.createReadStream(file).pipe(res);
  });
  return true;
}

/* ---------------------------------------------------------------------------
   端口占用处理 —— 两个 serve 脚本共用。

   为什么值得单独写：EADDRINUSE 在 Node 里是**未处理的 error 事件**，
   默认行为是整个进程带着一大段 Node 内部栈（node:events:497、
   Server.setupListenHandle、listenInCluster…）崩掉。
   那段栈对使用者毫无价值：真正有用的信息只有"8848 被占了"，
   以及"那我该怎么办"。而最常见的成因恰恰是本项目自己的服务还在跑
   （终端窗口没关，或者上一次启动的进程留在后台）。

   所以这里把它翻译成三行能直接照做的话：谁占着、怎么腾、怎么换端口。
   --------------------------------------------------------------------------- */
export function onListenError(err, port, script, altPort){
  if (err && err.code === 'EADDRINUSE'){
    console.error('');
    console.error('端口 ' + port + ' 已经被占用了。');
    console.error('');
    console.error('  常见原因：这个项目自己的服务还在跑（上次启动的窗口没关）。');
    console.error('');
    console.error('  第一条命令看是谁占着：');
    console.error('    Get-NetTCPConnection -State Listen -LocalPort ' + port +
                  ' | Select-Object LocalPort,OwningProcess');
    console.error('');
    console.error('  想直接腾出来（PID 换成上面查到的）：');
    console.error('    Stop-Process -Id <PID>');
    console.error('');
    console.error('  或者干脆换个端口：');
    console.error('    node tools/' + script + ' ' + (altPort || (port + 1)));
    console.error('');
    console.error('  直接打开已经跑着的那个也行 —— 如果它就是这个项目，');
    console.error('  内容和你现在要起的一模一样。');
    console.error('');
    process.exit(1);
  }
  /* 其它错误（EACCES 权限、端口 <1024 等）也给出可读信息，别扔原始栈 */
  console.error('启动失败：' + (err && err.message ? err.message : String(err)));
  if (err && err.code === 'EACCES'){
    console.error('权限不足。换一个大于 1024 的端口试试：node tools/' +
                  script + ' ' + (altPort || 9000));
  }
  process.exit(1);
}
