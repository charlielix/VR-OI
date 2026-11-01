'use strict';
/* =========================================================================
   dialog3d —— 世界空间悬浮弹窗
   ---------------------------------------------------------------------
   设计取向：不要"全屏蒙层 + DOM 对话框"。那东西一弹出就冻结了玩家的
   身体和视角，玩家变成在看网页，而不是在考场里挨骂。

   这里把弹窗做成世界空间里的一块不透明画板：
     1. 画板恒位于"以相机为球心、DLG_RADIUS 为半径"的球面上。球心跟着
        玩家走，但生成瞬间确定的方向此后锁死在世界系 —— 所以玩家可以
        一边被警告一边转身溜走，想读完就得转回来面对它。
     2. 位置用欠阻尼弹簧追踪球面目标点，玩家平移时画板滞后回摆；
        朝向由滞后位置反推（lookAt 球心），快速转身再叠一点滚转角，
        整块板子像被空气拖住。
     3. 画板 depthTest=false 且不透明 —— 它挡住视野，但绝不被场景遮挡，
        不存在"弹窗被桌子埋了看不见"的破事。
     4. 消除方式只有三种：准星/鼠标点按钮、按数字键选、视线停留 1 秒。
        全程不释放指针锁定，state.view 一直是 'world'。
   ========================================================================= */

const DLG_RADIUS      = 2.0;
const DLG_SPAWN_YAW   = 0.15;
const DLG_SPAWN_PITCH = 0.11;
const DLG_CANVAS_W    = 2000;
const DLG_CANVAS_H    = 1200;
const DLG_WORLD_H     = 1.488;
const DLG_SCALE       = 2;
const DLG_STIFFNESS   = 90;
const DLG_DAMPING     = 9;
const DLG_MAX_LEAN    = 0.32;
const DLG_DWELL_TIME  = 1.0;
const DLG_DWELL_DECAY = 0.32;
const DLG_DWELL_LOCK  = 0.45;
const DLG_STACK_STEP  = 0.44;

const DLG_COL = {
  bg: '#10141d', border: '#2b3448', accent: '#5b8cff',
  title: '#aebdd8', text: '#dde5f3', dim: '#7c869c',
  btn: '#1a2233', btnText: '#dbe4f7', btnHot: '#3b6df0'
};

const dialogs = [];
const dlgGeo = new THREE.PlaneGeometry(1, 1);
let dlgHoverBtn = null, dwellProgress = 0, dwellKey = '', dwellCooldown = 0, dlgSeq = 0;
const dlgMouseNdc = new THREE.Vector2(0, 0);
const _dlgFwd = new THREE.Vector3(), _dlgEuler = new THREE.Euler(),
      _dlgQuat = new THREE.Quaternion(), _dlgTarget = new THREE.Vector3(),
      _dlgAcc = new THREE.Vector3();

function openDialog(opts){
  const cv = makeCanvas(DLG_CANVAS_W, DLG_CANVAS_H);
  const tex = canvasTex(cv.c, true);
  const material = new THREE.MeshBasicMaterial({ map: tex });
  material.depthTest = false;             /* 永不被场景遮挡 */
  const mesh = new THREE.Mesh(dlgGeo, material);
  mesh.scale.set(DLG_WORLD_H * (DLG_CANVAS_W / DLG_CANVAS_H), DLG_WORLD_H, 1);
  mesh.renderOrder = 999;
  mesh.frustumCulled = false;
  mesh.layers.set(1);                     /* UI 层：不参与拖影，字永远锐利 */
  scene.add(mesh);

  /* 方向：当前准心方向 + 小随机偏移；多面板时左右扇形展开并逐层后退 */
  const si = dialogs.length;
  const side = si % 2 ? 1 : -1;
  const layer = (si / 2) | 0;
  _dlgFwd.set(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
  _dlgEuler.set(
    (Math.random() * 2 - 1) * DLG_SPAWN_PITCH + (layer % 2 ? 1 : -1) * 0.18 * (layer + 1),
    (Math.random() * 2 - 1) * DLG_SPAWN_YAW + side * (0.68 + 0.44 * layer),
    0, 'YXZ');
  _dlgQuat.setFromEuler(_dlgEuler);
  _dlgFwd.applyQuaternion(_dlgQuat).normalize();

  const rad = DLG_RADIUS + DLG_STACK_STEP * si;
  const dlg = {
    mesh: mesh, canvas: cv.c, ctx: cv.ctx, tex: tex,
    title: opts.title || '',
    text: opts.text || '',
    options: (opts.options || []).map(o => ({ label: o.label, cb: o.cb })),
    rad: rad,
    dir: _dlgFwd.clone(),
    pos: new THREE.Vector3(), vel: new THREE.Vector3(),
    buttons: [], textMaxH: 0,
    hover: -1, lean: 0, lastYaw: state.yaw, id: ++dlgSeq
  };
  /* 初始落位略近 + 给一点外抛速度，让板子"弹"到球面上 */
  _dlgTarget.copy(camera.position).addScaledVector(dlg.dir, rad);
  dlg.pos.copy(_dlgTarget).addScaledVector(dlg.dir, -0.28);
  dlg.vel.copy(dlg.dir).multiplyScalar(0.7);

  layoutDialog(dlg);
  drawDialog(dlg, -1);
  dialogs.push(dlg);
  return dlg;
}

/* 停留进度归零 —— 抽成函数是因为它有四个触发点，以前写在各处、覆盖不全。
   进度环是"准星正停在某个按钮上"的指示，没有任何弹窗时它无从谈起；
   不清就会永远留在屏幕上（下面 closeDialog 里那条注释写了怎么复现）。 */
function resetDwell(){ dlgHoverBtn = null; dwellProgress = 0; dwellKey = ''; }

function closeDialog(dlg){
  const i = dialogs.indexOf(dlg);
  if (i < 0) return;
  dialogs.splice(i, 1);
  scene.remove(dlg.mesh);
  dlg.tex.dispose();
  dlg.mesh.material.dispose();
  /* 两种情况都要清停留状态：
     ① 关掉的正是当前悬停的那个 —— 悬停引用当场失效；
     ② 一个弹窗都不剩 —— 没有"正在盯着的按钮"这回事了。
     老代码只判了 ①，于是 ② 漏了。而 ① 还判不出来：点鼠标走的是
     activateDialogButton()，它**先把 dlgHoverBtn 置空**再调回调，
     回调里再 closeDialog 时 `dlgHoverBtn.dlg === dlg` 已经是 false。
     结果就是"用鼠标提前关掉弹窗"（进度环还没走满）时进度永远停在半途，
     环一直挂在准星外面下不来。 */
  if (!dialogs.length || (dlgHoverBtn && dlgHoverBtn.dlg === dlg)) resetDwell();
}

function dismissDialogs(){ while (dialogs.length) closeDialog(dialogs[0]); }
function hasDialog(){ return dialogs.length > 0; }

/* 原地改写内容：老师的"回复态"就是换正文换按钮，不重开弹窗 */
function setDialogContent(dlg, opts){
  if (!dlg || dialogs.indexOf(dlg) < 0) return;
  if (typeof opts.title === 'string') dlg.title = opts.title;
  if (typeof opts.text === 'string') dlg.text = opts.text;
  if (opts.options) dlg.options = opts.options.map(o => ({ label: o.label, cb: o.cb }));
  dlg.hover = -1;
  layoutDialog(dlg);
  drawDialog(dlg, -1);
}

/* 激活当前注视的按钮。回调自己决定 closeDialog 还是 setDialogContent */
function activateDialogButton(){
  if (!dlgHoverBtn) return false;
  const dlg = dlgHoverBtn.dlg, idx = dlgHoverBtn.idx;
  /* 先把停留状态清掉再调回调：按钮已经被消费，进度环没有继续存在的理由。
     注意这里必须用 resetDwell()，不能只写 dlgHoverBtn = null ——
     dwellProgress 不清的话，回调"没关弹窗"时环会卡在满格，更难看。 */
  resetDwell();
  const opt = dlg.options[idx];
  if (opt && opt.cb) opt.cb(dlg);
  return true;
}

function selectDialogOption(n){
  const dlg = dialogs[dialogs.length - 1];
  if (!dlg) return false;
  const opt = dlg.options[n];
  if (!opt) return false;
  resetDwell();          /* 数字键选完也一样，别给下一次留半格进度 */
  if (opt.cb) opt.cb(dlg);
  return true;
}

/* 纯文本弹窗（没有按钮）没有"点按钮"这条出路 —— 点一下画面就当作"我知道了"。
   否则只要有一个无选项弹窗，玩家就只剩按 Esc 一条路，
   而按 Esc 又会连带弹出暂停菜单，体验上就是"卡住了"。 */
function dismissPlainDialog(){
  const dlg = dialogs[dialogs.length - 1];
  if (!dlg || dlg.options.length) return false;
  closeDialog(dlg);
  return true;
}

/* 准星读取的停留状态（进度环 / 交互态） */
function dialogDwell(){ return { progress: dwellProgress, active: dlgHoverBtn !== null }; }

function updateDialogs(dt){
  /* 冷却要**先**走。老代码把它放在早退后面，于是没弹窗时冷却永远不衰减，
     开下一个弹窗时还得白等一段 —— 玩家看到的是"视线停留有时候不管用"。 */
  if (dwellCooldown > 0) dwellCooldown = Math.max(0, dwellCooldown - dt);
  if (!dialogs.length){
    resetDwell();
    return;
  }

  const prevHover = dialogs.map(d => d.hover);

  /* 1. 物理：弹簧追踪球面目标 + 相切朝向 + 转身拖尾 */
  for (const dlg of dialogs){
    dlg.hover = -1;

    _dlgTarget.copy(camera.position).addScaledVector(dlg.dir, dlg.rad);
    _dlgAcc.copy(_dlgTarget).sub(dlg.pos).multiplyScalar(DLG_STIFFNESS)
          .addScaledVector(dlg.vel, -DLG_DAMPING);
    dlg.vel.addScaledVector(_dlgAcc, dt);
    dlg.pos.addScaledVector(dlg.vel, dt);
    dlg.mesh.position.copy(dlg.pos);
    dlg.mesh.lookAt(camera.position);

    let dyaw = state.yaw - dlg.lastYaw;
    dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
    dlg.lastYaw = state.yaw;
    const rate = clamp(dyaw / Math.max(dt, 1e-3), -8, 8);
    dlg.lean = lerp(dlg.lean, clamp(rate * 0.045, -DLG_MAX_LEAN, DLG_MAX_LEAN),
                    1 - Math.exp(-dt * 7));
    dlg.mesh.rotateZ(-dlg.lean);
  }

  /* 2. 拾取：锁定时用准星，未锁定时用鼠标位置；多板取最近命中的按钮 */
  raycaster.far = DLG_RADIUS + DLG_STACK_STEP * dialogs.length + 0.5;
  if (pointerLocked) raycaster.setFromCamera(CENTER, camera);
  else raycaster.setFromCamera(dlgMouseNdc, camera);

  let best = null;
  for (const dlg of dialogs){
    const hits = raycaster.intersectObject(dlg.mesh, false);
    if (!hits.length || !hits[0].uv) continue;
    const px = hits[0].uv.x * DLG_CANVAS_W;
    const py = (1 - hits[0].uv.y) * DLG_CANVAS_H;
    const idx = hitDialogButton(dlg, px, py);
    if (idx < 0) continue;
    if (!best || hits[0].distance < best.dist) best = { dlg: dlg, idx: idx, dist: hits[0].distance };
  }
  if (best) best.dlg.hover = best.idx;
  dlgHoverBtn = best ? { dlg: best.dlg, idx: best.idx } : null;

  /* 只重画悬停状态变过的那几块 */
  dialogs.forEach((d, i) => { if (d.hover !== prevHover[i]) drawDialog(d, d.hover); });

  /* 3. 视线停留：对准即填充；换目标或脱离快速倒退 */
  const key = best ? best.dlg.id + ':' + best.idx : '';
  if (key && key === dwellKey && dwellCooldown <= 0){
    dwellProgress += dt / DLG_DWELL_TIME;
    if (dwellProgress >= 1){
      dwellProgress = 0; dwellKey = ''; dwellCooldown = DLG_DWELL_LOCK;
      const opt = best.dlg.options[best.idx];
      if (opt && opt.cb) opt.cb(best.dlg);
    }
  } else {
    dwellKey = key;
    dwellProgress = Math.max(0, dwellProgress - dt / DLG_DWELL_DECAY);
  }
}

function hitDialogButton(dlg, px, py){
  for (let i = 0; i < dlg.buttons.length; i++){
    const b = dlg.buttons[i];
    if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) return i;
  }
  return -1;
}

/* ---------------------------- 布局与绘制 ---------------------------- */
function layoutDialog(dlg){
  const n = dlg.options.length;
  dlg.buttons = [];
  if (!n){ dlg.textMaxH = DLG_CANVAS_H - 132; return; }

  const cols = Math.min(2, n);
  const rows = Math.ceil(n / cols);
  const pad = 28 * DLG_SCALE, gap = 14 * DLG_SCALE, bh = 66 * DLG_SCALE;
  const bw = (DLG_CANVAS_W - pad * 2 - gap * (cols - 1)) / cols;
  const totalH = rows * bh + (rows - 1) * gap;
  const top = DLG_CANVAS_H - pad - totalH;
  dlg.textMaxH = top - (104 + 12) * DLG_SCALE;

  for (let i = 0; i < n; i++){
    const c = i % cols, r = (i / cols) | 0;
    dlg.buttons.push({
      x: pad + c * (bw + gap),
      y: top + r * (bh + gap),
      w: bw, h: bh,
      label: (i < 9 ? (i + 1) + '. ' : '') + dlg.options[i].label
    });
  }
}

function roundRectPath(ctx, x, y, w, h, r){
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawDialog(dlg, hoverIdx){
  const ctx = dlg.ctx, W = DLG_CANVAS_W, H = DLG_CANVAS_H;
  ctx.clearRect(0, 0, W, H);

  roundRectPath(ctx, 6 * DLG_SCALE, 6 * DLG_SCALE,
                W - 12 * DLG_SCALE, H - 12 * DLG_SCALE, 18 * DLG_SCALE);
  ctx.fillStyle = DLG_COL.bg;
  ctx.fill();
  ctx.lineWidth = 3 * DLG_SCALE;
  ctx.strokeStyle = DLG_COL.border;
  ctx.stroke();

  ctx.fillStyle = DLG_COL.accent;
  ctx.fillRect(16 * DLG_SCALE, 34 * DLG_SCALE, 5 * DLG_SCALE, H - 68 * DLG_SCALE);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  if (dlg.title){
    ctx.font = '600 ' + (37 * DLG_SCALE) + 'px "Microsoft YaHei", "PingFang SC", sans-serif';
    ctx.fillStyle = DLG_COL.title;
    ctx.fillText(dlg.title, 40 * DLG_SCALE, 32 * DLG_SCALE);
  }

  ctx.font = (26 * DLG_SCALE) + 'px "Microsoft YaHei", "PingFang SC", sans-serif';
  ctx.fillStyle = DLG_COL.text;
  const lines = wrapDialogText(ctx, dlg.text, W - 96 * DLG_SCALE);
  const maxLines = Math.max(1, Math.floor(dlg.textMaxH / (38 * DLG_SCALE)));
  for (let i = 0; i < Math.min(lines.length, maxLines); i++){
    ctx.fillText(lines[i], 40 * DLG_SCALE, (104 + i * 38) * DLG_SCALE);
  }
  if (lines.length > maxLines){
    ctx.fillStyle = DLG_COL.dim;
    ctx.fillText('……', 40 * DLG_SCALE, (104 + maxLines * 38) * DLG_SCALE);
  }

  dlg.buttons.forEach((b, i) => {
    const hot = i === hoverIdx;
    roundRectPath(ctx, b.x, b.y, b.w, b.h, 12 * DLG_SCALE);
    ctx.fillStyle = hot ? DLG_COL.btnHot : DLG_COL.btn;
    ctx.fill();
    ctx.lineWidth = 2 * DLG_SCALE;
    ctx.strokeStyle = hot ? '#8fb0ff' : DLG_COL.border;
    ctx.stroke();
    ctx.font = (hot ? '600 ' : '') + (25 * DLG_SCALE) + 'px "Microsoft YaHei", "PingFang SC", sans-serif';
    ctx.fillStyle = hot ? '#ffffff' : DLG_COL.btnText;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2 + DLG_SCALE);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
  });

  dlg.tex.needsUpdate = true;
}

/* 中英混排换行：拉丁/数字按词切、CJK 按字切，尊重原文换行 */
function wrapDialogText(ctx, text, maxW){
  const out = [];
  for (const para of String(text).split('\n')){
    let line = '';
    const tokens = para.match(/[A-Za-z0-9_.'"()\[\]:;,-]+|\s+|[\s\S]/g) || [];
    for (const tk of tokens){
      if (tk === '\n'){ out.push(line); line = ''; continue; }
      if (!line && /^\s+$/.test(tk)) continue;
      const t = line + tk;
      if (line && ctx.measureText(t).width > maxW && tk.trim()){
        out.push(line.replace(/\s+$/, ''));
        line = /^\s+$/.test(tk) ? '' : tk;
      } else {
        line = t;
      }
    }
    out.push(line.replace(/\s+$/, ''));
  }
  return out;
}
