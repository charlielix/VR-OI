'use strict';
/* =========================================================================
   boot —— 启动检查 + 就绪后调 init()
   ---------------------------------------------------------------------
   【三次踩坑记录，别重犯】

   three.js 到底该怎么加载？我先试了两种"聪明"办法，都必然失败。写下来因为
   它们看起来都对，报错还都指向别处，极难排查。

   ✗ 办法一：动态插入 <script> 异步加载，加载完再 init()
     报错：ReferenceError: THREE is not defined
           at js/core.js:…   （core.js 顶层有 new THREE.Raycaster()）
     原因：浏览器解析到 <script src="js/boot.js"> 时，boot.js 只是【启动】了一个
           异步任务就返回；解析器立刻继续执行 core.js / world.js / … / main.js。
           等 three.js 到达网络另一头时，后面这些脚本早跑完了。
     副作用：模块级 let 全部没执行到，之后任何路径碰到它就报二次伤害的怪错，
             例如 "Cannot access 'mouseSens' before initialization"。
             两个错误信息都指向错误的地方。

   ✗ 办法二：在 boot.js 里"内联发起 + 失败时 document.write 下一个源"
     报错：three.js 没加载成功（但 window.__THREE_SRC__ 里却记着 vendor 路径）
     原因：动态插入的 script 若调用了 document.write，写入的内容会被【延迟】
           到解析恢复时才生效，注入点也不再是调用它的那个脚本位置。
           于是在解析器眼里，core.js 依然先执行。
           把等待、失败回退、document.write 三者混在一起，就是给自己埋雷。

   ✓ 办法三（采用）：three.js 用 index.html 里的【静态阻塞式 script 标签】加载。
     静态标签没有任何等待：它的 onload 之前，解析器不会往下走。
     所以 boot.js 被解析时，THREE 一定已经在全局里 —— 零时序不确定性。

     多源兜底改成"按可用性编辑"而不是"运行时探测"：默认只加载本地
     vendor/three.min.js（零网络依赖，最稳）；万一本地文件丢了，再按需
     换成 CDN 地址。三个源的正确地址都写在 index.html 的注释里。
   ========================================================================= */

/* three.js 加载失败时的兜底页面。不写"排查建议"式的含糊话，
   直接说清发生了什么、现在该做什么。
   另外无条件带上构建版本：如果页面上出现的版本号和你预期的不一样，
   那就说明浏览器在跑缓存里的旧文件 —— 这一条能把最耗时的误会一眼终结。 */
function bootFail(msg){
  const d = document.createElement('div');
  d.id = 'bootErr';
  d.innerHTML = 'VR OI 考场启动失败<br><small>' + msg + '</small>' +
    '<small style="opacity:.6">构建版本 ' + (window.__OI_BUILD__ || '未知') +
    '　（若与你看到的代码不符，就是浏览器缓存了旧文件：按 Ctrl+Shift+R 强制刷新）</small>';
  document.body.appendChild(d);
}

/* 版本戳：由 index.html 里的 ?v= 串提供，服务端会在每次请求时重写它。
   没有服务端重写（例如用 python -m http.server）时退化为"未标记"。 */
function detectBuild(){
  try {
    const s = document.querySelector('script[src*="?v="]');
    const m = s && s.getAttribute('src').match(/\?v=([^&"]+)/);
    return m ? m[1] : '未标记';
  } catch(e){ return '未标记'; }
}

function bootReady(){
  /* ---- 前置检查 1：协议 ----
     file:// 下浏览器会拦截资源请求，localStorage 也不可用（存档直接失效）。
     这是最常见的"打不开"原因，所以单独判一次，给出可照抄的命令。 */
  if (location.protocol === 'file:'){
    bootFail('当前是用 file:// 打开的。请在项目目录里启动一个 http 服务，' +
      '例如执行 <code>python -m http.server 8848</code> 或 ' +
      '<code>node tools/serve.mjs</code>，然后访问 ' +
      '<code>http://127.0.0.1:8848/</code>。');
    return;
  }

  /* ---- 前置检查 2：three.js 是否真的可用 ---- */
  if (typeof THREE === 'undefined' || !THREE.WebGLRenderer){
    bootFail('three.js 没有加载成功。<br>如果网络不可用：请把 three.min.js 放到 ' +
      'vendor/ 目录（index.html 里默认就是加载它）。<br>' +
      '如果 vendor 文件丢了：把 index.html 里那个 script 标签的 src ' +
      '换成注释中列出的任意一个 CDN 地址。');
    return;
  }

  /* ---- 前置检查 3：WebGL 是否可用 ---- */
  try {
    const probe = document.createElement('canvas');
    if (!probe.getContext('webgl') && !probe.getContext('experimental-webgl')){
      bootFail('这台机器/这个浏览器没有可用的 WebGL。请换 Chrome 或 Edge，' +
        '并确认没有在设置里禁用硬件加速。');
      return;
    }
  } catch(e){ /* 探测失败不阻塞，交给 renderer 自己报错 */ }

  window.__THREE_SRC__ = window.__THREE_SRC__ || '静态标签 or 本地 vendor';
  window.__OI_BUILD__ = detectBuild();

  /* 把版本号贴到开始界面上：肉眼可见，不用开控制台 */
  const badge = document.getElementById('buildTag');
  if (badge) badge.textContent = '构建 ' + window.__OI_BUILD__;

  /* ---- 真正启动 ---- */
  try {
    init();
    console.log('VR OI 考场 · 就绪　构建 ' + window.__OI_BUILD__ +
                '　three r' + THREE.REVISION + '　源：' + window.__THREE_SRC__);
  } catch(e){
    console.error(e);
    /* 把异常信息和来源一起摆到页面上，而不是留给白屏 */
    bootFail(String(e && e.message || e) + '<br><br>' +
      '<small>源：' + window.__THREE_SRC__ + '</small>');
  }
}

/* boot.js 排在 main.js 之前，此刻 init() 还没定义 ——
   挂到 DOMContentLoaded 上，那时 index.html 里所有脚本都已执行完毕。 */
if (document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', bootReady);
} else {
  bootReady();
}
