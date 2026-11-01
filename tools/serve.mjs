/* =========================================================================
   serve.mjs —— 零依赖静态服务器（HTTP，带自动缓存破除）
   ---------------------------------------------------------------------
   为什么需要它：

   1) 本项目必须用 http:// 或 https:// 打开。file:// 下浏览器会拒绝加载部分
      资源，而且 localStorage 归属"不安全来源"，存档会直接失效。

   2) python -m http.server 能跑，但它不发任何缓存头。浏览器于是启用
      "启发式缓存"，会把 js/*.js 留在本地反复复用 —— 改了代码却还在跑旧文件，
      控制台报的错还是旧代码里的，排查方向直接被带偏。
      【本项目真的被这个坑咬过】所以这里做了自动版本戳：
        · 启动时扫描所有源码的 mtime，算出 BUILD_ID
        · 每次请求把 index.html 里所有 `?v=任意值` 重写成 `?v=BUILD_ID`
        · 带版本戳的资源用 immutable 长缓存，index.html 本身 no-store
      只要动过任何源码文件，BUILD_ID 就变、URL 就变，浏览器必然重新拉取。

   用法：node tools/serve.mjs [端口]         默认 8848
   想要 https：node tools/serve-tls.mjs
   ========================================================================= */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeBuildIdProvider, handleRequest, onListenError } from './lib/staticServe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/* 端口：挑第一个纯数字参数。
   不能直接取 argv[2] —— README 里的示例是 `node tools/serve.mjs  # 注释`，
   在 PowerShell 下 `#` 是注释、没事；但在 cmd 下不是，注释会被当参数传进来。
   老写法 `Number(argv[2]) || 8848` 遇到 `#` 会得到 NaN 然后偷偷回退到 8848，
   "能跑"但纯属侥幸 —— 想换端口的人会以为参数没生效。 */
const PORT = Number(process.argv.slice(2).find(a => /^\d+$/.test(a))) || 8848;

/* 版本戳每次请求现算（mtime 摘要挡住重算），不是启动时冻结 ——
   否则改完源码刷新页面，界面上那行 `构建 xxxxxxxx` 不会变，
   会把"我是不是在跑旧代码"这个判断本身变成误导源。 */
const buildId = makeBuildIdProvider(ROOT);

const server = http.createServer((req, res) => handleRequest(ROOT, buildId, req, res));

/* 端口冲突要给可照做的提示，而不是甩一段 Node 内部栈（详见 staticServe.mjs） */
server.on('error', (err) => onListenError(err, PORT, 'serve.mjs', 9000));

server.listen(PORT, '127.0.0.1', () => {
  console.log('VR OI 考场  → http://127.0.0.1:' + PORT + '/');
  console.log('构建版本  → ' + buildId() + '   (改动任何源码后自动变化)');
  console.log('Ctrl+C 停止');
});

/* 源码变了就在终端说一声，省得你盯着界面上的版本戳猜。
   unref() 保证它不会阻止进程正常退出。 */
let reported = buildId.peek();
setInterval(() => {
  const now = buildId();
  if (now !== reported){
    reported = now;
    console.log('源码已变化，版本戳更新 → ' + now + '　（浏览器刷新即生效）');
  }
}, 1000).unref();
