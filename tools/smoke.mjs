/* =============================================================================
   smoke.mjs —— 无浏览器冒烟测试
   -----------------------------------------------------------------------------
   在一个 vm 沙箱里用 DOM / THREE / AudioContext 的桩件把整个前端跑起来，
   然后按流程断言：加载 → 初始化 → 判题 → 校园段 → 桌面与小恐龙 → 考场段。

   为什么要这个文件：
     浏览器里报一个语法错，你得手动点半天才能复现；这里 3 秒就能把
     加载期错误、"函数名写错"、"某段逻辑只在特定区域才炸"全都逼出来。

   桩件的两条纪律（都是被真实错误教出来的）：
     1) 桩必须覆盖代码用到的每一个 THREE 符号。少一个类，错误会晚很久才
        在完全无关的地方炸出来 —— 所以下面把用到的符号一次列全。
     2) 桩的元素要能派发 document 级键盘事件。不然 doInteract / 移动这类
        逻辑只能靠直接调函数来测，测不到真实的按键路由。

   注意：这个文件里的中文必须是 UTF-8。用 PowerShell 的 Get-Content /
   Set-Content 改它会按系统 ANSI 码页转码，直接把中文写坏（真的毁过一次，
   原文不可逆，只能重建）。改文件请用带编码感知的编辑器或 apply_patch。
   ============================================================================= */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const noop = () => {};

/* 2D 上下文桩。放在顶层是因为 mkCanvasEl()（渲染器 domElement）也要用，
   而它不属于 buildDOM() 的作用域。 */
function makeCtxStub(){
  return {
    fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: '', lineJoin: '',
    font: '', textAlign: '', textBaseline: '', globalAlpha: 1,
    globalCompositeOperation: '', shadowBlur: 0, shadowColor: '',
    fillRect: noop, clearRect: noop, strokeRect: noop,
    fillText: noop, strokeText: noop,
    beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop,
    arc: noop, arcTo: noop, ellipse: noop, bezierCurveTo: noop, quadraticCurveTo: noop,
    rect: noop, stroke: noop, fill: noop, clip: noop,
    save: noop, restore: noop, translate: noop, rotate: noop, scale: noop,
    setTransform: noop, resetTransform: noop, transform: noop,
    drawImage: noop, createPattern: () => null,
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    putImageData: noop, createImageData: () => ({ data: new Uint8ClampedArray(4) }),
    measureText: () => ({ width: 10 }),
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    setLineDash: noop, getLineDash: () => []
  };
}
/* 2D 上下文工厂。名字必须和 sandbox 上挂的那个一致 —— getContext 由 app 代码
   调用，自由标识符按 app 的全局作用域解析，所以这只在无头测试里才是问题。 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* 渲染器 domElement 用的最小 canvas。
   关键点：addEventListener 必须**把监听器存下来**，dispatchEvent 必须**真的调用它们**。
   只要有一处是空壳，"点击画面"这类输入路径在测试里就成了空跑 ——
   测试全绿，真机却点不动，而失败信息只会是"没申请锁定"这种误导性结论。
   所以事件收发在桩里必须是真的。 */
function mkCanvasEl(){
  const handlers = new Map();
  return {
    tagName: 'CANVAS', id: '', style: {}, dataset: {}, width: 900, height: 300,
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    addEventListener(t, fn){
      if (!handlers.has(t)) handlers.set(t, []);
      handlers.get(t).push(fn);
    },
    removeEventListener(t, fn){
      const a = handlers.get(t);
      if (a){ const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
    },
    dispatchEvent(ev){
      const type = ev && ev.type;
      for (const fn of (handlers.get(type) || [])) fn(ev);
      const h = this['on' + type];
      if (typeof h === 'function') h(ev);
      return true;
    },
    /* 供测试断言"这条路真的被跑到过" */
    __handlerCount(t){ return (handlers.get(t) || []).length; },
    requestPointerLock: noop, exitPointerLock: noop,
    /* 直接调同模块的 function 声明，不读任何自由变量。
       踩过的坑：跨 realm 的闭包里，自由标识符（ctxStub）和 globalThis.__ctx2d
       都不保证能解析到 sandbox 上挂的那个 —— 一个报 "is not defined"，
       另一个报 "is not a function"，而 mkEl/buildDOM 在模块初始化时就被调用，
       根本等不到 sandbox 构造完。makeCtxStub 是 function 声明、必然在闭包里。 */
    getContext(){ return makeCtxStub(); },
    getBoundingClientRect(){ return { left: 0, top: 0, width: 1280, height: 720 }; },
    focus: noop, blur: noop, remove: noop, appendChild(c){ return c; }
  };
}

/* ============================ 1. THREE 桩件 ============================ */
function buildTHREE(){
  class Vector3 {
    constructor(x, y, z){ this.x = x || 0; this.y = y || 0; this.z = z || 0; }
    set(x, y, z){ this.x = x; this.y = y; this.z = z; return this; }
    copy(v){ return this.set(v.x, v.y, v.z); }
    clone(){ return new Vector3(this.x, this.y, this.z); }
    add(v){ this.x += v.x; this.y += v.y; this.z += v.z; return this; }
    addScaledVector(v, s){ this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
    sub(v){ this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
    subVectors(a, b){ return this.set(a.x - b.x, a.y - b.y, a.z - b.z); }
    multiplyScalar(s){ this.x *= s; this.y *= s; this.z *= s; return this; }
    divideScalar(s){ return this.multiplyScalar(1 / s); }
    length(){ return Math.hypot(this.x, this.y, this.z); }
    lengthSq(){ return this.x * this.x + this.y * this.y + this.z * this.z; }
    normalize(){ const l = this.length() || 1; return this.divideScalar(l); }
    dot(v){ return this.x * v.x + this.y * v.y + this.z * v.z; }
    crossVectors(a, b){
      return this.set(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
    }
    distanceTo(v){ return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
    lerp(v, a){ this.x += (v.x - this.x) * a; this.y += (v.y - this.y) * a; this.z += (v.z - this.z) * a; return this; }
    applyQuaternion(){ return this; }
    applyMatrix4(){ return this; }
    setFromMatrixPosition(){ return this; }
    setFromSphericalCoords(r, phi, theta){
      const sp = Math.sin(phi);
      return this.set(r * sp * Math.sin(theta), r * Math.cos(phi), r * sp * Math.cos(theta));
    }
    toArray(){ return [this.x, this.y, this.z]; }
    fromArray(a){ return this.set(a[0], a[1], a[2]); }
    setScalar(s){ this.x = s; this.y = s; this.z = s; return this; }
    setX(x){ this.x = x; return this; }
    setY(y){ this.y = y; return this; }
    setZ(z){ this.z = z; return this; }
    negate(){ this.x = -this.x; this.y = -this.y; this.z = -this.z; return this; }
    clampLength(min, max){
      const l = this.length() || 1;
      return this.multiplyScalar(Math.max(min, Math.min(max, l)) / l);
    }
    project(){ return this; }
    unproject(){ return this; }
    transformDirection(){ return this; }
    setFromMatrixColumn(){ return this; }
    equals(v){ return this.x === v.x && this.y === v.y && this.z === v.z; }
    distanceToSquared(v){
      const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z;
      return dx * dx + dy * dy + dz * dz;
    }
  }
  class Vector2 {
    constructor(x, y){ this.x = x || 0; this.y = y || 0; }
    set(x, y){ this.x = x; this.y = y; return this; }
  }
  class Euler {
    constructor(x, y, z){ this.x = x || 0; this.y = y || 0; this.z = z || 0; }
    set(x, y, z){ this.x = x; this.y = y; this.z = z; return this; }
  }
  class Quaternion {
    constructor(){ this.x = 0; this.y = 0; this.z = 0; this.w = 1; }
    setFromAxisAngle(){ return this; }
    setFromEuler(){ return this; }
  }
  class Color {
    constructor(c){ this.hex = typeof c === 'number' ? c : 0xffffff; }
    setHex(h){ this.hex = h; return this; }
    set(h){ this.hex = h; return this; }
    getHex(){ return this.hex; }
    clone(){ return new Color(this.hex); }
    copy(c){ this.hex = c.hex; return this; }
    /* lerp 是必需的：reticle.js / tension.js 用它插值准星颜色。
       缺了它会在主循环里每帧抛错，而错误位置指向调用行，看不出是桩的问题。 */
    lerp(c, a){
      const ch = (v, s) => (v >> s) & 0xff;
      const mix = (s) => Math.round(ch(this.hex, s) * (1 - a) + ch(c.hex, s) * a);
      this.hex = (mix(16) << 16) | (mix(8) << 8) | mix(0);
      return this;
    }
    setRGB(r, g, b){
      this.hex = ((Math.round(r * 255) & 0xff) << 16) | ((Math.round(g * 255) & 0xff) << 8) | (Math.round(b * 255) & 0xff);
      return this;
    }
    getRGB(){ return { r: 1, g: 1, b: 1 }; }
    getHexString(){ return this.hex.toString(16).padStart(6, '0'); }
    setHSL(){ return this; }
    offsetHSL(){ return this; }
    multiplyScalar(s){
      this.hex = (((Math.round(((this.hex >> 16) & 0xff) * s) & 0xff) << 16) |
                  ((Math.round(((this.hex >> 8) & 0xff) * s) & 0xff) << 8) |
                  (Math.round((this.hex & 0xff) * s) & 0xff));
      return this;
    }
    equals(c){ return this.hex === c.hex; }
  }
  class Matrix4 {
    constructor(){ this.elements = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]; }
    identity(){ return this; }
    copy(m){ this.elements = m.elements.slice(); return this; }
    clone(){ return new Matrix4().copy(this); }
    decompose(){ return this; }
    compose(){ return this; }
    makeRotationY(){ return this; }
    makeTranslation(){ return this; }
    premultiply(){ return this; }
    multiply(){ return this; }
    invert(){ return this; }
    setPosition(){ return this; }
  }
  class Layers {
    constructor(){ this.mask = 1; }
    set(ch){ this.mask = 1 << ch; return this; }
    enable(ch){ this.mask |= (1 << ch); return this; }
    enableAll(){ this.mask = 0xffffffff; return this; }
    disable(ch){ this.mask &= ~(1 << ch); return this; }
    disableAll(){ this.mask = 0; return this; }
    toggle(ch){ this.mask ^= (1 << ch); return this; }
    test(l){ return (this.mask & l.mask) !== 0; }
  }
  class Base {
    constructor(){
      this.position = new Vector3();
      this.rotation = new Euler();
      this.scale = new Vector3(1, 1, 1);
      this.quaternion = new Quaternion();
      this.userData = {};
      this.children = [];
      this.visible = true;
      this.parent = null;
      this.matrix = new Matrix4();
      this.up = new Vector3(0, 1, 0);
      /* layers 是必需的：core.js 会 raycaster.layers.enable(1)，
         postfx.js 会 camera.layers.enable(0/1)。少了它整个脚本直接中断，
         然后报出来的是一堆看似无关的错。 */
      this.layers = new Layers();
    }
    add(o){ if (o){ this.children.push(o); o.parent = this; } return this; }
    remove(o){ const i = this.children.indexOf(o); if (i >= 0) this.children.splice(i, 1); return this; }
    clear(){ this.children.length = 0; return this; }
    traverse(fn){ fn(this); for (const c of this.children){ if (c && c.traverse) c.traverse(fn); } }
    lookAt(){ return this; }
    updateMatrixWorld(){ return this; }
    updateMatrix(){ return this; }
    getWorldPosition(t){ return (t || new Vector3()).copy(this.position); }
    getWorldQuaternion(q){ return q || new Quaternion(); }
    applyMatrix4(){ return this; }
    /* 局部旋转：dialog3d.js 会 dlg.mesh.rotateZ(...)，reticle 也会用到。
       缺了它主循环每帧抛错，而报错位置指向 dialog3d，看不出是桩的问题。 */
    rotateX(a){ this.rotation.x += (a || 0); return this; }
    rotateY(a){ this.rotation.y += (a || 0); return this; }
    rotateZ(a){ this.rotation.z += (a || 0); return this; }
    translateX(){ return this; }
    translateY(){ return this; }
    translateZ(){ return this; }
    setRotationFromAxisAngle(){ return this; }
    setRotationFromEuler(){ return this; }
    dispose(){}
    /* clone() 要真的复制，并且返回同类实例：campus.js 用
       auditLedA.clone() 造第二盏指示灯，会再改它的 position.x。
       如果 clone 返回同一个对象，两盏灯就是同一盏，位置也一起被改 —— 
       测试会"通过"但掩盖真实 bug。 */
    clone(recursive){
      const c = new this.constructor();
      c.position.copy(this.position);
      c.rotation.set(this.rotation.x, this.rotation.y, this.rotation.z);
      c.scale.copy(this.scale);
      c.visible = this.visible;
      c.userData = Object.assign({}, this.userData);
      if (this.geometry) c.geometry = this.geometry;
      if (this.material) c.material = this.material;
      if (this.material && this.material.clone && !this.geometry) c.material = this.material.clone();
      if (recursive !== false){
        for (const ch of this.children){ if (ch.clone) c.add(ch.clone(true)); }
      }
      return c;
    }
  }
  class Scene extends Base { constructor(){ super(); this.fog = null; this.background = null; } }
  class Group extends Base {}
  class Mesh extends Base {
    constructor(g, m){ super(); this.geometry = g || new Geometry(); this.material = m || new MeshBasicMaterial(); }
  }

  /* 几何构造函数：必须真的能 `new`（three 的几何都是 class）。
     用箭头函数会让 `new THREE.BoxGeometry(...)` 直接抛
     "is not a constructor"，而且这个错会连累整个脚本，导致后面所有
     顶层 let 都没被初始化 —— 报出来的错会指向完全无关的行。 */
  class Geometry {
    constructor(){
      this.attributes = {
        position: { count: 24, array: new Float32Array(72), setXYZ: noop, needsUpdate: false },
        normal: { count: 24, array: new Float32Array(72), setXYZ: noop, needsUpdate: false },
        uv: { count: 24, array: new Float32Array(48), setXYZ: noop, needsUpdate: false }
      };
      this.index = null;
      this.groups = [];
      this.boundingSphere = { center: new Vector3(), radius: 1 };
      this.boundingBox = { min: new Vector3(-1, -1, -1), max: new Vector3(1, 1, 1) };
    }
    setAttribute(n, a){ this.attributes[n] = a; return this; }
    setIndex(){ return this; }
    translate(){ return this; }
    rotateX(){ return this; }
    computeBoundingSphere(){ return this; }
    computeBoundingBox(){ return this; }
    applyMatrix4(){ return this; }
    dispose(){}
  }
  class BoxGeometry extends Geometry { constructor(w, h, d){ super(); this.parameters = { width: w, height: h, depth: d }; } }
  class PlaneGeometry extends Geometry { constructor(w, h){ super(); this.parameters = { width: w, height: h }; } }
  class SphereGeometry extends Geometry { constructor(r, a, b){ super(); this.parameters = { radius: r, widthSegments: a, heightSegments: b }; } }
  class CylinderGeometry extends Geometry { constructor(rt, rb, h, s){ super(); this.parameters = { radiusTop: rt, radiusBottom: rb, height: h, radialSegments: s }; } }
  class RingGeometry extends Geometry { constructor(ri, ro, s){ super(); this.parameters = { innerRadius: ri, outerRadius: ro, thetaSegments: s }; } }
  class CircleGeometry extends Geometry { constructor(r, s){ super(); this.parameters = { radius: r, segments: s }; } }
  class ConeGeometry extends Geometry { constructor(r, h, s){ super(); this.parameters = { radius: r, height: h, radialSegments: s }; } }
  class TorusGeometry extends Geometry { constructor(r, t){ super(); this.parameters = { radius: r, tube: t }; } }

  class Material {
    constructor(opts){
      Object.assign(this, {
        color: 0xffffff, opacity: 1, transparent: false, visible: true,
        side: 0, depthWrite: true, map: null, blending: 0
      }, opts || {});
      if (typeof this.color === 'number') this.color = new Color(this.color);
    }
    clone(){ return new Material(this); }
    dispose(){}
  }
  class MeshBasicMaterial extends Material {}
  class MeshStandardMaterial extends Material {}
  class ShaderMaterial extends Material {
    constructor(o){
      super(o);
      this.uniforms = (o && o.uniforms) || {};
      this.vertexShader = (o && o.vertexShader) || '';
      this.fragmentShader = (o && o.fragmentShader) || '';
    }
  }
  class Texture {
    constructor(img){
      this.image = img;
      this.repeat = { set: noop, x: 1, y: 1 };
      this.offset = { set: noop, x: 0, y: 0 };
      this.wrapS = 0; this.wrapT = 0; this.anisotropy = 1; this.needsUpdate = false;
    }
    dispose(){}
  }
  class CanvasTexture extends Texture {}
  class WebGLRenderTarget {
    constructor(w, h){ this.width = w; this.height = h; this.texture = new Texture(); }
    setSize(w, h){ this.width = w; this.height = h; return this; }
    clone(){ return new WebGLRenderTarget(this.width, this.height); }
    dispose(){}
  }

  class Light extends Base { constructor(c, i){ super(); this.color = new Color(c); this.intensity = i; } }
  class PointLight extends Light {
    constructor(c, i, d, dec){ super(c, i); this.isPointLight = true; this.distance = d; this.decay = dec; }
  }
  class AmbientLight extends Light { constructor(c, i){ super(c, i); this.isAmbientLight = true; } }
  class HemiLight extends Light {
    constructor(s, g, i){ super(s, i); this.isHemisphereLight = true; this.groundColor = new Color(g); }
  }
  /* 校园的日光是 DirectionalLight。桩里原本只做到 HemiLight —— 这不是代码错，
     是桩缺了一个类，initCampusLights() 一加就立刻暴露出来。
     桩缺类比代码错更值得警惕：它会一路静默，最后炸在完全无关的地方。 */
  class DirectionalLight extends Light {
    constructor(c, i){
      super(c, i);
      this.isDirectionalLight = true;
      this.target = new Base();
      this.shadow = { mapSize: { set: noop, width: 0, height: 0 }, camera: {}, bias: 0, normalBias: 0 };
    }
  }
  class GridHelper extends Base { constructor(){ super(); this.material = new Material(); } }
  /* 雾：postfx/tension 会改它的 density，所以那两个字段要真实存在。 */
  class FogExp2 {
    constructor(color, density){ this.color = new Color(color); this.density = density; this.name = ''; }
    clone(){ return new FogExp2(this.color.hex, this.density); }
  }
  class Fog {
    constructor(color, near, far){ this.color = new Color(color); this.near = near; this.far = far; }
    clone(){ return new Fog(this.color.hex, this.near, this.far); }
  }

  class Ray {
    constructor(o, d){ this.origin = o || new Vector3(); this.direction = d || new Vector3(0, 0, -1); }
    at(t, target){
      target = target || new Vector3();
      return target.copy(this.origin).addScaledVector(this.direction, t);
    }
    intersectBox(){ return null; }
    intersectSphere(){ return null; }
    applyMatrix4(){ return this; }
  }

  class Camera extends Base {
    constructor(){ super(); this.fov = 70; this.near = 0.1; this.far = 1000; this.aspect = 1; this.zoom = 1; }
    updateProjectionMatrix(){ return this; }
    updateMatrixWorld(){ return this; }
    getWorldDirection(t){ return (t || new Vector3()).set(0, 0, -1); }
    setViewOffset(){ return this; }
  }
  class PerspectiveCamera extends Camera {}
  class OrthographicCamera extends Camera {
    constructor(l, r, t, b, n, f){
      super();
      this.left = l; this.right = r; this.top = t; this.bottom = b; this.near = n; this.far = f;
    }
  }

  /* 射线检测：默认打不到任何东西。
     需要"打到了"的测试，自己给它挂 __hit = { dist }。 */
  class Raycaster {
    constructor(){
      this.ray = new Ray();
      this.near = 0; this.far = Infinity; this.camera = null; this.params = {};
      this.layers = new Layers();
    }
    setFromCamera(){ return this; }
    set(){ return this; }
    intersectObject(){ return []; }
    intersectObjects(list){
      const arr = Array.isArray(list) ? list : [list];
      const hits = [];
      for (const o of arr){
        if (o && o.__hit) hits.push({ object: o, distance: o.__hit.dist || 1, point: new Vector3() });
      }
      hits.sort((a, b) => a.distance - b.distance);
      return hits;
    }
  }

  class Clock {
    constructor(auto){
      this.autoStart = auto !== false;
      this.startTime = Date.now();
      this.oldTime = this.startTime;
      this.running = false;
      this.elapsedTime = 0;
    }
    getDelta(){
      const n = Date.now();
      const d = Math.max(0, (n - this.oldTime) / 1000);
      this.oldTime = n;
      this.elapsedTime += d;
      return d;
    }
    getElapsedTime(){ return this.elapsedTime; }
  }

  class Renderer {
    constructor(){
      /* domElement 必须能真的收发事件。
         注意 buildTHREE() 执行时 document 还不一定在作用域里（桩是按需构建的），
         所以这里不依赖 document.createElement —— 自己造一个带**可用**
         addEventListener/dispatchEvent 的最小元素。
         之前的版本给的是 { addEventListener: noop, ... }：onclick 赋值碰巧能跑，
         但 addEventListener 注册的监听器被直接丢掉、dispatchEvent 又不存在，
         于是"点击画面"这条路径在测试里从来没被真正执行过 ——
         鼠标失灵的 bug 正是这样漏掉的。 */
      this.domElement = mkCanvasEl();
      this.shadowMap = { enabled: false, type: 0 };
      this.capabilities = { isWebGL2: true };
      this.info = { render: { calls: 0 } };
      this.__passes = 0;
    }
    setSize(){} setPixelRatio(){} setClearColor(){}
    render(){ this.__passes++; this.info.render.calls++; }
    setRenderTarget(){} clear(){} dispose(){}
    /* postfx 的分层渲染会调 clearDepth / autoClear 这些开关 */
    clearDepth(){}
    clearColor(){}
    clearStencil(){}
    getContext(){ return {}; }
    getDrawingBufferSize(t){ return (t || { x: 0, y: 0, set: noop }); }
    setViewport(){}
    setScissorTest(){}
    getPixelRatio(){ return 1; }
    setAnimationLoop(fn){ if (fn) fn(); }
    compile(){}
    forceContextLoss(){}
  }

  return {
    REVISION: '128',
    Vector2, Vector3, Euler, Quaternion, Color, Matrix4,
    Scene, Group, Mesh, Base, Object3D: Base,
    BoxGeometry, SphereGeometry, PlaneGeometry,
    CylinderGeometry, RingGeometry, CircleGeometry, ConeGeometry, TorusGeometry,
    MeshBasicMaterial, MeshStandardMaterial, ShaderMaterial, Material,
    Texture, CanvasTexture, WebGLRenderTarget,
    PointLight, AmbientLight, HemisphereLight: HemiLight, DirectionalLight,
    GridHelper, Ray, Raycaster, Clock, Fog, FogExp2,
    PerspectiveCamera, OrthographicCamera,
    WebGLRenderer: Renderer,
    /* 枚举值随便给，只要唯一且不为 undefined：它们会被赋到材质属性上，
       undefined 会让 `m.side === THREE.DoubleSide` 这类判断静默失配。 */
    DoubleSide: 2, FrontSide: 0, BackSide: 1,
    AdditiveBlending: 2, NormalBlending: 1,
    LinearFilter: 1006, NearestFilter: 1003, NearestMipMapNearestFilter: 1004,
    RepeatWrapping: 1000, ClampToEdgeWrapping: 1001,
    RGBAFormat: 1023, SRGBColorSpace: 'srgb', sRGBEncoding: 3001,
    PCFSoftShadowMap: 2, BasicShadowMap: 0
  };
}


/* ============================ 2. DOM 桩件 ============================ */
function buildDOM(){
  const byId = new Map();
  const listeners = new Map();
  const winListeners = new Map();

  /* Canvas 2D 上下文的桩：方法一个都不能少，否则会炸在
     "ctx.ellipse is not a function" 这种毫无信息量的地方。 */
  function mkEl(tag, id){
    return {
      tagName: (tag || 'div').toUpperCase(),
      id: id || '',
      style: {},
      dataset: {},
      children: [],
      classList: (() => {
        const s = new Set();
        return {
          add: (...c) => c.forEach(x => s.add(x)),
          remove: (...c) => c.forEach(x => s.delete(x)),
          toggle: (c, on) => {
            if (on === undefined){ s.has(c) ? s.delete(c) : s.add(c); }
            else { on ? s.add(c) : s.delete(c); }
          },
          contains: c => s.has(c),
          _all: () => [...s]
        };
      })(),
      textContent: '', innerHTML: '', innerText: '', value: '', title: '',
      width: 900, height: 300, scrollTop: 0, scrollHeight: 0, clientHeight: 600,
      checked: false, disabled: false,
      onclick: null, onchange: null, oninput: null, onkeydown: null, onkeyup: null,
      onmousedown: null, onmouseup: null, onmousemove: null, onfocus: null, onblur: null,
      appendChild(c){ this.children.push(c); return c; },
      removeChild(c){ return c; },
      insertBefore(c){ this.children.push(c); return c; },
      remove(){},
      setAttribute(){}, getAttribute(){ return null; }, removeAttribute(){},
      addEventListener(t, fn){
        const k = 'el:' + (this.id || this.tagName) + ':' + t;
        if (!listeners.has(k)) listeners.set(k, []);
        listeners.get(k).push(fn);
      },
      removeEventListener: noop,
      /* 真的把事件派发给已注册的监听器。
         之前是无条件 return true 的空壳，于是"点画面"这条路径
         在测试里根本没被执行过 —— 鼠标失灵的 bug 就是这么漏掉的。
         key 的拼法必须和 addEventListener 完全一致。 */
      dispatchEvent(ev){
        const type = ev && ev.type;
        const k = 'el:' + (this.id || this.tagName) + ':' + type;
        for (const fn of (listeners.get(k) || [])) fn(ev);
        /* 也支持 onclick/onmousedown 这类直接赋值的形式 */
        const h = this['on' + type];
        if (typeof h === 'function') h(ev);
        return true;
      },
      focus: noop, blur: noop, click: noop, select(){}, setSelectionRange(){},
      getBoundingClientRect(){ return { left: 0, top: 0, width: 1280, height: 720, right: 1280, bottom: 720 }; },
      /* 直接调同模块的 function 声明，不读任何自由变量。
       踩过的坑：跨 realm 的闭包里，自由标识符（ctxStub）和 globalThis.__ctx2d
       都不保证能解析到 sandbox 上挂的那个 —— 一个报 "is not defined"，
       另一个报 "is not a function"，而 mkEl/buildDOM 在模块初始化时就被调用，
       根本等不到 sandbox 构造完。makeCtxStub 是 function 声明、必然在闭包里。 */
    getContext(){ return makeCtxStub(); },
      toDataURL(){ return 'data:image/png;base64,'; },
      closest(){ return null; },
      querySelector(){ return null; },
      querySelectorAll(){ return []; },
      requestPointerLock: noop, releasePointerLock: noop
    };
  }

  /* index.html 里出现过的所有 id —— 缺一个就会在 getElementById 处静默变 null。
     这张表原来是纯手写的，注释还写着"加新 UI 时记得同步这里"。
     那就是个必然会发生的事故：桩和 markup 各维护一份，加个背包面板
     忘了同步，整轮测试立刻变成一串 "Cannot read properties of null"，
     而且报的错完全指不到真正的原因。
     现在直接从 index.html 里抠，再并上手工补的（少数元素是运行时才创建的）。 */
  const IDS = [
    'scene','redFlash','hpBar','tenseVignette','crosshair','hud','hudTimer','hudScore','hudProbs',
    'btnSettings','btnEnd','minimapWrap','minimap','prompt','toastStack','achNotify','start',
    'turnSliderStart','turnValueStart','smoothSliderStart','smoothValueStart',
    'timeSliderStart','timeValueStart','volSliderStart','volValueStart','shakeToggleStart',
    'pauseMenu','turnSlider','turnValue','smoothSlider','smoothValue','timeSlider','timeValue',
    'volSlider','volValue','muteToggle','shakeToggle','btnSave','btnClearSave','btnResume','btnPauseEnd',
    'codeUI','ideTime','problemList','problemPane','fileName','cursorInfo','codeHighlight','codeArea',
    'btnSubmit','btnReset','btnLeave','verdict','paperUI','btnClearPaper','btnClosePaper','paperCanvas',
    'corridorUI','corrVanish','corrDoor','corrDoorLabel','corrStep','corrBar','corrHint',
    'bathroomUI','bathSub','bathStepText','bathBar','bathHint','bathDots',
    'npcComputerUI','npcCompHead','npcCompTag','npcCompCode','btnCloseNPCComp',
    /* 电脑桌面 · 小恐龙（js/launcher.js） */
    'desktopUI','desktopList','dinoPane','dinoCanvas','dinoScore','dinoHigh',
    'dinoHint','btnCloseDesktop','btnDinoBack',
    'ending','endTitle','endSub','endScore','endStats','endDetail','endAch','btnRestart',
    'btnStart','btnClearSaveStart','bootErr'
  ];
  const markup = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  for (const m of markup.matchAll(/\bid="([^"]+)"/g)){
    if (!IDS.includes(m[1])) IDS.push(m[1]);
  }
  for (const id of IDS) byId.set(id, mkEl('div', id));

  const document = {
    getElementById: id => byId.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: tag => mkEl(tag),
    addEventListener(t, fn){
      const k = 'document:' + t;
      if (!listeners.has(k)) listeners.set(k, []);
      listeners.get(k).push(fn);
    },
    removeEventListener: noop,
    body: mkEl('body'),
    head: mkEl('head'),
    documentElement: mkEl('html'),
    activeElement: null,
    pointerLockElement: null,
    exitPointerLock: noop,
    hidden: false
  };

  const window = {
    addEventListener(t, fn){
      const k = 'window:' + t;
      if (!winListeners.has(k)) winListeners.set(k, []);
      winListeners.get(k).push(fn);
    },
    removeEventListener: noop,
    innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: noop,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    location: { reload: noop, href: 'http://127.0.0.1/', protocol: 'http:', hostname: '127.0.0.1' },
    AudioContext: class {
      constructor(){
        this.currentTime = 0; this.sampleRate = 44100;
        this.destination = {}; this.state = 'running';
      }
      createGain(){ return { gain: { value: 0, setValueAtTime: noop, exponentialRampToValueAtTime: noop, linearRampToValueAtTime: noop }, connect: noop, disconnect: noop }; }
      createOscillator(){ return { type: '', frequency: { value: 0, setValueAtTime: noop, exponentialRampToValueAtTime: noop }, connect: noop, start: noop, stop: noop }; }
      createBuffer(){ return { getChannelData: () => new Float32Array(256) }; }
      createBufferSource(){ return { buffer: null, connect: noop, start: noop, stop: noop }; }
      createBiquadFilter(){ return { type: '', frequency: { value: 0 }, Q: { value: 0 }, connect: noop }; }
      createStereoPanner(){ return { pan: { value: 0 }, connect: noop }; }
      resume(){}
    },
    performance: { now: () => Date.now() },
    localStorage: (() => {
      const m = new Map();
      return {
        getItem: k => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: k => m.delete(k),
        clear: () => m.clear(),
        key: i => [...m.keys()][i] || null,
        get length(){ return m.size; }
      };
    })()
  };

  return {
    byId, listeners, document, window,
    /* 派发 document 级事件。事件对象补齐了 preventDefault / stopPropagation，
       并且【默认带 isTrusted】—— launcher.js 的 dinoKey() 会检查它，
       没有这个字段小恐龙永远收不到按键。要测"合成事件被拒"时显式传 false。 */
    fireDoc(kind, ev){
      const arr = listeners.get('document:' + kind) || [];
      for (const fn of arr){
        fn(Object.assign({
          preventDefault: noop, stopPropagation: noop, isTrusted: true,
          code: '', key: '', button: 0, buttons: 0, clientX: 0, clientY: 0,
          deltaY: 0, target: document.body, repeat: false,
          getModifierState: () => false
        }, ev || {}));
      }
    },
    fireWin(kind, ev){
      const arr = winListeners.get('window:' + kind) || [];
      for (const fn of arr){
        fn(Object.assign({ preventDefault: noop, stopPropagation: noop, isTrusted: true }, ev || {}));
      }
    }
  };
}

/* ============================ 3. 沙箱 ============================ */
const dom = buildDOM();
const sandbox = {
  THREE: buildTHREE(),
  document: dom.document,
  window: dom.window,
  localStorage: dom.window.localStorage,
  performance: dom.window.performance,
  console,
  Math, JSON, Date, Object, Array, String, Number, Boolean, Set, Map, WeakMap,
  Promise, Symbol, Proxy, Reflect, Function,
  Uint8ClampedArray, Float32Array, Uint16Array, ArrayBuffer,
  isNaN, isFinite, parseInt, parseFloat, RegExp, Error, TypeError, RangeError,
  setTimeout: (fn) => { try { fn(); } catch(e){ throw e; } return 0; },
  clearTimeout: noop,
  /* setInterval 在真实浏览器里是"轮询评测进度"，测试里只需跑够次数让回调收尾：
     同步执行 20 次即可让 prog 越过 100 并触发最终结算 */
  setInterval: (fn) => { for (let i = 0; i < 20; i++){ try { fn(); } catch(e){ throw e; } } return 0; },
  clearInterval: noop,
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: noop,
  confirm: () => true,
  alert: noop,
  innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1,
  AudioContext: dom.window.AudioContext
};
sandbox.window.document = dom.document;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

/* 从 index.html 里按顺序抠出本地 <script src> */
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map(m => m[1].split('?')[0])                    /* 剥掉 ?v=N 缓存破除串 */
  .filter(s => !/^https?:/.test(s) && !s.startsWith('vendor/'));
/* 跳过 boot.js：它只负责加载 three 与调 init()，测试里我们手动调 init。
   也跳过 three.js 本身（在 vendor/），那是第三方代码，塞进 vm 只会白等。 */
const runnable = scripts.filter(s => !s.endsWith('boot.js'));

/* smoke.mjs 自己的源码，给下面的"桩覆盖度自检"用来抽 THREE 返回块 */
const smokeSrc = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');

let failures = 0;
const fails = [];
function check(label, fn){
  try {
    const r = fn();
    console.log('  PASS  ' + label + (r !== undefined && r !== null ? '  → ' + r : ''));
  } catch(e){
    failures++;
    fails.push(label);
    console.log('  FAIL  ' + label + '  → ' + (e && e.message));
    if (e && e.stack) console.log(String(e.stack).split('\n').slice(1, 4).join('\n'));
  }
}

/* ============================ 4. 加载 ============================ */
/* 先自检：桩是否覆盖了项目用到的每一个 THREE 类。
   这一条是补上来的 —— 之前桩缺 DirectionalLight / FogExp2 / Color.lerp /
   Vector3.setScalar / Mesh.clone / Object3D.rotateZ，
   每次都只报"某个函数不是函数"，而报错位置指向完全无关的业务代码，
   排查成本极高。这里一次性核对，缺什么直接列出来。 */
const stubKeys = (() => {
  const anchor = smokeSrc.indexOf('REVISION:');
  const block = smokeSrc.slice(smokeSrc.lastIndexOf('return {', anchor));
  return new Set([...block.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*[:,]/g)].map(m => m[1]));
})();
const usedTHREE = new Set();
/* 扫之前先剥掉注释：注释里出现的 THREE.Xxx（例如"这不是 THREE.Object3D"）
   会被误判成真实用法，然后逼你在桩里加一个根本没用到的类。 */
const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
for (const src of scripts){
  if (!src.startsWith('js/') && !src.startsWith('assets/')) continue;
  const t = stripComments(fs.readFileSync(path.join(ROOT, src), 'utf8'));
  for (const m of t.matchAll(/THREE\.([A-Z][A-Za-z0-9_]*)/g)) usedTHREE.add(m[1]);
}
const missingSym = [...usedTHREE].filter(s => !stubKeys.has(s)).sort();
check('THREE 桩覆盖了代码用到的全部 ' + usedTHREE.size + ' 个类', () => {
  if (missingSym.length){
    throw new Error('桩缺: ' + missingSym.join(', ') +
      '  —— 请在上面的 buildTHREE() 里补上，否则会抛 "is not a constructor"');
  }
  return usedTHREE.size + ' 个类全部有桩';
});

console.log('== 1. 加载全部脚本（' + runnable.length + ' 个） ==');
for (const src of runnable){
  const code = fs.readFileSync(path.join(ROOT, src), 'utf8');
  try {
    vm.runInContext(code, sandbox, { filename: src });
  } catch(e){
    failures++;
    fails.push('加载 ' + src);
    console.log('  FAIL  ' + src + '  → ' + (e && e.message));
  }
}
console.log('  加载完成，未捕获异常 ' + failures + ' 处');

/* ============================ 5. 初始化 ============================ */
console.log('\n== 2. 初始化 ==');
check('init() 不抛异常', () => { vm.runInContext('init()', sandbox); return '已初始化'; });

const S = sandbox.window.__OI__ ? sandbox.window.__OI__.state : null;
check('window.__OI__ 已挂载', () => {
  if (!S) throw new Error('未挂载');
  return 'state 可见';
});
check('抽到 4 道题', () => {
  if (!S || S.problems.length !== 4) throw new Error('题目数 ' + (S ? S.problems.length : '?'));
  return S.problems.map(p => p.id).join(', ');
});
check('玩家位置向量已赋值', () => {
  if (!S.pos) throw new Error('state.pos 为空');
  return '(' + S.pos.x + ', ' + S.pos.y + ', ' + S.pos.z + ')';
});
check('开局视图是 world', () => {
  const v = vm.runInContext('state.view', sandbox);
  if (v !== 'world') throw new Error('view = ' + v);
  return 'view = world';
});
check('开局落在校园，且出生点在可行走范围内', () => {
  /* 必须在任何 switchArea 之前检查：一旦切过区域，state.bounds 就变了。 */
  const area = vm.runInContext('state.area', sandbox);
  if (area !== 'campus') throw new Error('开局区域是 ' + area);
  const ok = vm.runInContext(
    'state.pos.z >= CP.z + CAMPUS_MIN_Z && state.pos.z <= CP.z + CAMPUS_MAX_Z && ' +
    'state.pos.x >= CP.x - CAMPUS_HALF_W && state.pos.x <= CP.x + CAMPUS_HALF_W && ' +
    'state.pos.z >= state.bounds.zMin && state.pos.z <= state.bounds.zMax && ' +
    'state.bounds === AREA_BOUNDS.campus', sandbox);
  const at = vm.runInContext('JSON.stringify([+state.pos.x.toFixed(1), +state.pos.z.toFixed(1)])', sandbox);
  if (!ok) throw new Error('出生点不在校园可行走范围内：' + at);
  return '出生 ' + at;
});

/* ============================ 6. 判题器 ============================ */
console.log('\n== 3. 判题器 ==');
check('空代码 → CE 0 分', () => {
  const r = vm.runInContext('judgeCode("", state.problems[0])', sandbox);
  if (r.status !== 'CE' || r.score !== 0) throw new Error(r.status + '/' + r.score);
  return r.status + '/' + r.score;
});
check('模板代码 → 有一定分数', () => {
  const r = vm.runInContext('judgeCode(state.problems[0].starter, state.problems[0])', sandbox);
  if (r.score <= 0) throw new Error('模板拿了 0 分，判题太苛刻');
  return r.score + ' 分 / ' + r.status;
});
check('同代码反复提交分数完全相同（确定性）', () => {
  const a = vm.runInContext('judgeCode(state.problems[1].starter + "// x", state.problems[1]).score', sandbox);
  const b = vm.runInContext('judgeCode(state.problems[1].starter + "// x", state.problems[1]).score', sandbox);
  if (a !== b) throw new Error('分数不一致 ' + a + ' vs ' + b);
  return a + ' === ' + b;
});
check('长且完整的代码拿满分', () => {
  const code = vm.runInContext('state.problems[2].starter', sandbox) +
    '\n// ' + Array.from({ length: 120 }, () =>
      'int ans = 0; long long sum = 0; vector<int> a; sort(a.begin(), a.end()); cout << ans << endl;').join('\n');
  const r = vm.runInContext('judgeCode(' + JSON.stringify(code) + ', state.problems[2])', sandbox);
  if (r.score < 80) throw new Error('认真写也只有 ' + r.score + ' 分');
  return r.score + ' 分 / ' + r.status;
});
check('屏蔽词能命中', () => {
  const w = vm.runInContext('containsBannedWord("// fuck")', sandbox);
  if (!w) throw new Error('没命中');
  return w;
});
check('总分 400（4 题 × 100）', () => {
  const sum = vm.runInContext('state.problems.reduce((a,p)=>a+p.max,0)', sandbox);
  if (sum !== 400) throw new Error('总分 ' + sum);
  return '总分 ' + sum;
});

/* ============================ 7. 校园段 ============================ */
console.log('\n== 4. 校园段（校门 → 传送圈 → 安检 → 404 教室） ==');
check('模拟点击"进入比赛"', () => {
  vm.runInContext('document.getElementById("btnStart").onclick()', sandbox);
  if (!vm.runInContext('state.started', sandbox)) throw new Error('state.started 仍为 false');
  return 'started = true';
});
check('设置下拉：保安刷新位置能切换并写盘', () => {
  const raw = vm.runInContext(`JSON.stringify((() => {
    const el = document.getElementById('guardSpawnSelStart');
    if (!el || typeof el.onchange !== 'function') return { bound: false };
    const before = guardSpawnMode;
    el.value = 'door';
    el.onchange();
    const after = guardSpawnMode;
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}').guardSpawn;
    guardSpawnMode = before;
    saveViewSettings();
    return { bound: true, before: before, after: after, saved: saved };
  })())`, sandbox);
  const r = JSON.parse(raw);
  if (!r.bound) throw new Error('开始界面的下拉没有绑定 onchange');
  if (r.after !== 'door') throw new Error('选「门前」后 guardSpawnMode 没变成 door：' + r.after);
  if (r.saved !== r.after) throw new Error('设置没写盘（存的是 ' + r.saved + '）');
  return 'before=' + r.before + ' → after=' + r.after + ' · 已写盘';
});
check('跑 300 帧主循环无异常', () => {
  vm.runInContext('for (let i = 0; i < 300; i++) animate();', sandbox);
  return 'elapsed = ' + vm.runInContext('state.elapsed.toFixed(1)', sandbox) + 's';
});
check('校园障碍表已装载（不是空的）', () => {
  const n = vm.runInContext('campusColliders.length', sandbox);
  if (n < 8) throw new Error('校园碰撞体只有 ' + n + ' 个，场景没建起来');
  return n + ' 个碰撞体';
});
check('墙上指引牌包含考场号与教室号', () => {
  const s = vm.runInContext('JSON.stringify(CAMPUS_SIGN_ROWS)', sandbox);
  const no = vm.runInContext('EXAM_ROOM_NO', sandbox);
  const rm = vm.runInContext('EXAM_CLASSROOM', sandbox);
  if (!s.includes(no) || !s.includes(rm)) throw new Error('指引牌缺 ' + no + ' / ' + rm);
  return '指引牌含 ' + no + ' / ' + rm;
});
check('志愿者台词包含楼号与教室号', () => {
  const v = vm.runInContext('JSON.stringify(VOLUNTEERS)', sandbox);
  const tag = vm.runInContext('EXAM_BUILDING_TAG', sandbox);
  const rm = vm.runInContext('EXAM_CLASSROOM', sandbox);
  if (!v.includes(rm) || !v.includes(tag)) throw new Error('台词里没有 ' + rm + ' 或 ' + tag);
  return '台词含 ' + rm + ' 与 ' + tag;
});
check('自动售货机：扣款、扣库存、加物品；买不起和售罄都不改状态', () => {
  const raw = vm.runInContext(`JSON.stringify((() => {
    dismissDialogs();
    const bag0 = bagSnapshot();
    const bal0 = state.cardBalance;
    const stock0 = JSON.parse(JSON.stringify(state.vendingStock));
    const out = {};
    try {
      out.targets = campusVendingTargets.length;
      out.goods = VENDING_GOODS.length;
      out.before = {
        bal: bal0,
        stock: state.vendingStock.water,
        water: bagCount('water')
      };

      openVendingMachine();
      const dlg = dialogs[dialogs.length - 1];
      out.dialog = !!dlg && dlg.options.length === VENDING_GOODS.length + 1;

      buyFromVending(dlg, 'water');
      out.after = {
        bal: state.cardBalance,
        stock: state.vendingStock.water,
        water: bagCount('water'),
        open: hasDialog()
      };

      /* 余额不足：正文换成解释，但钱和物品都不该动 */
      state.cardBalance = 0;
      const spicyBefore = bagCount('spicy');
      buyFromVending(dlg, 'spicy');
      out.poor = {
        bal: state.cardBalance,
        spicyBefore: spicyBefore,
        spicyAfter: bagCount('spicy')
      };

      /* 售罄：同理 */
      state.vendingStock.water = 0;
      const waterBefore = bagCount('water');
      buyFromVending(dlg, 'water');
      out.sold = { before: waterBefore, after: bagCount('water') };
    } finally {
      dismissDialogs();
      bagRestore(bag0);
      state.cardBalance = bal0;
      state.vendingStock = stock0;
    }
    return out;
  })())`, sandbox);
  const r = JSON.parse(raw);
  if (r.targets < 1) throw new Error('售货机没有可交互面');
  if (r.goods !== 3) throw new Error('商品数 ' + r.goods);
  if (!r.dialog) throw new Error('购买弹窗没生成，或选项数不对');
  if (r.after.bal !== r.before.bal - 2)
    throw new Error('买水后余额 ' + r.after.bal + '，应为 ' + (r.before.bal - 2));
  if (r.after.stock !== r.before.stock - 1)
    throw new Error('买水后库存 ' + r.after.stock);
  if (r.after.water !== r.before.water + 1)
    throw new Error('买水后背包 ' + r.after.water);
  if (!r.after.open) throw new Error('买完弹窗被关掉了，不能连着买');
  if (r.poor.bal !== 0 || r.poor.spicyAfter !== r.poor.spicyBefore)
    throw new Error('余额不足时仍然成交了');
  if (r.sold.after !== r.sold.before)
    throw new Error('售罄时仍然给了一瓶');
  return '余额 ' + r.before.bal + ' → ' + r.after.bal +
         ' · 水 ' + r.before.water + ' → ' + r.after.water +
         ' · 余额不足/售罄均未成交';
});
check('成就「跑路了兄弟」：跑到校园最外沿就触发，人被拎回校门口', () => {
  const raw = vm.runInContext(`
    JSON.stringify((() => {
      const meta = ACHIEVEMENTS['runaway'];
      state.area = 'campus'; state.bounds = AREA_BOUNDS.campus;
      state.achievements.delete('runaway');
      state.pos.x = CAMPUS_SPAWN.x;
      state.pos.z = CP.z + CAMPUS_SPAWN.z;

      /* ① 出生点站着不该触发 —— 离最外墙还有 3.7m，得自己走过去 */
      updateCampusArea(1/60, 0);
      const atSpawn = state.achievements.has('runaway');

      /* ② 走进校园当然也不该触发 */
      state.pos.z = CP.z - 6;
      updateCampusArea(1/60, 0);
      const inside = state.achievements.has('runaway');

      /* ③ 站在门口也不算到头 */
      state.pos.z = CP.z + CAMPUS_GATE_Z;
      updateCampusArea(1/60, 0);
      const atGate = state.achievements.has('runaway');

      /* ④ 跑到最外墙：触发，并且人被挪回校门口（x / 朝向 都要复位） */
      state.pos.z = AREA_BOUNDS.campus.zMax;
      state.pos.x = CP.x - 3.3;
      state.yaw = 2.2;
      updateCampusArea(1/60, 0);
      const fired = state.achievements.has('runaway');
      const backZ = state.pos.z - CP.z;
      const backX = state.pos.x - CP.x;

      return { meta: meta ? (meta.name + '|' + meta.desc) : '',
               atSpawn: atSpawn, inside: inside, atGate: atGate, fired: fired,
               backZ: backZ, backX: backX, yaw: state.yaw,
               standZ: CAMPUS_GATE_STAND.z, standX: CAMPUS_GATE_STAND.x,
               standYaw: CAMPUS_GATE_STAND.yaw };
    })())
  `, sandbox);
  const r = JSON.parse(raw);
  if (!r.meta.startsWith('跑路了兄弟|')) throw new Error('成就没登记或名字不对：' + r.meta);
  if (!r.meta.includes('记得回来')) throw new Error('描述里缺"出发之后记得回来"：' + r.meta);
  if (r.atSpawn) throw new Error('出生点站着就白送了成就');
  if (r.inside) throw new Error('在校园里走着走着就给了成就');
  if (r.atGate) throw new Error('站门口就给了成就，应该跑到最外沿才算');
  if (!r.fired) throw new Error('跑到最外墙却没解锁成就');
  if (Math.abs(r.backZ - r.standZ) > 1e-6)
    throw new Error('触发后没被挪回校门口：z=' + r.backZ + '，应为 ' + r.standZ);
  if (Math.abs(r.backX - r.standX) > 1e-6)
    throw new Error('触发后 x 没拉回门口：x=' + r.backX + '，应为 ' + r.standX);
  if (r.yaw !== r.standYaw) throw new Error('拎回来之后朝向没重置：yaw=' + r.yaw);
  return '出生点/校园内/门口=否 · 到头=是 → 拎回 z=' + r.backZ.toFixed(1) +
         ' x=' + r.backX.toFixed(1) + ' → ' + r.meta;
});
check('员工通道：没过安检也能进楼，手机跟着进去', () => {
  const raw = vm.runInContext(`
    JSON.stringify((() => {
      dismissDialogs();
      state.area = 'campus'; state.bounds = AREA_BOUNDS.campus;
      state.enteredRoom = false; state.sneakedIn = false;
      state.passedSecurity = false; state.hasPhone = true;
      state.achievements.delete('sideentry');

      /* 门必须登记在交互表里，且 kind 是 sidedoor —— 否则 E 键永远走不到它 */
      const rec = campusAuditTargets.find(a => a && a.kind === 'sidedoor');
      const meta = ACHIEVEMENTS['sideentry'];

      enterSideDoor();
      const opened = dialogs.length;
      const title = dialogs.length ? String(dialogs[dialogs.length - 1].title || '') : '';
      const opts = dialogs.length ? dialogs[dialogs.length - 1].options.length : 0;
      selectDialogOption(0);                       /* 「推门进去」 */

      const out = { registered: !!rec, label: rec ? rec.label : '',
                    meta: meta ? (meta.name + '|' + meta.desc) : '',
                    opened: opened, title: title, opts: opts,
                    area: state.area, entered: state.enteredRoom,
                    sneaked: state.sneakedIn, passed: state.passedSecurity,
                    phone: state.hasPhone,
                    ach: state.achievements.has('sideentry'),
                    left: dialogs.length };
      switchArea('campus');                        /* 还原，后面还有校园段的检查 */
      state.enteredRoom = false; state.passedSecurity = false;
      state.pos.x = CP.x + CAMPUS_SPAWN.x;
      state.pos.z = CP.z + CAMPUS_SPAWN.z;
      state.yaw = 0; yawTarget = 0; state.pitch = 0; pitchTarget = 0;
      return out;
    })())
  `, sandbox);
  const r = JSON.parse(raw);
  if (!r.registered) throw new Error('员工通道没登记进 campusAuditTargets');
  if (r.label !== '员工通道') throw new Error('门牌的 label 不对：' + r.label);
  if (!r.meta.startsWith('不正规入场|')) throw new Error('成就没登记或名字不对：' + r.meta);
  if (r.opened !== 1) throw new Error('按 E 没弹出员工通道窗口');
  /* 标题是宽字距排版的（"员 工 通 道"），比较前把空白去掉 */
  if (r.title.replace(/\s/g, '').indexOf('员工通道') < 0)
    throw new Error('弹窗标题不对：' + r.title);
  if (r.opts !== 2) throw new Error('选项数应为 2，实际 ' + r.opts);
  if (r.left !== 0) throw new Error('选完选项弹窗没关（输入会被吞掉）');
  if (r.area !== 'room') throw new Error('没能进楼，区域还是 ' + r.area);
  if (!r.entered || !r.sneaked) throw new Error('进楼了却没记 enteredRoom/sneakedIn');
  if (r.passed) throw new Error('走侧门不该把安检标记成已过');
  if (!r.phone) throw new Error('走侧门进来手机却没了 —— 这条路就没意义了');
  if (!r.ach) throw new Error('进了楼却没解锁「不正规入场」');
  return '门已登记 · 弹窗关净 · 进楼=room · 安检=false · 手机还在 · ' + r.meta;
});
check('手机：过安检封存，带进来的能看战况，被抓到就收走', () => {
  const raw = vm.runInContext(`
    JSON.stringify((() => {
      dismissDialogs();
      const fmt = phoneClock(3725);                /* 1:02:05 */

      /* ① 过安检 → 封存 */
      state.area = 'campus'; state.bounds = AREA_BOUNDS.campus;
      state.passedSecurity = false; state.hasPhone = true;
      doSecurityCheck();
      selectDialogOption(0);

      /* ①b 退路「先不过了」必须什么都不改。
         这就是玩家报的 bug：老版本两个选项都收手机、都算过了安检，
         于是"没过安检"的人兜里也没手机，而且没人告诉他哪一步丢的。 */
      state.passedSecurity = false; state.hasPhone = true;
      doSecurityCheck();
      const outOpts = dialogs.length ? dialogs[dialogs.length - 1].options.length : 0;
      selectDialogOption(1);
      const outPhone = state.hasPhone, outPassed = state.passedSecurity;
      const outLeft = dialogs.length;

      /* ② 没手机就掏不出来 —— 先回到"已被封存"的状态 */
      state.passedSecurity = true; state.hasPhone = false;

      /* ② 没手机就掏不出来 */
      state.area = 'room'; state.view = 'world';
      const canNo = canOpenPhone();
      togglePhone();
      const viewNo = state.view;

      /* ③ 手机还在时：能不能掏，只看区域/结束/冻结 */
      state.hasPhone = true;
      const canYes = canOpenPhone();
      state.ended = true;  const canEnded = canOpenPhone();  state.ended = false;
      state.frozen = true; const canFrozen = canOpenPhone(); state.frozen = false;
      state.area = 'campus'; const canCampus = canOpenPhone(); state.area = 'room';

      /* ④ 没收：返回"本来有没有"，之后 hasPhone 为假 */
      const had = confiscatePhone();
      const after = state.hasPhone;
      state.hasPhone = true;
      /* 还原区域：下面几条都是校园段，area 留在 room 会让 campusInteract
         在第一条判断处就 return false，后面全红（第一版就是这么翻的车）。 */
      state.area = 'campus'; state.bounds = AREA_BOUNDS.campus;

      const a1 = ACHIEVEMENTS['phone'], a2 = ACHIEVEMENTS['phone_caught'];
      return { fmt: fmt,
               afterAudit: state.hasPhone === false ? false : true,
               outOpts: outOpts, outPhone: outPhone, outPassed: outPassed, outLeft: outLeft,
               canNo: canNo, viewNo: viewNo, canYes: canYes,
               canEnded: canEnded, canFrozen: canFrozen, canCampus: canCampus,
               had: had, after: after,
               meta1: a1 ? a1.name : '', meta2: a2 ? a2.name : '' };
    })())
  `, sandbox);
  const r = JSON.parse(raw);
  if (r.fmt !== '1:02:05') throw new Error('手机时钟格式不对：' + r.fmt);
  if (r.canNo) throw new Error('手机被封存了还判成"能掏出来"');
  if (r.viewNo !== 'world') throw new Error('没手机也把手机面板打开了');
  if (!r.canYes) throw new Error('人在考场、手机还在，却判成掏不出来');
  if (r.canEnded) throw new Error('比赛结束后还能掏手机');
  if (r.canFrozen) throw new Error('被冻住（过场/结算）时还能掏手机');
  if (r.canCampus) throw new Error('在校园里就能掏手机看战况');
  if (!r.had) throw new Error('没收时没返回"本来有手机"');
  if (r.after) throw new Error('没收之后 hasPhone 还是真');
  if (r.meta1 !== '夹带' || r.meta2 !== '人赃并获')
    throw new Error('手机相关成就没登记：' + r.meta1 + '/' + r.meta2);
  if (r.outOpts !== 2) throw new Error('安检弹窗应有 2 个选项（进 / 不进），实际 ' + r.outOpts);
  if (r.outLeft !== 0) throw new Error('示意"不过了"之后弹窗没关');
  if (!r.outPhone)
    throw new Error('选了「先不过了」，手机却被收走了 —— 玩家报的就是这个');
  if (r.outPassed)
    throw new Error('选了「先不过了」，却被记成"已过安检"');
  return '时钟 ' + r.fmt + ' · 封存后掏不出来 · 四种不该开的情况都拦住了 · 没收生效';
});
check('手机是真物品：开局在背包里，安检从背包拿走；2048 的合并是真逻辑', () => {
  const raw = vm.runInContext(`JSON.stringify((() => {
    dismissDialogs();
    /* ① 开局：背包里有，快捷栏里没有（快捷栏要留着空格） */
    state.area = 'room'; state.bounds = AREA_BOUNDS.room;
    state.view = 'world'; state.ended = false; state.frozen = false;
    initBag();
    const bagHas = bagCount('phone');
    const barHas = state.hotbar.indexOf('phone');

    /* ② 过安检：背包里真的没了 —— 连玩家手动指派到快捷栏的那一格也要摘掉 */
    state.area = 'campus'; state.bounds = AREA_BOUNDS.campus;
    state.passedSecurity = false; state.hasPhone = true;
    state.hotbar[3] = 'phone';
    doSecurityCheck(); selectDialogOption(0);
    const bagAfter = bagCount('phone');
    const barAfter = state.hotbar.indexOf('phone');
    const flagAfter = state.hasPhone;

    /* ③ 2048：滑行合并、方向映射、无变化时不挪 */
    const s1 = g2048Slide([2, 2, 2, 2]).out.join(',');
    const s2 = g2048Slide([2, 2, 4, 0]).out.join(',');
    const s3 = g2048Slide([4, 4, 8, 8]).out.join(',');
    const mv = g2048Move([2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 'left');
    const noMv = g2048Move([2, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 'left').moved;
    const col = [2, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const upTop = g2048Move(col, 'up').cells.slice(0, 4).join(',');
    const dnBot = g2048Move(col, 'down').cells.slice(12, 16).join(',');

    /* ④ 合出 2048 → 成就 */
    state.achievements.delete('phone2048');
    state.g2048 = { cells: [1024, 1024, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
                    score: 0, won: false, dead: false };
    g2048Step('left');
    const got = state.achievements.has('phone2048');
    const wonScore = state.g2048.score;

    /* ⑤ keep：从快捷栏用一次手机，背包里不会少一台（消耗规则走真实路径） */
    initBag();
    state.area = 'room'; state.bounds = AREA_BOUNDS.room;   /* ② 把它改成了 campus */
    state.hotbar[3] = 'phone'; state.hotbarIdx = 3;
    const beforeUse = bagCount('phone');
    const useOk = useSelectedItem();
    const afterUse = bagCount('phone');
    if (state.view === 'phone') closePhone();
    const keepFlag = ITEMS.phone.keep === true;

    initBag();                       /* 还原 */
    state.hasPhone = true;
    return { bagHas: bagHas, barHas: barHas,
             beforeUse: beforeUse, useOk: useOk, afterUse: afterUse, keepFlag: keepFlag,
             bagAfter: bagAfter, barAfter: barAfter, flagAfter: flagAfter,
             s1: s1, s2: s2, s3: s3, mv: mv.gained + '|' + mv.cells.slice(0, 4).join(','),
             noMv: noMv, upTop: upTop, dnBot: dnBot, got: got, wonScore: wonScore,
             meta: ACHIEVEMENTS['phone2048'] ? ACHIEVEMENTS['phone2048'].name : '' };
  })())`, sandbox);
  const r = JSON.parse(raw);
  if (r.bagHas !== 1) throw new Error('开局背包里没有手机（实际 ' + r.bagHas + ' 台）');
  if (r.barHas >= 0) throw new Error('手机默认占了快捷栏第 ' + r.barHas + ' 格 —— 会挤掉"永远空一格"');
  if (r.bagAfter !== 0) throw new Error('过了安检，背包里还留着手机');
  if (r.barAfter >= 0) throw new Error('过了安检，快捷栏里那个手机格子没摘掉');
  if (r.flagAfter) throw new Error('过了安检 hasPhone 还是真');
  if (r.s1 !== '4,4,0,0') throw new Error('[2,2,2,2] 左移应为 4,4,0,0，实际 ' + r.s1);
  if (r.s2 !== '4,4,0,0') throw new Error('[2,2,4,0] 左移应为 4,4,0,0，实际 ' + r.s2);
  if (r.s3 !== '8,16,0,0') throw new Error('[4,4,8,8] 左移应为 8,16,0,0，实际 ' + r.s3);
  if (r.mv !== '4|4,0,0,0') throw new Error('[2,2] 左移应得 4 分且并成 4，实际 ' + r.mv);
  if (r.noMv) throw new Error('已经贴着左边还算"动过" —— 会白刷一个方块');
  if (r.upTop !== '4,0,0,0') throw new Error('上移方向映射错了：' + r.upTop);
  if (r.dnBot !== '4,0,0,0') throw new Error('下移方向映射错了：' + r.dnBot);
  if (!r.got) throw new Error('合出 2048 却没解锁「2048」');
  if (r.wonScore !== 2048) throw new Error('合出 2048 得分应为 2048，实际 ' + r.wonScore);
  if (r.meta !== '2048') throw new Error('2048 成就没登记：' + r.meta);
  if (!r.keepFlag) throw new Error('手机没标 keep —— 用一次就会从背包里消失');
  if (!r.useOk) throw new Error('从快捷栏用手机失败了（Q 应该能打开）');
  if (r.beforeUse !== r.afterUse)
    throw new Error('用了手机之后背包里从 ' + r.beforeUse + ' 台变成了 ' + r.afterUse + ' 台');
  return '背包里有手机 · 快捷栏没占位 · 安检真的拿走 · 合并/方向/不白动 全对 · ' + r.meta;
});
check('武器：加长拳锋、放宽扇形、抡断就散架', () => {
  const raw = vm.runInContext(`JSON.stringify((() => {
    dismissDialogs();
    state.area = 'room'; state.bounds = AREA_BOUNDS.room;
    state.view = 'world'; state.ended = false; state.frozen = false;
    initBag();
    state.pos.x = 0; state.pos.z = 0; state.yaw = 0; yawTarget = 0;

    /* ① 空手基准 */
    const bare = { reach: punchReach(), arc: punchArc(), w: heldWeaponId() };

    /* ② 捡到武器 = 直接上手；而且**不许占快捷栏**（快捷栏留给消耗品） */
    bagAdd('broom', 1);
    const autoPlaced = state.hotbar.indexOf('broom');
    const autoEquipped = state.weapon;

    /* ③ 上手之后，拳锋和扇形都该变 */
    const armed = { reach: punchReach(), arc: punchArc(), w: heldWeaponId() };

    /* ④ 真的用一套判定去够 3.0m 外的保安：空手够不着，扫把够得着。
       用 guardsInPunchRange 而不是 punchGuardsArc —— 后者会去爆散/发通报，
       而这里要验的只是"够不够得到"。 */
    const fake = { userData: { alive: true }, group: { position: { x: 0, z: -3.0 } } };
    const keepGuards = securityGuards.slice();
    securityGuards.length = 0; securityGuards.push(fake);
    const broomHits = guardsInPunchRange(punchReach() + 0.3, punchArc()).length;
    equipWeapon('');                       /* 收起武器 = 空手 */
    const bareAfterStow = heldWeaponId();
    const bareHits = guardsInPunchRange(punchReach() + 0.3, punchArc()).length;
    securityGuards.length = 0; keepGuards.forEach(g => securityGuards.push(g));

    /* ⑤ 扇形：偏轴 40° 的点，空手打不到，板凳（0.75）打得到 */
    const offArc = { x: Math.sin(Math.PI / 4.5), z: -Math.cos(Math.PI / 4.5) };
    const fistArcHit = inAttackArc(offArc.x, offArc.z, PUNCH_ARC);
    const stoolArcHit = inAttackArc(offArc.x, offArc.z, ITEMS.stool.arc);

    /* ⑥ 耐久：抡满 uses 下就散架，背包里没了，手上也回到空手 */
    equipWeapon('broom');
    const uses = ITEMS.broom.uses;
    for (let i = 0; i < uses; i++) wearWeapon('broom');
    const brokeLeft = bagCount('broom');
    const wearKeyGone = state.weaponWear.broom === undefined;
    const handAfterBreak = state.weapon;

    initBag();                      /* 还原 */
    state.hotbarIdx = 0;
    return { bare: bare, autoPlaced: autoPlaced, autoEquipped: autoEquipped,
             bareAfterStow: bareAfterStow, handAfterBreak: handAfterBreak,
             armed: armed, broomHits: broomHits, bareHits: bareHits,
             fistArcHit: fistArcHit, stoolArcHit: stoolArcHit,
             uses: uses, brokeLeft: brokeLeft, wearKeyGone: wearKeyGone,
             base: GUARD_PUNCH_RANGE,
             /* 数 melee：臭水的 kind 也是 '武器'（投掷类），按 kind 数会数成 4 */
             kinds: Object.keys(ITEMS).filter(id => ITEMS[id].melee).length };
  })())`, sandbox);
  const r = JSON.parse(raw);
  if (r.bare.w !== '') throw new Error('空手却认成了武器：' + r.bare.w);
  if (Math.abs(r.bare.reach - r.base) > 1e-9)
    throw new Error('空手拳锋应等于 GUARD_PUNCH_RANGE，实际 ' + r.bare.reach);
  if (r.kinds !== 3) throw new Error('武器应有 3 把，实际 ' + r.kinds);
  if (r.autoPlaced >= 0)
    throw new Error('武器自动占了快捷栏第 ' + r.autoPlaced + ' 格 —— 会挤掉摆好的补给');
  if (r.autoEquipped !== 'broom')
    throw new Error('捡到武器没直接上手（state.weapon = ' + r.autoEquipped + '）—— 还得手动装备就又变成"来回切换"了');
  if (r.armed.w !== 'broom') throw new Error('装了扫把却没认出来：' + r.armed.w);
  if (!(r.armed.reach > r.bare.reach))
    throw new Error('扫把没加长拳锋：' + r.bare.reach + ' → ' + r.armed.reach);
  if (!(r.armed.arc > r.bare.arc))
    throw new Error('扫把没放宽扇形：' + r.bare.arc + ' → ' + r.armed.arc);
  if (r.bareAfterStow !== '') throw new Error('收起武器之后手上还挂着 ' + r.bareAfterStow);
  if (r.bareHits !== 0) throw new Error('空手够到了 3.0m 外的保安 —— 拳锋变长了');
  if (r.broomHits !== 1) throw new Error('扫把够不到 3.0m 外的保安（命中 ' + r.broomHits + '）');
  if (r.fistArcHit) throw new Error('空手的扇形宽到能打偏轴 40° 的目标');
  if (!r.stoolArcHit) throw new Error('板凳的宽扇形打不到偏轴 40° 的目标');
  if (r.brokeLeft !== 0) throw new Error('抡了 ' + r.uses + ' 下扫把还在背包里');
  if (!r.wearKeyGone) throw new Error('扫把散架了，耐久记录还留着');
  if (r.handAfterBreak !== '')
    throw new Error('扫把散架了，手上还攥着 ' + r.handAfterBreak);
  return '空手 ' + r.bare.reach.toFixed(1) + 'm/' + r.bare.arc.toFixed(2) +
         ' → 扫把 ' + r.armed.reach.toFixed(1) + 'm/' + r.armed.arc.toFixed(2) +
         ' · 3.0m 外空手=0 扫把=1 · 板凳宽扇形生效 · ' + r.uses + ' 下散架';
});
check('击退：没被打倒的会被推开 + 踉跄，武器比空手推得远', () => {
  const raw = vm.runInContext(`JSON.stringify((() => {
    state.area = 'room'; state.bounds = AREA_BOUNDS.room;
    state.pos.x = 0; state.pos.z = 0; state.yaw = 0;
    state.worldTime = 100;

    /* 一个站在 2m 外的保安：推一下应当离得更远，并带上踉跄。
       起点放在 +X 方向的开阔处（(0,-2) 背后正好是玩家课桌，推过去会被桌角挡住 ——
       那其实是"保安不该被推进桌子里"的正确行为，不该拿它当击退测试）。 */
    const g = { userData: { alive: true }, group: { position: { x: 2, z: 0 } } };
    const before = Math.hypot(g.group.position.x, g.group.position.z);
    const moved = pushGuard(g, 1.6);
    const after = Math.hypot(g.group.position.x, g.group.position.z);
    const stagger = g.userData.staggerUntil;

    /* 撞墙时不该把人推进桌子里 */
    const w = { userData: { alive: true }, group: { position: { x: 9, z: 9 } } };
    pushGuard(w, 2);

    const knocks = ['broom', 'mop', 'stool'].map(id => ITEMS[id].knock);
    const powers = ['broom', 'mop', 'stool'].map(id => ITEMS[id].power);
    return { before: before, after: after, moved: moved, stagger: stagger,
             now: state.worldTime,
             knocks: knocks, powers: powers,
             fistKnock: 0.35 };
  })())`, sandbox);
  const r = JSON.parse(raw);
  if (!r.moved) throw new Error('推了一下，保安没动');
  if (!(r.after > r.before + 0.5))
    throw new Error('没被推开：' + r.before + ' → ' + r.after);
  if (!(r.stagger > r.now)) throw new Error('推开了却没踉跄（staggerUntil 没设）');
  if (r.knocks.some(k => !(k > r.fistKnock)))
    throw new Error('有武器的击退距离还不如空手：' + r.knocks.join('/') + ' vs ' + r.fistKnock);
  if (r.powers.some(p => !(p > 3.9)))
    throw new Error('武器的碎块速度没比空手大（3.9）：' + r.powers.join('/'));
  return '推开 ' + r.before.toFixed(1) + 'm → ' + r.after.toFixed(1) +
         'm · 踉跄到 ' + r.stagger + ' · 击退 ' + r.knocks.join('/') +
         '（空手 ' + r.fistKnock + '）· 碎块 ' + r.powers.join('/');
});
check('别人的显示器画的是他自己的题，不是我的', () => {
  const raw = vm.runInContext(`JSON.stringify((() => {
    /* 拿一个只记录文字的假 ctx 去跑真正的 drawDeskScreen */
    const rec = () => {
      const out = [];
      return { out: out, fillRect(){}, fillText(t){ out.push(String(t)); },
               set fillStyle(v){}, set font(v){} };
    };
    const mine = rec();  drawDeskScreen(mine, 640, 384, '');
    const his  = rec();  drawDeskScreen(his, 640, 384, '小明');
    return {
      owners: deskScreens.map(s => s.owner),
      mineHead: mine.out[0], hisHead: his.out[0],
      same: mine.out.join('|') === his.out.join('|'),
      myProb: state.curProb
    };
  })())`, sandbox);
  const r = JSON.parse(raw);
  if (r.owners.length !== 6)
    throw new Error('应有 6 块屏（你的 + 5 台），实际 ' + r.owners.length);
  if (r.owners.filter(o => o === '').length !== 1)
    throw new Error('只有你自己那块应该是空 owner：' + JSON.stringify(r.owners));
  if (r.hisHead.indexOf('小明') < 0)
    throw new Error('他的屏幕标题里没有他的名字：' + r.hisHead);
  if (r.mineHead.indexOf('小明') >= 0)
    throw new Error('你自己的屏幕反而写了他的名字：' + r.mineHead);
  if (r.same) throw new Error('两个人的屏幕画出来一模一样 —— 又变成照镜子了');
  return '6 块屏各归其主 · 他的标题含名字 · 两块内容不同';
});
check('滚轮切快捷栏；数字键只认弹窗，不再顺手改快捷栏', () => {
  const raw = vm.runInContext(`JSON.stringify((() => {
    dismissDialogs();
    state.view = 'world'; state.ended = false; state.frozen = false;
    initBag();
    selectHotbar(0);
    const n = HOTBAR_SLOTS;

    const a = cycleHotbar(1);                 /* 0 → 1 */
    const b = cycleHotbar(1);                 /* 1 → 2 */
    selectHotbar(n - 1);
    const wrapFwd = cycleHotbar(1);           /* 末格 → 0 */
    const wrapBack = cycleHotbar(-1);         /* 0 → 末格 */
    selectHotbar(0);
    const back = cycleHotbar(-1);             /* 0 → 末格（反向绕回） */
    selectHotbar(0);
    return { n: n, a: a, b: b, wrapFwd: wrapFwd, wrapBack: wrapBack, back: back };
  })())`, sandbox);
  const r = JSON.parse(raw);
  if (r.a !== 1 || r.b !== 2) throw new Error('滚轮没有逐格前进：' + r.a + ',' + r.b);
  if (r.wrapFwd !== 0) throw new Error('末格再滚没有绕回第 1 格：' + r.wrapFwd);
  if (r.wrapBack !== r.n - 1) throw new Error('第 1 格往回滚没有绕到末格：' + r.wrapBack);
  if (r.back !== r.n - 1) throw new Error('反向滚错了：' + r.back);

  /* 数字键：从外面派发真实 DOM 事件（沙箱里的 document 没有 dispatchEvent） */
  vm.runInContext(`dismissDialogs(); state.view='world'; state.ended=false;
                   state.frozen=false; selectHotbar(0);`, sandbox);
  dom.fireDoc('keydown', { code: 'Digit3', key: '3', isTrusted: true });
  const afterDigit = vm.runInContext('state.hotbarIdx', sandbox);
  if (afterDigit !== 0)
    throw new Error('数字键还在改快捷栏（hotbarIdx = ' + afterDigit +
                    '）—— 会和弹窗的"按 2 选第二项"撞键');

  /* 有弹窗时数字键仍然是"选第 n 项"。
     不能断言"弹窗关了" —— openDialog 造出来的弹窗没有 3D 按钮，
     selectDialogOption 本来就点不到东西。这里钉的是**路由**：
     数字键必须走到 selectDialogOption(下标)。 */
  vm.runInContext(`dismissDialogs(); state.view='world'; selectHotbar(0);
    window.__selSpy = [];
    window.__selOrig = selectDialogOption;
    selectDialogOption = function(i){ window.__selSpy.push(i); };
    openDialog({ title: 'T', options: [
      { label: '甲', action(){} }, { label: '乙', action(){} } ] });`, sandbox);
  dom.fireDoc('keydown', { code: 'Digit2', key: '2', isTrusted: true });
  const spy = JSON.parse(vm.runInContext('JSON.stringify(window.__selSpy)', sandbox));
  vm.runInContext(`selectDialogOption = window.__selOrig;
                   dismissDialogs(); selectHotbar(0);`, sandbox);
  if (spy.length !== 1 || spy[0] !== 1)
    throw new Error('数字键没走到弹窗选项（收到 ' + JSON.stringify(spy) + '，应为 [1]）');

  return '滚轮 0→1→2，' + r.n + ' 格首尾绕回 · 数字键只给弹窗用';
});
check('同学桌上的电脑：给的是"看他的电脑"，不是你的桌面', () => {
  const raw = vm.runInContext(`JSON.stringify((() => {
    dismissDialogs();
    state.view = 'world'; state.area = 'room'; state.bounds = AREA_BOUNDS.room;
    state.ended = false; state.frozen = false;

    const faces = interactables.filter(o => o.userData && o.userData.interact &&
                                            /电脑|桌面/.test(o.userData.interact.label));
    const mine = faces.filter(o => o.userData.interact.label.indexOf('CSP-S114514') >= 0);
    const theirs = faces.filter(o => o.userData.interact.label.indexOf('看一眼') >= 0);

    /* 坐着的时候动不了他的电脑：应当没有面板打开 */
    const saved = npcs.map(n => n.userData.state);
    npcs.forEach(n => { n.userData.state = 'seated'; });
    const t0 = theirs.length ? theirs[0] : null;
    const label = t0 ? t0.userData.interact.label : '';
    if (t0) t0.userData.interact.action();
    const viewSeated = state.view;
    const headSeated = String(document.getElementById('npcCompHead').textContent || '');

    /* 人走了就能看，而且看到的是他自己 */
    npcs.forEach(n => { n.userData.state = 'away'; });
    if (t0) t0.userData.interact.action();
    const viewAway = state.view;
    const headAway = String(document.getElementById('npcCompHead').textContent || '');
    closeNPCComputer();
    npcs.forEach((n, i) => { n.userData.state = saved[i]; });

    return { mine: mine.length, theirs: theirs.length, label: label,
             viewSeated: viewSeated, viewAway: viewAway,
             headSeated: headSeated, headAway: headAway };
  })())`, sandbox);
  const r = JSON.parse(raw);
  if (r.mine !== 1) throw new Error('应当只有你自己的电脑能开桌面，实际 ' + r.mine + ' 台');
  if (r.theirs !== 5) throw new Error('五台同学的电脑没各自的入口，实际 ' + r.theirs + ' 台');
  if (r.label.indexOf('看一眼') !== 0) throw new Error('标签不对：' + r.label);
  if (r.viewSeated !== 'world')
    throw new Error('人还坐着就把他的电脑打开成了 ' + r.viewSeated);
  if (r.viewAway !== 'npcComputer')
    throw new Error('人走了却打不开他的电脑：' + r.viewAway);
  if (r.headAway.indexOf('的电脑') < 0)
    throw new Error('打开的面板标题不是他的电脑：' + r.headAway);
  return '1 台自己的桌面 + 5 台"看一眼他的电脑" · 坐着拒绝 / 走了才给看（' + r.headAway + '）';
});
check('群聊置顶一句：Cherry_Pop 问「又在摸鱼呢？」', () => {
  const raw = vm.runInContext(`JSON.stringify((() => {
    const saved = state.elapsed;
    state.elapsed = 600;
    const lines = phoneChatLines();
    const first = lines[0] || {};
    const body = lines.slice(1);
    phoneRenderChat();
    const html = String(phChatLog.innerHTML || '');
    state.elapsed = saved;
    return {
      who: first.who, text: first.text, pinned: !!first.pinned,
      count: lines.length,
      /* 置顶那句不能又出现在时间轴里：那会和"最近 9 条"抢位置 */
      dupInBody: body.filter(l => l.who === 'Cherry_Pop').length,
      bodySorted: body.every((l, i) => i === 0 || body[i - 1].t <= l.t),
      htmlStartsWithPin: html.indexOf('<div class="pn-msg pin">') === 0,
      /* 置顶那条没有时间戳：先出现名字、再出现别的消息的 pn-when */
      noClockOnPin: html.indexOf('Cherry_Pop') < html.indexOf('pn-when'),
      inHtml: html.indexOf('又在摸鱼呢？') >= 0
    };
  })())`, sandbox);
  const r = JSON.parse(raw);
  if (r.who !== 'Cherry_Pop') throw new Error('置顶那条不是 Cherry_Pop：' + r.who);
  if (r.text !== '又在摸鱼呢？') throw new Error('台词不对：' + r.text);
  if (!r.pinned) throw new Error('置顶那条没打 pinned 标记');
  if (r.dupInBody !== 0) throw new Error('置顶那句又混进时间轴了（' + r.dupInBody + ' 条）');
  if (r.count > 10) throw new Error('群聊条数失控：' + r.count);
  if (!r.bodySorted) throw new Error('去掉置顶那句之后时间序乱了');
  if (!r.htmlStartsWithPin) throw new Error('渲染出来置顶那条不在最前面');
  if (!r.noClockOnPin) throw new Error('置顶那条带了时间戳（会比下面的消息还晚，看着像 bug）');
  if (!r.inHtml) throw new Error('渲染的 HTML 里没有这句话');
  return 'Cherry_Pop 置顶（无时间戳）· 下方 ' + (r.count - 1) + ' 条仍在时间序';
});
check('对手真的会得分，而且名次会随他们变化', () => {
  const raw = vm.runInContext(`JSON.stringify((() => {
    const out = {};
    const tot = (sec) => npcs.map(n => rivalTotal(n.userData.name, sec, n.userData));

    /* ① 头 12 分钟赛程（≈0.8 真实分钟）就该有人开始得分。
       老版 pace 是 0.18~0.55：最快的 47 分钟才交第一题，
       于是前 3 个真实分钟全场 0 分 —— 那就是"没看见其他人得分"。 */
    out.at12 = tot(12 * 60).filter(v => v > 0).length;
    /* ② 赛程 40 分钟（≈2.7 真实分钟）多数人已经在动 */
    out.at40 = tot(40 * 60).filter(v => v > 0).length;
    /* ③ 赛程 80 分钟之后所有人都交完，分数不再变 */
    const t80 = tot(80 * 60), t200 = tot(200 * 60);
    out.allDone = t80.every((v, i) => v === t200[i] && v > 0);
    out.maxTotal = Math.max.apply(null, t200);
    /* ④ 我 0 分时名次必须靠后；我的分高于所有人时才是第一 */
    state.totalScore = 0;
    out.rankZero = playerRank(40 * 60);
    state.totalScore = 9999;
    out.rankMax = playerRank(40 * 60);
    /* ⑤ 邻居名字：分数差最小那个，不能是 null 也不能随便挑 */
    state.totalScore = 100;
    out.above = rivalNeighbor(40 * 60, true);
    out.below = rivalNeighbor(40 * 60, false);
    state.totalScore = 0;
    out.aboveAtBottom = rivalNeighbor(40 * 60, true);
    state.totalScore = 9999;
    out.aboveAtTop = rivalNeighbor(40 * 60, true);
    state.totalScore = 0;
    return out;
  })())`, sandbox);
  const r = JSON.parse(raw);
  if (r.at12 < 1)
    throw new Error('头 12 分钟赛程里没有任何人得分 —— 玩家全程只会看到自己');
  if (r.at40 < 3)
    throw new Error('赛程 40 分钟只有 ' + r.at40 + ' 人在得分，榜太死');
  if (!r.allDone) throw new Error('80 分钟之后还有人没交完（或分数还在涨）');
  if (!(r.maxTotal > 200)) throw new Error('对手最高总分只有 ' + r.maxTotal + '，不构成竞争');
  if (r.rankZero <= 1) throw new Error('我 0 分还排第 ' + r.rankZero + ' 名');
  if (r.rankMax !== 1) throw new Error('我 9999 分却排第 ' + r.rankMax + ' 名');
  if (!r.above) throw new Error('分数比你高的那个找不到（rivalNeighbor）');
  if (!r.below) throw new Error('分数比你低的那个找不到');
  if (r.aboveAtTop !== null) throw new Error('已经是榜首了还说上面有人：' + r.aboveAtTop);
  if (r.aboveAtBottom === null) throw new Error('0 分却说上面没人（上面明明有五个人）');
  return '12 分钟 ' + r.at12 + ' 人在得分 / 40 分钟 ' + r.at40 +
         ' 人 / 满分最高 ' + r.maxTotal + ' · 0 分排第 ' + r.rankZero + ' · 邻居 ' + r.above + '/' + r.below;
});
check('题库自检：每道题都齐全、样例段真的存在、id 不重复', () => {
  const raw = vm.runInContext(`JSON.stringify((() => {
    const rows = PROBLEM_POOL.map(p => ({
      id: p.id, name: p.name,
      hasDesc: typeof p.desc === 'string' && p.desc.length > 200,
      hasStarter: typeof p.starter === 'string' && p.starter.indexOf('int main') >= 0,
      hasIO: p.desc.indexOf('## 输入格式') >= 0 && p.desc.indexOf('## 输出格式') >= 0,
      hasSample: p.desc.indexOf('### 输入 #1') >= 0 && p.desc.indexOf('### 输出 #1') >= 0,
      hasLimits: p.desc.indexOf('### 数据范围') >= 0,
      max: p.max
    }));
    return {
      pool: PROBLEM_POOL.length,
      drawn: pickProblems().length,
      ids: PROBLEM_POOL.map(p => p.id),
      rows: rows,
      /* 难度要真的分散：全挤在一个星级的话"题池变大"没意义 */
      diffs: [...new Set(PROBLEM_POOL.map(p => p.difficulty))].sort()
    };
  })())`, sandbox);
  const r = JSON.parse(raw);
  if (r.pool < 8) throw new Error('题池只有 ' + r.pool + ' 道，太少');
  if (r.drawn !== 4) throw new Error('每局应抽 4 道，实际 ' + r.drawn);
  if (new Set(r.ids).size !== r.ids.length) throw new Error('题目 id 有重复');
  for (const row of r.rows){
    const bad = [];
    if (!row.hasDesc) bad.push('题面太短');
    if (!row.hasStarter) bad.push('缺 starter');
    if (!row.hasIO) bad.push('缺输入/输出格式');
    if (!row.hasSample) bad.push('缺样例段');
    if (!row.hasLimits) bad.push('缺数据范围');
    if (row.max !== 100) bad.push('满分不是 100');
    if (bad.length) throw new Error(row.id + ' ' + row.name + '：' + bad.join('、'));
  }
  if (r.diffs.length < 4)
    throw new Error('难度只有 ' + r.diffs.join('/') + ' 档，题池同质化');
  return r.pool + ' 道题（难度 ' + r.diffs.join('/') + '）· 每题都有题面/样例/' +
         '数据范围 · 每局抽 ' + r.drawn + ' 道';
});
check('两个保安不许叠在同一个点刷出来（每批都换方向）', () => {
  const raw = vm.runInContext(`JSON.stringify((() => {
    dismissDialogs();
    state.area = 'room'; state.bounds = AREA_BOUNDS.room;
    state.view = 'world'; state.ended = false; state.frozen = false;
    state.pos.x = SEAT_CENTER_X; state.pos.z = SEAT_CENTER_Z;
    const savedG = securityGuards.slice(), savedS = state.guardsSpawned;
    const batches = [], all = [];
    try {
      for (let b = 0; b < 12; b++){
        securityGuards.length = 0;      /* 批与批之间清空：真实节奏就是"上一批被打倒了" */
        state.guardsSpawned = 0;
        spawnTwoGuards();
        const pos = securityGuards.map(g => [ +g.group.position.x.toFixed(2),
                                              +g.group.position.z.toFixed(2) ]);
        batches.push(pos);
        pos.forEach(p => all.push(p));
      }
    } finally {
      securityGuards.length = 0;
      savedG.forEach(g => securityGuards.push(g));
      state.guardsSpawned = savedS;
    }
    let minWithin = Infinity;
    for (const b of batches){
      if (b.length < 2) continue;
      const d = Math.hypot(b[0][0] - b[1][0], b[0][1] - b[1][1]);
      if (d < minWithin) minWithin = d;
    }
    let minAll = Infinity;
    for (let i = 0; i < all.length; i++)
      for (let j = i + 1; j < all.length; j++){
        const d = Math.hypot(all[i][0] - all[j][0], all[i][1] - all[j][1]);
        if (d < minAll) minAll = d;
      }
    const distinct = [...new Set(all.map(p => p[0] + ',' + p[1]))].length;
    let minFromPlayer = Infinity;
    for (const p of all){
      const d = Math.hypot(p[0] - SEAT_CENTER_X, p[1] - SEAT_CENTER_Z);
      if (d < minFromPlayer) minFromPlayer = d;
    }
    return { pairs: batches.filter(b => b.length === 2).length, total: all.length,
             minWithin: minWithin, minAll: minAll, distinct: distinct,
             minFromPlayer: minFromPlayer };
  })())`, sandbox);
  const r = JSON.parse(raw);
  if (r.pairs < 8) throw new Error('只有 ' + r.pairs + ' 批刷满了两个，样本不够');
  if (!(r.minWithin >= 1.8))
    throw new Error('同一批的两个保安只隔 ' + r.minWithin.toFixed(2) +
                    ' 米 —— 叠在一处了');
  if (r.distinct < 8)
    throw new Error(r.total + ' 个刷点只有 ' + r.distinct + ' 个不同位置 —— 还是往一个地方刷');
  if (!(r.minFromPlayer >= 3.4))
    throw new Error('有保安刷在玩家脸上：' + r.minFromPlayer.toFixed(2) + ' 米');
  return r.pairs + ' 批 × 2 · 同批最小间距 ' + r.minWithin.toFixed(2) +
         ' 米 · ' + r.total + ' 个刷点里 ' + r.distinct + ' 个不同位置 · 离玩家最近 ' +
         r.minFromPlayer.toFixed(2) + ' 米';
});
check('保安固定门前模式：整批都从考场门口附近刷出来', () => {
  const raw = vm.runInContext(`JSON.stringify((() => {
    const oldMode = guardSpawnMode;
    const savedG = securityGuards.slice(), savedS = state.guardsSpawned;
    const batches = [];
    try {
      guardSpawnMode = 'door';
      state.area = 'room'; state.bounds = AREA_BOUNDS.room;
      state.ended = false; state.frozen = false;
      for (let b = 0; b < 12; b++){
        securityGuards.length = 0;
        state.guardsSpawned = 0;
        spawnTwoGuards();
        batches.push(securityGuards.map(g => [
          +g.group.position.x.toFixed(2),
          +g.group.position.z.toFixed(2)
        ]));
      }
    } finally {
      securityGuards.length = 0;
      savedG.forEach(g => securityGuards.push(g));
      state.guardsSpawned = savedS;
      guardSpawnMode = oldMode;
    }
    const doorX = state.bounds.x - 0.7;
    let maxDist = 0, pairs = 0, all = [];
    for (const b of batches){
      if (b.length === 2) pairs++;
      for (const p of b){
        all.push(p);
        const d = Math.hypot(p[0] - doorX, p[1]);
        if (d > maxDist) maxDist = d;
      }
    }
    return { pairs: pairs, total: all.length, maxDist: maxDist, doorX: doorX };
  })())`, sandbox);
  const r = JSON.parse(raw);
  if (r.pairs < 8) throw new Error('只有 ' + r.pairs + ' 批刷满了两个，样本不够');
  if (!(r.maxDist <= 2.6))
    throw new Error('有保安刷在离门口 ' + r.maxDist.toFixed(2) + ' 米的地方');
  return r.pairs + ' 批 × 2 · 全部落在门前 2.6 米内（最远 ' +
         r.maxDist.toFixed(2) + ' 米，门口基准 x=' + r.doorX + '）';
});
check('保安不会刷进桌子里卡住（挂着一个找不到的保安会卡死整局）', () => {
  const raw = vm.runInContext(`JSON.stringify((() => {
    dismissDialogs();
    state.area = 'room'; state.bounds = AREA_BOUNDS.room;
    state.view = 'world'; state.ended = false; state.frozen = false;
    state.pos.x = SEAT_CENTER_X; state.pos.z = SEAT_CENTER_Z;
    const savedGuards = securityGuards.slice();
    const savedSpawned = state.guardsSpawned;
    const out = { bad: 0, spots: 0, pulled: null, reloc: null };

    try {
      /* ① 取点函数本身：怎么撒都不能落在碰撞体里 */
      for (let i = 0; i < 60; i++){
        state.pos.x = (i % 5) * 1.6 - 3.2;
        state.pos.z = ((i / 5) | 0) * 1.4 - 3.5;
        const sp = guardFreeSpot();
        if (!sp) continue;
        out.spots++;
        if (collides(sp.x, sp.z, 0.34)) out.bad++;
      }
      /* ② 真刷两批：每一个都必须是站得住的 */
      state.pos.x = SEAT_CENTER_X; state.pos.z = SEAT_CENTER_Z;
      state.guardsSpawned = 0;
      for (let k = 0; k < 8; k++) spawnTwoGuards();
      out.spawned = securityGuards.length;
      out.stuckSpawned = securityGuards.filter(g =>
        collides(g.group.position.x, g.group.position.z, 0.3)).length;

      /* ③ 已经陷进桌子里的：一帧之内要被拽出来 */
      const savedLen = obstacles.length;
      obstacles.push({ x: -1.0, z: -5.0, hw: 1.4, hd: 1.4 });
      const g = { userData: { alive: true }, group: { position: { x: -1.0, y: 0, z: -5.0 } } };
      out.pulled = { before: collides(g.group.position.x, g.group.position.z, 0.3) };
      unstickGuard(g, 1 / 60);
      const p = g.group.position;
      out.pulled.after = collides(p.x, p.z, 0.3);
      out.pulled.moved = (p.x !== -1.0 || p.z !== -5.0);

      /* ④ 四面都堵死（挤在实心块里）：超时之后必须换地方 */
      obstacles.push({ x: -5.6, z: 5.2, hw: 3.2, hd: 3.2 });
      const g2 = { userData: { alive: true }, group: { position: { x: -5.6, y: 0, z: 5.2 } } };
      for (let k = 0; k < 120; k++) unstickGuard(g2, 1 / 60);
      const q = g2.group.position;
      out.reloc = { free: !collides(q.x, q.z, 0.3),
                    where: [ +q.x.toFixed(2), +q.z.toFixed(2) ] };
      /* ⑤ 整个考场都堵死：必须返回 null，而且一个都不许刷出来。
         这一条才是直接钉住"取点有没有做碰撞检查" ——
         只断言"刷出来的都没卡住"，在撒点恰好避开桌子时是能蒙过去的。 */
      const savedLen2 = obstacles.length;
      obstacles.push({ x: 0, z: 0, hw: 500, hd: 500 });
      const blocked = guardFreeSpot();
      const beforeCount = securityGuards.length;
      spawnTwoGuards();
      out.blockedNull = (blocked === null);
      out.spawnedWhenBlocked = securityGuards.length - beforeCount;
      obstacles.length = savedLen2;

      obstacles.length = savedLen;
    } finally {
      securityGuards.length = 0;
      savedGuards.forEach(x => securityGuards.push(x));
      state.guardsSpawned = savedSpawned;
    }
    return out;
  })())`, sandbox);
  const r = JSON.parse(raw);
  if (r.spots < 40) throw new Error('取点函数几乎找不到位置（只有 ' + r.spots + ' 次成功）');
  if (r.bad > 0) throw new Error('guardFreeSpot 有 ' + r.bad + ' 次落在碰撞体里');
  if (r.spawned < 6) throw new Error('只刷出 ' + r.spawned + ' 个保安，取点太保守');
  if (r.stuckSpawned > 0)
    throw new Error('有 ' + r.stuckSpawned + ' 个保安刷进了几何体 —— 他会永远卡住并挂在 HUD 上');
  if (!r.pulled.before) throw new Error('前置条件不成立：造出来的位置本来就不卡');
  if (r.pulled.after) throw new Error('卡在桌子里的保安一帧之后还在里面');
  if (!r.reloc.free) throw new Error('四面堵死时没能把他挪到能站的地方');
  if (!r.blockedNull)
    throw new Error('整个考场都堵死时 guardFreeSpot 还给了一个位置 —— 碰撞检查形同虚设');
  if (r.spawnedWhenBlocked !== 0)
    throw new Error('没地方站却还是刷出了 ' + r.spawnedWhenBlocked + ' 个保安');
  return '取点 ' + r.spots + ' 次全部避开碰撞体 · 真刷 ' + r.spawned +
         ' 个无一卡住 · 陷入一帧拉出 · 堵死时挪到 [' + r.reloc.where.join(', ') + ']';
});
check('被打倒的同学：他的电脑能看了（不再说"他还在座位上"）', () => {
  const raw = vm.runInContext(`JSON.stringify((() => {
    dismissDialogs();
    state.area = 'room'; state.bounds = AREA_BOUNDS.room;
    state.view = 'world'; state.ended = false; state.frozen = false;
    const n = npcs[0], ud = n.userData;
    const saved = ud.state;
    const out = {};
    try {
      ud.state = 'seated';
      closeNPCComputer();
      state.view = 'world';
      useNPCComputer(0);
      out.seated = state.view;                       /* 应当仍是 world */

      ud.state = 'down';
      state.view = 'world';
      useNPCComputer(0);
      out.down = state.view;                         /* 应当是 npcComputer */
      out.head = String(document.getElementById('npcCompHead').textContent || '');
      closeNPCComputer();
    } finally { ud.state = saved; state.view = 'world'; }
    return out;
  })())`, sandbox);
  const r = JSON.parse(raw);
  if (r.seated !== 'world') throw new Error('人还坐在座位上就把电脑打开了');
  if (r.down !== 'npcComputer')
    throw new Error('人已经被打倒了，还不给看他的电脑（view=' + r.down + '）');
  if (r.head.indexOf('的电脑') < 0) throw new Error('面板标题不对：' + r.head);
  return '坐着拦下 / 打倒后能看（' + r.head + '）';
});
check('打倒监考老师：没收走的手机要还回来（且不会变成两部）', () => {
  const raw = vm.runInContext(`JSON.stringify((() => {
    const saved = { has: state.hasPhone, bag: JSON.stringify(state.bag) };
    const out = {};
    try {
      /* 被没收：手机不在兜里也不在包里 */
      state.hasPhone = false;
      if (bagCount('phone') > 0) bagTake('phone', 1);
      out.before = { has: state.hasPhone, n: bagCount('phone') };
      out.first = recoverPhoneFromTeacher();
      out.after = { has: state.hasPhone, n: bagCount('phone') };
      out.second = recoverPhoneFromTeacher();     /* 再叫一次不该多给一部 */
      out.afterTwice = bagCount('phone');
      out.usable = canOpenPhone();
    } finally {
      state.hasPhone = saved.has;
      state.bag.length = 0;
      JSON.parse(saved.bag).forEach(e => state.bag.push(e));
      renderHotbar();
    }
    return out;
  })())`, sandbox);
  const r = JSON.parse(raw);
  if (r.before.has || r.before.n !== 0)
    throw new Error('前置条件不成立：手机没被没收干净');
  if (!r.first) throw new Error('打倒老师之后没有还手机');
  if (!r.after.has || r.after.n !== 1)
    throw new Error('还回来的状态不对：hasPhone=' + r.after.has + ' bag=' + r.after.n);
  if (r.second) throw new Error('第二次调用又"还"了一次');
  if (r.afterTwice !== 1) throw new Error('背包里变成了 ' + r.afterTwice + ' 部手机');
  if (!r.usable) throw new Error('手机回来了却用不了（canOpenPhone 为 false）');
  return 'hasPhone false/0 → 还回 true/1，重复调用不多给，且能掏出手机';
});
check('入场预留：早到重置 4 小时、迟到按其时长扣时、超时缺考', () => {
  const raw = vm.runInContext(`
    JSON.stringify((() => {
      const reset = admit => {
        dismissDialogs();
        switchArea('campus');
        state.bounds = AREA_BOUNDS.campus;
        state.enteredRoom = false;
        state.examStarted = false;
        state.elapsed = 0;
        state.admitElapsed = admit;
        state.entryArrival = 0;
        state.missedEntry = false;
        state.entryWarned = false;
        state.passedSecurity = true;
        state.hasPhone = false;
        state.ended = false;
        state.view = 'world';
        state.achievements.delete('rush');
        state.achievements.delete('late_entry');
      };

      /* ① 早到 10 分钟：进楼后考试时钟归零，拿满 4 小时 */
      reset(600);
      const leftOk = entryLeft();
      enter404Classroom(); selectDialogOption(0);
      const earlyArea = state.area, earlyStarted = state.examStarted,
            earlyElapsed = state.elapsed,
            earlyRush = state.achievements.has('rush'),
            earlyLate = state.achievements.has('late_entry');

      /* ② 压线：预留只剩 30 秒，仍算早到，记成就且时钟归零 */
      reset(EXAM_ENTRY_LIMIT - 30);
      const leftRush = entryLeft();
      enter404Classroom(); selectDialogOption(0);
      const rushArea = state.area, rushStarted = state.examStarted,
            rushElapsed = state.elapsed, rushAch = state.achievements.has('rush');

      /* ③ 迟到 5 分钟：可以进，但考试时钟从 300 秒开始 */
      reset(EXAM_ENTRY_LIMIT + 300);
      const lateLeft = entryLeft(), lateRemain = entryProjectedRemain();
      enter404Classroom(); selectDialogOption(0);
      const lateArea = state.area, lateStarted = state.examStarted,
            lateElapsed = state.elapsed,
            lateAch = state.achievements.has('late_entry'),
            lateMissing = state.missedEntry;

      /* ④ 预留 + 4 小时都过完：进不去，弹「考试已结束」，结算缺考 */
      reset(EXAM_ENTRY_LIMIT + CONTEST_LEN);
      enter404Classroom();
      const shutArea = state.area, shutEntered = state.enteredRoom,
            shutMissing = state.missedEntry;
      const shutTitle = dialogs.length
        ? String(dialogs[dialogs.length - 1].title || '').replace(/\\s/g, '') : '';
      dismissDialogs();
      endContest(false);
      const ended = state.ended;
      const endTitle = String(document.getElementById('endTitle').textContent || '')
                        .replace(/\\s/g, '');
      const endSub = String(document.getElementById('endSub').textContent || '');
      const absentAch = state.achievements.has('late');
      const noSpeedrun = !state.achievements.has('speedrun');

      /* 还原，别影响后面的检查 */
      state.ended = false; state.view = 'world';
      state.missedEntry = false; state.enteredRoom = false;
      state.examStarted = false; state.elapsed = 0; state.admitElapsed = 0;
      state.area = 'campus'; state.bounds = AREA_BOUNDS.campus;

      return { leftOk, earlyArea, earlyStarted, earlyElapsed, earlyRush, earlyLate,
               leftRush, rushArea, rushStarted, rushElapsed, rushAch,
               lateLeft, lateRemain, lateArea, lateStarted, lateElapsed,
               lateAch, lateMissing,
               shutArea, shutEntered, shutMissing, shutTitle,
               ended, endTitle, endSub, absentAch, noSpeedrun,
               limit: EXAM_ENTRY_LIMIT, margin: EXAM_RUSH_MARGIN };
    })())
  `, sandbox);
  const r = JSON.parse(raw);
  if (r.limit !== 1800) throw new Error('入场预留应为 1800 秒（30 分钟），实际 ' + r.limit);
  if (r.margin !== 180) throw new Error('压线窗口应为 180 秒（3 分钟），实际 ' + r.margin);
  if (r.leftOk !== 1200) throw new Error('早到 10 分钟时预留剩余应为 1200 秒，实际 ' + r.leftOk);
  if (r.earlyArea !== 'room' || !r.earlyStarted) throw new Error('早到却没能进楼');
  if (r.earlyElapsed !== 0) throw new Error('早到进场后考试时钟不是 0：' + r.earlyElapsed);
  if (r.earlyRush || r.earlyLate) throw new Error('时间还早却给了压线/迟到成就');
  if (r.leftRush !== 30) throw new Error('压线时预留剩余应为 30 秒，实际 ' + r.leftRush);
  if (r.rushArea !== 'room' || !r.rushStarted) throw new Error('压线时进不去楼');
  if (r.rushElapsed !== 0) throw new Error('压线进场后考试时钟不是 0：' + r.rushElapsed);
  if (!r.rushAch) throw new Error('压线进场没解锁「压线进场」');
  if (r.lateLeft !== -300) throw new Error('迟到 5 分钟时 entryLeft 应为 -300，实际 ' + r.lateLeft);
  if (r.lateRemain !== 14100)
    throw new Error('迟到 5 分钟时剩余考试时间应为 14100 秒，实际 ' + r.lateRemain);
  if (r.lateArea !== 'room' || !r.lateStarted) throw new Error('迟到却进不去楼');
  if (r.lateElapsed !== 300) throw new Error('迟到进场后考试时钟应为 300，实际 ' + r.lateElapsed);
  if (!r.lateAch) throw new Error('迟到进场没解锁「迟到入场」');
  if (r.lateMissing) throw new Error('迟到进场却记成了缺考');
  if (!r.shutMissing) throw new Error('超时没记 missedEntry');
  if (r.shutArea === 'room' || r.shutEntered) throw new Error('考试结束后还能进考场');
  if (r.shutTitle.indexOf('考试已结束') < 0)
    throw new Error('超时没弹「考试已结束」：' + r.shutTitle);
  if (!r.ended) throw new Error('超时了却没有收场');
  if (r.endTitle.indexOf('缺考') < 0) throw new Error('结算标题不对：' + r.endTitle);
  if (r.endSub.indexOf('结束') < 0) throw new Error('结算副标题不对：' + r.endSub);
  if (!r.absentAch) throw new Error('缺考没解锁「缺考」');
  if (!r.noSpeedrun) throw new Error('缺考白捡了「神速交卷」—— 分支顺序写反了');
  return '预留 ' + (r.limit / 60) + ' 分 · 早到 10 分→时钟 0 · 迟到 5 分→时钟 300 · ' +
         '超时缺考 · 不白送神速';
});
check('HUD 时钟：入场显示预留倒计时，进楼跳回 4 小时，迟到显示扣后剩余', () => {
  const raw = vm.runInContext(`JSON.stringify((() => {
    const old = {
      started: state.started, ended: state.ended, view: state.view,
      area: state.area, bounds: state.bounds, examStarted: state.examStarted,
      admit: state.admitElapsed, elapsed: state.elapsed, scale: timeScale
    };
    const read = () => document.getElementById('hudTimer').textContent;
    try {
      timeScale = 0;                    /* 不让 animate 推时钟，文案才是确定的 */
      state.started = true; state.ended = false; state.view = 'world';
      state.area = 'campus'; state.bounds = AREA_BOUNDS.campus;

      state.examStarted = false; state.admitElapsed = 600; state.elapsed = 0;
      animate();
      const early = read();

      state.examStarted = true; state.admitElapsed = 0; state.elapsed = 0;
      animate();
      const exam = read();

      state.examStarted = false; state.admitElapsed = EXAM_ENTRY_LIMIT + 600; state.elapsed = 0;
      animate();
      const late = read();

      return { early: early, exam: exam, late: late };
    } finally {
      timeScale = old.scale;
      state.started = old.started; state.ended = old.ended; state.view = old.view;
      state.area = old.area; state.bounds = old.bounds;
      state.examStarted = old.examStarted; state.admitElapsed = old.admit;
      state.elapsed = old.elapsed;
    }
  })())`, sandbox);
  const r = JSON.parse(raw);
  if (r.early !== '入场 00:20:00')
    throw new Error('入场 10 分钟时 HUD 应为「入场 00:20:00」，实际「' + r.early + '」');
  if (r.exam !== '04:00:00')
    throw new Error('进楼后 HUD 应跳回 04:00:00，实际「' + r.exam + '」');
  if (r.late !== '迟到 03:50:00')
    throw new Error('迟到 10 分钟时 HUD 应为「迟到 03:50:00」，实际「' + r.late + '」');
  return r.early + ' → 进楼 ' + r.exam + ' · ' + r.late;
});
check('偷看同学电脑：显示的是他自己的题和他的代码，不是我的', () => {
  const raw = vm.runInContext(`JSON.stringify((() => {
    dismissDialogs();
    state.area = 'room'; state.bounds = AREA_BOUNDS.room;
    state.view = 'world'; state.ended = false; state.frozen = false;
    const saved = npcs.map(n => n.userData.state);
    npcs.forEach(n => { n.userData.state = 'away'; });

    const read = i => {
      useNPCComputer(i);
      const out = {
        head: String(document.getElementById('npcCompHead').textContent || ''),
        tag: String(document.getElementById('npcCompTag').textContent || ''),
        first: String(document.getElementById('npcCompCode').textContent || '').split('\\n')[0]
      };
      closeNPCComputer();
      return out;
    };
    const a = read(0);
    const b = read(1);
    const names = npcs.map(n => n.userData.name);
    const ids = names.map(n => npcProblemId(n));
    npcs.forEach((n, i) => { n.userData.state = saved[i]; });
    /* 还原：后面几条是校园段，area 留在 room 会让 campusInteract 直接 return */
    state.area = 'campus'; state.bounds = AREA_BOUNDS.campus;
    state.view = 'world';
    state.pos.x = CP.x + CAMPUS_SPAWN.x;
    state.pos.z = CP.z + CAMPUS_SPAWN.z;
    state.yaw = 0; yawTarget = 0; state.pitch = 0; pitchTarget = 0;

    return { a: a, b: b, nameA: names[0], nameB: names[1],
             ids: ids, distinct: [...new Set(ids)].length,
             pool: PROBLEM_POOL.length,
             mine: state.problems.map(p => p.id),
             /* npcProbId 这个全局字段已经删掉了 —— 留着它就说明还有第二份真相 */
             legacy: typeof state.npcProbId };
  })())`, sandbox);
  const r = JSON.parse(raw);
  if (r.a.head.indexOf(r.nameA + '的电脑') < 0)
    throw new Error('标题不是"他的电脑"：' + r.a.head);
  if (r.a.first.indexOf(r.nameA) < 0)
    throw new Error('他电脑上第一行代码没他的名字：' + r.a.first);
  if (r.b.first.indexOf(r.nameB) < 0)
    throw new Error('第二台电脑上是他自己的名字吗：' + r.b.first);
  if (r.a.tag.indexOf('未经允许') < 0)
    throw new Error('标签丢了"未经允许"：' + r.a.tag);
  if (r.pool < 2) throw new Error('题池太小，分不出"他的题"和"我的题"');
  if (r.distinct < 2)
    throw new Error('所有同学都做同一道题（' + r.ids.join(',') + '）—— 又会看起来像我的电脑');
  if (r.legacy !== 'undefined')
    throw new Error('state.npcProbId 还在：这会变成第二份真相');
  return r.a.head + ' / ' + r.b.head + ' · 5 人共 ' + r.distinct + ' 道不同的题（题池 ' +
         r.pool + '）· 我的四道：' + r.mine.join(',');
});
check('传送圈 mesh 已建出且朝向地面', () => {
  const ok = vm.runInContext('!!(portalRing && portalRing.rotation.x === -Math.PI/2)', sandbox);
  if (!ok) throw new Error('光圈没建出来或没转平');
  return 'portalRing 就位';
});
check('站在传送圈上 → actionF 就位并出提示', () => {
  vm.runInContext(`
    dismissDialogs();
    state.pos.x = CP.x + CAMPUS_PORTAL_X;
    state.pos.z = CP.z + CAMPUS_PORTAL_Z;
    updateInteract();
  `, sandbox);
  if (!vm.runInContext('actionF !== null', sandbox)) throw new Error('圈上没有 F 交互');
  return vm.runInContext('promptEl.textContent', sandbox).slice(0, 26);
});
check('有弹窗时场景交互让位给弹窗（优先级正确）', () => {
  vm.runInContext(`
    state.pos.x = CP.x + CAMPUS_PORTAL_X;
    state.pos.z = CP.z + CAMPUS_PORTAL_Z;
    openDialog({ title: 'x', text: 'y', options: [{ label: 'ok', cb: function(){} }] });
    updateInteract();
  `, sandbox);
  const claimed = vm.runInContext('actionF !== null', sandbox);
  vm.runInContext('dismissDialogs()', sandbox);
  if (claimed) throw new Error('弹窗开着还能触发场景交互');
  return '弹窗期间 actionF = null';
});
check('按 F 瞬移到教学楼门口', () => {
  /* updateInteract() 每次调用都会把 actionE/F/Space 清空重建，
     所以要在同一次判定之后马上派发按键 —— 这也是真实按键路径的行为
     （main.js 的 keydown 直接读上一次 updateInteract 留下的 actionF）。 */
  const before = vm.runInContext('+state.pos.z.toFixed(1)', sandbox);
  vm.runInContext(`
    state.pos.x = CP.x + CAMPUS_PORTAL_X;
    state.pos.z = CP.z + CAMPUS_PORTAL_Z;
    updateInteract();
    doInteract("f");
  `, sandbox);
  const after = vm.runInContext('+state.pos.z.toFixed(1)', sandbox);
  if (after === before) throw new Error('位置没变');
  const near = vm.runInContext(
    'Math.hypot(state.pos.x - CP.x, state.pos.z - (CP.z + CAMPUS_BUILD_Z)) < 12', sandbox);
  if (!near) throw new Error('瞬移目标不是教学楼门口，z = ' + after);
  if (!vm.runInContext('state.portalUsed', sandbox)) throw new Error('portalUsed 没置位');
  return before + ' → ' + after;
});
check('未过安检时不能进教室', () => {
  vm.runInContext('state.passedSecurity = false; enter404Classroom();', sandbox);
  if (vm.runInContext('state.area', sandbox) !== 'campus') throw new Error('没过安检还是进去了');
  return '仍留在 campus';
});
check('过安检会打开弹窗并置位', () => {
  vm.runInContext('doSecurityCheck()', sandbox);
  if (!vm.runInContext('hasDialog()', sandbox)) throw new Error('安检没弹窗');
  vm.runInContext('dialogs[dialogs.length - 1].options[0].cb()', sandbox);
  if (!vm.runInContext('state.passedSecurity', sandbox)) throw new Error('安检没生效');
  return 'passedSecurity = true';
});
/* 弹窗的生命周期必须闭环：选了选项就得自己关掉。

   这条断言以前是**缺的** —— 老测试直接调 `options[0].cb()`，只检查副作用
   （passedSecurity / area），从不检查弹窗有没有消失。于是"选完选项弹窗
   永远留在屏幕上"这个 bug 一路全绿，而玩家的体验是三件事同时坏掉：
     · 点鼠标没反应（有弹窗时点击被拦掉，鼠标看起来"死了"）
     · E / 数字键只是反复触发同一个选项，弹窗还在
     · campusInteract 再也不执行 → 碰不到门 → 进不了楼
   教训：断言要覆盖"状态机的出口"，不能只覆盖"动作的副作用"。 */
check('校园弹窗的每一个选项都会把自己关掉', () => {
  const raw = vm.runInContext(`
    (() => {
      /* 存一份进来时的状态，跑完原样还回去 —— 这条用例会翻动
         passedSecurity / enteredRoom，不还原就会污染后面的用例 */
      const saved = { passedSecurity: state.passedSecurity, enteredRoom: state.enteredRoom };
      const out = [];
      const cases = [
        { name: '安检',
          open: () => { state.passedSecurity = false; doSecurityCheck(); } },
        { name: '进教室',
          open: () => { state.passedSecurity = true; state.enteredRoom = false; enter404Classroom(); } },
        { name: '志愿者',
          open: () => {
            state.passedSecurity = false;
            delete state['__talk_志愿者 · 小林'];      /* 台词轮播计数复位，保证选项集合确定 */
            talkToVolunteer(campusTalkTargets[0]);
          } }
      ];
      for (const c of cases){
        dismissDialogs();
        c.open();
        if (!dialogs.length){ out.push(c.name + ' 没弹出窗（前置条件不成立）'); continue; }
        const n = dialogs[dialogs.length - 1].options.length;
        for (let i = 0; i < n; i++){
          dismissDialogs();
          c.open();
          const before = dialogs.length;
          const d = dialogs[dialogs.length - 1];
          d.options[i].cb(d);                        /* 模拟玩家选中第 i 个选项 */
          if (dialogs.length >= before){
            out.push(c.name + ' 的第 ' + (i + 1) + ' 个选项选完没关弹窗');
          }
        }
        dismissDialogs();
      }
      /* 复位，别把烂摊子留给后面的用例 */
      state.passedSecurity = saved.passedSecurity;
      state.enteredRoom = saved.enteredRoom;
      return JSON.stringify(out);
    })()
  `, sandbox);
  const bad = JSON.parse(raw);
  if (bad.length) throw new Error(bad.join(' / '));
  return '3 个弹窗的每个选项都正确关闭';
});
/* 端到端：把玩家真正会走的那条路走完 ——
   站在门口 → updateInteract 出提示 → E → 选选项 → 再看提示 → E → 进教室。
   逐条测回调是不够的：这条把 updateInteract / doInteract / 弹窗生命周期 /
   closeDialog 串起来，任何一环把输入吞掉都会在这里断掉。
   （准星在几何上是否真能瞄到门，由 browsercheck.mjs 在真浏览器里验；
     这里用 __hit 标记模拟"准星正对着它"。） */
check('端到端：门口 E → 过安检 → 落电梯间 → 走回 404', () => {
  const raw = vm.runInContext(`
    (() => {
      const saved = { area: state.area, ps: state.passedSecurity, er: state.enteredRoom,
                      ex: state.examStarted, px: state.pos.x, pz: state.pos.z };
      const log = [];
      const audit = campusAuditTargets.find(a => a.kind === 'audit').obj;

      switchArea('campus');
      state.pos.x = CP.x;
      state.pos.z = CP.z + CAMPUS_AUDIT_Z + 1.6;
      state.passedSecurity = false; state.enteredRoom = false; state.examStarted = false;
      dismissDialogs();
      audit.__hit = { dist: 1 };            /* 模拟准星正对安检门 */

      try {
        /* ① 走到门口 → 该出现"过安检"提示 */
        updateInteract();
        log.push('门口提示=' + String(promptEl.textContent || '').slice(0, 16));

        /* ② 按 E → 安检弹窗 */
        doInteract('e');
        log.push('按E后弹窗=' + dialogs.length);

        /* ③ 选第 1 个选项（"走进教学楼"）→ 过安检 + 落电梯间 */
        selectDialogOption(0);
        log.push('选完: 弹窗=' + dialogs.length + ' 安检=' + state.passedSecurity + ' 区域=' + state.area);

        /* ④ 已落在电梯间（hall1），自己走到 404 门洞，走进房间 */
        state.pos.set(7.5, 1.65, 0);
        checkBuildingDoors();
        log.push('进404: 区域=' + state.area + ' 进场=' + state.enteredRoom + ' 开考=' + state.examStarted);
      } finally {
        delete audit.__hit;
      }

      dismissDialogs();
      switchArea(saved.area);
      state.passedSecurity = saved.ps;
      state.enteredRoom = saved.er;
      state.examStarted = saved.ex;
      state.pos.x = saved.px; state.pos.z = saved.pz;
      return JSON.stringify(log);
    })()
  `, sandbox);
  const log = JSON.parse(raw);
  const join = log.join('  |  ');
  const at = k => { const s = log.find(x => x.startsWith(k)); return s ? s.slice(k.length) : '(缺)'; };

  if (!/过安检（安检门）/.test(at('门口提示')))
    throw new Error('门口提示文案不对（不该漏内部英文 kind）　→ ' + join);
  if (at('按E后弹窗') !== '=1')
    throw new Error('按 E 没弹出安检窗　→ ' + join);
  if (at('选完: 弹窗') !== '=0 安检=true 区域=hall1')
    throw new Error('选完选项后应落到电梯间（hall1）　→ ' + join);
  if (at('进404: 区域') !== '=room 进场=true 开考=true')
    throw new Error('走回 404 后应切到 room 并开考　→ ' + join);
  return join;
});
check('走进 404 → 切到房间区域并启动考试时钟', () => {
  const r = vm.runInContext(`
    (() => {
      state.started = true; state.ended = false; state.frozen = false; state.view = 'world';
      switchArea('campus');
      state.passedSecurity = true; state.enteredRoom = false; state.examStarted = false;
      state.entryArrival = 0; state.admitElapsed = 0;
      dismissDialogs();
      teleportToElevatorLobby();           /* 安检通过后落在电梯间 */
      const inHall = state.area;
      state.pos.set(7.5, 1.65, 0);         /* 自己走到 404 门洞（走廊西墙） */
      checkBuildingDoors();                /* 走进房间 */
      return { inHall: inHall, area: state.area,
               entered: state.enteredRoom, started: state.examStarted };
    })()
  `, sandbox);
  if (r.inHall !== 'hall1') throw new Error('安检后没落电梯间/走廊：' + r.inHall);
  if (r.area !== 'room') throw new Error('走进 404 没切到 room：' + r.area);
  if (!r.entered) throw new Error('enteredRoom 没置位');
  if (!r.started) throw new Error('考试时钟没启动');
  return 'hall1 → room，已开考';
});
check('切到房间后障碍表换成了房间的', () => {
  const n = vm.runInContext('obstacles.length', sandbox);
  const cn = vm.runInContext('campusColliders.length', sandbox);
  if (n === cn) throw new Error('障碍表没换，仍是校园的 ' + n + ' 个');
  return '房间障碍 ' + n + ' 个（校园 ' + cn + ' 个）';
});
check('来回切区域障碍数稳定（不累积）', () => {
  const room0 = vm.runInContext('obstacles.length', sandbox);
  vm.runInContext('switchArea("campus"); switchArea("room");', sandbox);
  const room1 = vm.runInContext('obstacles.length', sandbox);
  if (room0 !== room1) throw new Error('来回切一次变了：' + room0 + ' → ' + room1);
  return room0 + ' === ' + room1;
});

/* ============================ 8. 桌面与小恐龙 ============================ */
console.log('\n== 5. 桌面 · CSP-S114514 · 小恐龙 ==');
check('桌面文件列表 = 4 道题 + dino.exe', () => {
  const arr = JSON.parse(vm.runInContext('JSON.stringify(desktopEntries())', sandbox));
  if (arr.length !== 5) throw new Error('条目数 ' + arr.length);
  const probs = arr.filter(x => x.kind === 'problem');
  if (probs.length !== 4) throw new Error('题目文件 ' + probs.length + ' 个');
  if (!arr.some(x => x.name === 'dino.exe')) throw new Error('没有 dino.exe');
  return probs.map(p => p.name).join(' ') + ' + dino.exe';
});
check('题目文件名与当前局题目 id 一致', () => {
  const arr = JSON.parse(vm.runInContext('JSON.stringify(desktopEntries())', sandbox));
  const ids = vm.runInContext('state.problems.map(p=>p.id).join(",")', sandbox);
  const names = arr.filter(x => x.kind === 'problem').map(x => x.name.replace('.cpp', '')).join(',');
  if (names !== ids) throw new Error(names + ' ≠ ' + ids);
  return names;
});
check('打开桌面 → view 切到 launcher', () => {
  vm.runInContext('openDesktop()', sandbox);
  if (vm.runInContext('state.view', sandbox) !== 'launcher') throw new Error('view 没切');
  return 'view = launcher';
});
check('双击题目文件 → 进 IDE 且当前题切对了', () => {
  const id = vm.runInContext('state.problems[2].id', sandbox);
  vm.runInContext('openDesktopEntry({kind:"problem", id:' + JSON.stringify(id) + '})', sandbox);
  if (vm.runInContext('state.view', sandbox) !== 'code') throw new Error('没进 IDE');
  if (vm.runInContext('state.curProb', sandbox) !== id) throw new Error('当前题没切');
  vm.runInContext('closeCode(); openDesktop();', sandbox);
  return '打开了 ' + id;
});
check('打开 dino.exe → 待机、0 分、无障碍', () => {
  vm.runInContext('dinoOpen()', sandbox);
  const st = JSON.parse(vm.runInContext('JSON.stringify(window.__OI__.launcher.dinoState())', sandbox));
  if (st.running) throw new Error('一打开就在跑（应该是待机）');
  if (st.score !== 0 || st.obstacles !== 0) throw new Error('初始状态脏：' + JSON.stringify(st));
  return '待机，速度 ' + st.speed;
});
check('开始后跑 600 帧：分数涨、速度增、不掉到地下', () => {
  vm.runInContext('dinoStart(); for (let i = 0; i < 600 && !dinoOver; i++) dinoStep(1/60);', sandbox);
  const st = JSON.parse(vm.runInContext('JSON.stringify(window.__OI__.launcher.dinoState())', sandbox));
  if (st.score <= 0) throw new Error('跑了 10 秒还是 0 分');
  if (st.y < -0.01) throw new Error('恐龙掉到地下 y = ' + st.y);
  if (st.speed <= 320) throw new Error('速度没增长，仍是 ' + st.speed);
  return 'score=' + st.score + ' speed=' + st.speed + ' y=' + st.y + ' 障碍=' + st.obstacles;
});
check('跳跃真的离开地面再落回', () => {
  vm.runInContext('dinoStart(); dinoJump(); dinoStep(0.1);', sandbox);
  const mid = JSON.parse(vm.runInContext('JSON.stringify(window.__OI__.launcher.dinoState())', sandbox));
  if (mid.y <= 0) throw new Error('跳起来后 y 还是 ' + mid.y);
  vm.runInContext('for (let i = 0; i < 200; i++) dinoStep(1/60);', sandbox);
  const end = JSON.parse(vm.runInContext('JSON.stringify(window.__OI__.launcher.dinoState())', sandbox));
  if (end.onGround !== true || end.y !== 0) throw new Error('没落回地面：' + JSON.stringify(end));
  return '最高 ' + mid.y + ' → 落回 0';
});
check('最高速滞空位移够跨最宽仙人掌（跳跃设计余量）', () => {
  /* 滞空时间 = 2*JUMP_V/G；位移 = 速度 × 滞空时间。这是"这游戏能不能玩"的
     核心数值，所以用公式独立算一遍，而不是相信常量旁边的注释。 */
  const span = vm.runInContext('(2 * DINO.JUMP_V / DINO.G) * DINO.SPEED_MAX', sandbox);
  const widest = 57;
  if (span < widest * 1.6) throw new Error('最高速位移 ' + span.toFixed(0) + 'px 跨 ' + widest + 'px 太紧');
  return '最高速位移 ' + span.toFixed(0) + 'px vs 最宽障碍 ' + widest + 'px';
});
/* ---- 小恐龙：可玩性（真物理） ----
   下面这几条是补的，因为老测试有一个致命盲区：
   它只断言"滞空位移 vs 障碍**宽度**"（纯水平），从不检查"跳跃顶点 vs 障碍**高度**"。
   于是它一路全绿，而游戏里**一个障碍都跳不过去** —— 顶点 50px，最矮的仙人掌要 58px。
   教训和校园弹窗那次一样：断言测的是"我这个数算得对不对"，
   而不是"玩家真的能玩吗"。所以下面这些驱动真实的 dinoStep，扫起跳时机。 */

check('小恐龙：跳跃顶点高过最高障碍（竖直余量 —— 老测试只算了水平）', () => {
  const r = JSON.parse(vm.runInContext(`
    (() => {
      /* 用真实的固定步长积分算顶点，别信常量旁边的注释 */
      let v = DINO.JUMP_V, y = 0, apex = 0;
      for (let i = 0; i < 2000 && (v > 0 || y > 0); i++){
        v -= DINO.G / 60; y += v / 60;
        if (y > apex) apex = y;
        if (y <= 0) break;
      }
      const tallest = Math.max(...DINO_OBS.filter(o => o.kind === 'cactus').map(o => o.h));
      return JSON.stringify({ apex: apex, tallest: tallest });
    })()
  `, sandbox));
  if (r.apex < r.tallest + 8)
    throw new Error('跳跃顶点只有 ' + r.apex.toFixed(1) + 'px，最高仙人掌要 ' +
                    r.tallest + 'px —— 竖直方向根本过不去（余量至少要 8px）');
  return '顶点 ' + r.apex.toFixed(1) + 'px vs 最高仙人掌 ' + r.tallest + 'px（余量 ' +
         (r.apex - r.tallest).toFixed(1) + 'px）';
});

check('小恐龙：每种障碍在每个速度下都真的能跳过去（扫起跳时机）', () => {
  const raw = vm.runInContext(`
    (() => {
      /* 扫起跳时机：障碍前缘离恐龙判定盒还有 gap 时起跳，看能不能活下来。
         返回"能活下来的 gap 数"×2 = 可容忍的时机窗口宽度（px）。 */
      function clearWindow(obs, speed){
        const DX = 26 * DINO.PX, DW = 22 * DINO.PX;
        let good = 0;
        for (let gap = 300; gap >= 0; gap -= 2){
          dinoReset();
          dinoRunning = true; dinoOver = false;
          dinoSpeed = speed;
          dinoSpawnAt = 1e9;               /* 关掉随机生成，只留手工摆的这一个 */
          dinoObs.length = 0;
          const o = { kind: obs.kind, x: DX + DW + gap + 700, w: obs.w, h: obs.h };
          if (obs.y !== undefined) o.y = obs.y;
          dinoObs.push(o);

          let jumped = false, ok = true;
          for (let f = 0; f < 4000; f++){
            const cur = dinoObs[0];
            if (!cur) break;
            if (!jumped && (cur.x + 4) - (DX + DW) <= gap){ dinoJump(); jumped = true; }
            dinoStep(1/60);
            if (dinoOver){ ok = false; break; }
            if (cur.x + cur.w < -20) break; /* 安全通过 */
          }
          if (ok && !dinoOver) good++;
        }
        return good * 2;                    /* px 窗口宽度 */
      }

      const out = [];
      for (const spec of DINO_OBS){
        for (const sp of [320, 470, 620]){
          /* 翼龙取最低那一种（其他两种靠蹲下躲，不该用"能不能跳过"来衡量） */
          const o = { kind: spec.kind, w: spec.w, h: spec.h };
          if (spec.kind === 'bird') o.y = DINO.GROUND + DINO_BIRD_HEIGHTS[DINO_BIRD_HEIGHTS.length - 1];
          out.push(spec.id + '@' + sp + '=' + clearWindow(o, sp));
        }
      }
      return JSON.stringify(out);
    })()
  `, sandbox);
  const rows = JSON.parse(raw);
  const bad = rows.filter(s => s.endsWith('=0'));
  if (bad.length) throw new Error('这些障碍在任何时机起跳都过不去：' + bad.join(' / '));
  /* 窗口太窄等于"理论上能过、实际操作不可能"，也要拦 */
  const tight = rows.filter(s => Number(s.split('=')[1]) < 24);
  if (tight.length) throw new Error('起跳窗口窄于 24px（≈0.07s），实际上按不出来：' + tight.join(' / '));
  return rows.join('  ');
});

check('小恐龙：障碍间距大于一次跳跃的水平跨度（落地前不会再来一个）', () => {
  /* 跳跃要求 dinoOnGround。如果下一个障碍在你还悬空时就贴到跟前，
     玩家没有任何操作空间 —— 这不是难度，是必死。 */
  const raw = vm.runInContext(`
    (() => {
      dinoReset(); dinoRunning = true; dinoOver = false;
      const rows = [];
      let lastDist = null;
      for (let i = 0; i < 40000 && rows.length < 200; i++){
        const before = dinoObs.length;
        dinoStep(1/60);
        if (dinoObs.length > before){
          if (lastDist !== null){
            rows.push([Math.round(dinoDist - lastDist), +dinoSpeed.toFixed(1)]);
          }
          lastDist = dinoDist;
        }
        /* 不操作会撞死，撞了就清空继续采数据 —— 这里只关心"间距"这个设计量 */
        if (dinoOver){ dinoOver = false; dinoObs.length = 0; lastDist = null; }
      }
      return JSON.stringify({ rows: rows, jumpV: DINO.JUMP_V, g: DINO.G });
    })()
  `, sandbox);
  const o = JSON.parse(raw);
  if (o.rows.length < 20) throw new Error('只采到 ' + o.rows.length + " 个间距，生成器没在正常工作");
  const airTime = 2 * o.jumpV / o.g;
  const bad = o.rows.filter(([gap, sp]) => gap < sp * airTime);
  if (bad.length){
    const worst = bad.reduce((a, b) => (b[0] - b[1] * airTime < a[0] - a[1] * airTime ? b : a));
    throw new Error(bad.length + '/' + o.rows.length + ' 个间距小于跳跃跨度（' +
                    '最差：间距 ' + worst[0] + 'px，但 ' + worst[1] + 'px/s 时一次跳跃要 ' +
                    Math.round(worst[1] * airTime) + 'px）');
  }
  /* 报告最紧的那一行。**别**拿"全局最小间距"去比"全局最大需求"——
     那两个数来自不同的行（最小间距出在低速、最大需求出在高速），
     比出来的结论看着像结论，其实是假的。 */
  let tightest = null;
  for (const [gap, sp] of o.rows){
    const need = sp * airTime;
    const margin = gap - need;
    if (!tightest || margin < tightest.margin) tightest = { gap, sp, need, margin };
  }
  return '采到 ' + o.rows.length + ' 个间距；最紧一行：' + tightest.gap + 'px 间距 vs ' +
         tightest.sp + 'px/s 需要 ' + Math.round(tightest.need) + 'px（余量 ' +
         Math.round(tightest.margin) + 'px）';
});
check('碰撞检测会判定死亡', () => {
  vm.runInContext(`
    dinoStart();
    dinoObs = [{ kind: 'cactus', x: 26 * DINO.PX, w: 57, h: 74 }];
    dinoStep(1/60);
  `, sandbox);
  if (!vm.runInContext('dinoOver', sandbox)) throw new Error('撞上了却没死');
  return 'GAME OVER 正确触发';
});
check('最高分会写入 state.dinoHigh', () => {
  const h = vm.runInContext('state.dinoHigh', sandbox);
  if (!(h > 0)) throw new Error('最高分没写入，dinoHigh = ' + h);
  return 'dinoHigh = ' + h;
});
check('速度会被上限钳住（不能无限加速）', () => {
  vm.runInContext('dinoStart(); for (let i = 0; i < 4000; i++) dinoStep(1/60);', sandbox);
  const sp = vm.runInContext('dinoSpeed', sandbox);
  const max = vm.runInContext('DINO.SPEED_MAX', sandbox);
  if (sp > max + 0.001) throw new Error('速度超上限：' + sp + ' > ' + max);
  return '速度停在 ' + sp + ' / 上限 ' + max;
});
check('合成键盘事件被拒（不能从外部注入分数）', () => {
  vm.runInContext('dinoStart(); dinoScore = 0; dinoDist = 0;', sandbox);
  for (const code of ['Space', 'ArrowUp', 'KeyW', 'ArrowDown', 'KeyS']){
    dom.fireDoc('keydown', { code, key: code, isTrusted: false });
  }
  const jumped = vm.runInContext('dinoVY !== 0 || !dinoOnGround', sandbox);
  if (jumped) throw new Error('合成事件竟然触发了跳跃');
  vm.runInContext('dinoStop()', sandbox);
  return '合成事件被全部拒绝';
});
check('真实键盘事件能触发跳跃（按键路由是通的）', () => {
  vm.runInContext('dinoOpen(); dinoStart();', sandbox);
  dom.fireDoc('keydown', { code: 'Space', key: ' ', isTrusted: true });
  const up = vm.runInContext('!dinoOnGround && dinoVY > 0', sandbox);
  if (!up) throw new Error('按了空格没起跳');
  return '空格 → 起跳，vY > 0';
});
check('蹲下键按下蹲、松开站起', () => {
  vm.runInContext('dinoStart();', sandbox);
  dom.fireDoc('keydown', { code: 'ArrowDown', key: 'ArrowDown', isTrusted: true });
  if (!vm.runInContext('dinoDuck', sandbox)) throw new Error('按了 ↓ 没蹲下');
  dom.fireDoc('keyup', { code: 'ArrowDown', key: 'ArrowDown', isTrusted: true });
  if (vm.runInContext('dinoDuck', sandbox)) throw new Error('松开 ↓ 还蹲着');
  return '↓ 按下蹲、松开站起';
});
check('关闭桌面 → 回到世界并停掉恐龙', () => {
  vm.runInContext('closeDesktop()', sandbox);
  const v = vm.runInContext('state.view', sandbox);
  if (v !== 'world') throw new Error('view = ' + v);
  if (vm.runInContext('dinoRunning', sandbox)) throw new Error('关窗了恐龙还在跑');
  return 'view = world，恐龙已停';
});

/* ---------------- 鼠标锁定反馈（"鼠标失灵"那个坑的回归测试） ---------------- */
/* 背景：requestPointerLock() 在刚按过 Esc 之后会被浏览器静默拒绝（约 1.25s
   冷却），失败时界面毫无变化，玩家体验就是"鼠标点了没反应"。
   这几条钉住修复：
   ① 未锁定时点画面会去申请锁定，而不是把它当交互吞掉；
   ② 冷却中（申请后超过 settle 仍未锁上）会出现可见提示；
   ③ settle 时间之内不提示 —— 否则每次正常点击都会误报一次。
   注：内部变量（pointerLocked / lastLockTryAt 等）是模块级 let，不是
   sandbox 的属性，所以统一通过 window.__OI__.mouse 读写。 */
check('未锁定时点画面 → 去申请指针锁定，且不触发交互', () => {
  const r = vm.runInContext(`
    (() => {
      state.started = true; state.ended = false; state.view = 'world';
      window.__OI__.mouse.reset();
      window.__OI__.mouse.setLastTry(performance.now() - 999999);
      const el = renderer.domElement;
      let asked = 0, interacted = false;
      const origReq = el.requestPointerLock;
      const origDo = doInteract;
      el.requestPointerLock = function(){ asked++; return undefined; };
      doInteract = function(){ interacted = true; return true; };
      try {
        el.dispatchEvent({ type: 'mousedown', button: 0 });
      } finally {
        el.requestPointerLock = origReq;
        doInteract = origDo;
      }
      return { asked: asked, interacted: interacted, view: state.view,
               handlers: el.__handlerCount ? el.__handlerCount('mousedown') : -1 };
    })()
  `, sandbox);
  /* handlers 为 0 说明 main.js 的事件根本没挂上 —— 那这条测试就是空跑 */
  if (r.handlers === 0) throw new Error('main.js 的 mousedown 监听器没挂到 domElement 上，测试空跑');
  if (r.asked < 1) throw new Error('未锁定时点击没有申请指针锁定（asked=' + r.asked + '）');
  if (r.interacted) throw new Error('未锁定时竟然执行了交互 —— 这正是"点了没反应但状态已变"的来源');
  if (r.view !== 'world') throw new Error('未锁定时点击把视图改了：' + r.view);
  return '申请锁定 ' + r.asked + ' 次，未触发交互';
});
/* 有弹窗时点画面 = 点弹窗按钮。
   这是"鼠标失灵"那条 bug 的另一半：弹窗自己声明可以用鼠标点按钮，
   但点击在 onPrimaryDown 最前面就被 return 吞了。
   断言链路要一路走到底 —— 从 mousedown 事件到弹窗真的消失。 */
check('有弹窗时点画面 → 触发弹窗按钮，弹窗关闭', () => {
  const r = vm.runInContext(`
    (() => {
      state.started = true; state.ended = false; state.view = 'world';
      state.passedSecurity = false;
      dismissDialogs();
      window.__OI__.mouse.reset();
      doSecurityCheck();
      if (!dialogs.length) return { err: '安检没弹出窗，前置条件不成立' };

      /* 把准星/光标位置伪造到"第 1 个按钮上"：
         dlgHoverBtn 由 updateDialogs 每帧算出，这里直接放好再派发点击，
         等价于玩家把鼠标停在按钮上按下左键。 */
      const dlg = dialogs[dialogs.length - 1];
      dlg.buttons = dlg.buttons.length ? dlg.buttons : [{ x:0, y:0, w:10, h:10, label:'x' }];
      dlgHoverBtn = { dlg: dlg, idx: 0 };

      const el = renderer.domElement;
      const origReq = el.requestPointerLock;
      el.requestPointerLock = function(){ return undefined; };
      try {
        el.dispatchEvent({ type: 'mousedown', button: 0 });
      } finally {
        el.requestPointerLock = origReq;
      }
      return { closed: !hasDialog(), left: dialogs.length, passed: state.passedSecurity };
    })()
  `, sandbox);
  if (r.err) throw new Error(r.err);
  if (!r.closed) throw new Error('点了画面，弹窗还在（剩 ' + r.left + ' 个）—— 鼠标被吞掉了');
  if (!r.passed) throw new Error('弹窗关掉了但选项回调没执行');
  return '点击 → 按钮触发 → 弹窗关闭';
});
/* 用鼠标"提前"关掉弹窗（进度环还没走满）时，进度环必须跟着消失。
   这是"那个圆圈一直停在屏幕上"的直接复现。
   根因：清进度只写在 closeDialog 的"关掉的正好是当前悬停弹窗"分支里，
   但点鼠标走的是 activateDialogButton()，它**先把 dlgHoverBtn 置空**再调回调 ——
   回调里再 closeDialog 时 `dlgHoverBtn.dlg === dlg` 恒为假，于是永远清不掉。
   而"下一帧 updateDialogs 兜底"也不成立：main.js 里它被 if (dialogs.length)
   挡着，弹窗一关就再也不跑。
   为什么按"视线停留"正常走完不会复现：那条路径在进度满格时自己
   `dwellProgress = 0` 了。只有提前打断才留下半格 —— 所以叫"提前"。 */
check('鼠标提前关掉弹窗后，准星外的停留进度环必须消失', () => {
  const r = vm.runInContext(`
    (() => {
      state.started = true; state.ended = false; state.view = 'world';
      state.passedSecurity = false;
      dismissDialogs();
      window.__OI__.mouse.reset();
      doSecurityCheck();
      if (!dialogs.length) return { err: '安检没弹出窗，前置条件不成立' };

      const dlg = dialogs[dialogs.length - 1];
      dlg.buttons = dlg.buttons.length ? dlg.buttons : [{ x:0, y:0, w:10, h:10, label:'x' }];
      dlgHoverBtn = { dlg: dlg, idx: 0 };
      /* 造出"视线停了一半就点鼠标"的状态 —— 这正是玩家描述的场景 */
      dwellProgress = 0.5;
      dwellKey = dlg.id + ':0';
      const before = dialogDwell().progress;

      const el = renderer.domElement;
      const origReq = el.requestPointerLock;
      el.requestPointerLock = function(){ return undefined; };
      try { el.dispatchEvent({ type: 'mousedown', button: 0 }); }
      finally { el.requestPointerLock = origReq; }

      /* 故意不跑任何一帧：修好之前这里只能靠"下一帧 updateDialogs"兜底，
         而那个兜底根本不会被调用。 */
      const afterClick = dialogDwell().progress;
      updateReticle(1/60);
      return { before: before, afterClick: afterClick, closed: !hasDialog(),
               reticleVisible: reticle.visible, ringVisible: retRing.visible,
               progress: dialogDwell().progress };
    })()
  `, sandbox);
  if (r.err) throw new Error(r.err);
  if (r.before <= 0.002) throw new Error('前置条件不成立：进度没造出来（' + r.before + '）');
  if (!r.closed) throw new Error('弹窗没关，后面的断言没意义');
  if (r.afterClick > 0.002)
    throw new Error('弹窗关了但停留进度还留着 ' + r.afterClick + ' —— 进度环会一直挂在屏幕上');
  /* 准星本身隐藏时 retRing.visible 必然 false，那样这条断言会"假过" */
  if (!r.reticleVisible)
    throw new Error('前置条件不成立：准星是隐藏的，进度环必然为 false，断言会假过');
  if (r.ringVisible)
    throw new Error('弹窗关了，准星外的进度环还亮着（progress=' + r.progress + '）');
  return '进度 ' + r.before + ' → 关窗后 ' + r.afterClick + '，进度环已消失';
});
check('点画面只认左键（右键/中键不该申请锁定）', () => {
  const asked = vm.runInContext(`
    (() => {
      state.started = true; state.ended = false; state.view = 'world';
      window.__OI__.mouse.reset();
      window.__OI__.mouse.setLastTry(performance.now() - 999999);
      let n = 0;
      const el = renderer.domElement;
      const origReq = el.requestPointerLock;
      el.requestPointerLock = function(){ n++; return undefined; };
      try {
        el.dispatchEvent({ type: 'mousedown', button: 2 });
        el.dispatchEvent({ type: 'mousedown', button: 1 });
      } finally { el.requestPointerLock = origReq; }
      return n;
    })()
  `, sandbox);
  if (asked !== 0) throw new Error('右键/中键竟然申请了锁定 ' + asked + ' 次');
  return '右键与中键被忽略';
});
check('锁定冷却中会给出可见提示（而不是静默）', () => {
  const msg = vm.runInContext(`
    (() => {
      state.started = true; state.ended = false; state.view = 'world';
      window.__OI__.mouse.clearToasts();
      window.__OI__.mouse.reset();
      window.__OI__.mouse.setLastTry(performance.now() - 999999);   /* 早已超过 settle */
      window.__OI__.mouse.watchLockHint();
      return window.__OI__.mouse.lastToast();
    })()
  `, sandbox);
  if (!/未锁定/.test(msg)) throw new Error('冷却中没有提示，消息="' + msg + '"');
  return msg.slice(0, 26);
});
check('刚点完的 settle 时间内不误报提示', () => {
  const msg = vm.runInContext(`
    (() => {
      state.started = true; state.ended = false; state.view = 'world';
      window.__OI__.mouse.clearToasts();
      window.__OI__.mouse.reset();
      window.__OI__.mouse.setLastTry(performance.now());            /* 刚刚才申请 */
      window.__OI__.mouse.watchLockHint();
      return window.__OI__.mouse.lastToast();
    })()
  `, sandbox);
  if (msg) throw new Error('正常点击被误报成失败："' + msg + '"');
  return 'settle 内静默';
});
check('未开始 / 已结束不会打扰玩家', () => {
  const msgs = vm.runInContext(`
    (() => {
      const out = [];
      const shots = [
        { started: false, ended: false },
        { started: true,  ended: true  }
      ];
      for (const s of shots){
        window.__OI__.mouse.clearToasts();
        window.__OI__.mouse.reset();
        window.__OI__.mouse.setHintAt(-999999);            /* 绕开节流，确保测的是状态判定 */
        window.__OI__.mouse.setLastTry(performance.now() - 999999);
        state.started = s.started; state.ended = s.ended; state.view = 'world';
        window.__OI__.mouse.watchLockHint();
        out.push(window.__OI__.mouse.lastToast() || '');
      }
      state.started = true; state.ended = false; state.view = 'world';
      return out;
    })()
  `, sandbox);
  if (msgs.some(m => m)) throw new Error('未开始/已结束却提示了：' + JSON.stringify(msgs));
  return '两种死状态都静默';
});
check('面板里的锁定失败不会立刻弹提示（会攒着回世界再弹）', () => {
  const r = vm.runInContext(`
    (() => {
      state.started = true; state.ended = false;
      window.__OI__.mouse.clearToasts();
      window.__OI__.mouse.reset();
      window.__OI__.mouse.setHintAt(-999999);
      window.__OI__.mouse.setLastTry(performance.now() - 999999);
      state.view = 'pause';
      window.__OI__.mouse.watchLockHint();
      const inPanel = window.__OI__.mouse.lastToast() || '';
      const armed = window.__OI__.mouse.armed();
      state.view = 'world';
      return JSON.stringify({ inPanel: inPanel, armed: armed });
    })()
  `, sandbox);
  const o = JSON.parse(r);
  if (o.inPanel) throw new Error('面板里就弹了提示，会压在菜单上：' + o.inPanel);
  if (!o.armed) throw new Error('没有 arm 起来，回到世界也不会有提示');
  return '面板内静默，已 arm';
});
check('暂停菜单回到考场后，之前被拒的提示会补出来', () => {
  const raw = vm.runInContext(`
    (() => {
      state.started = true; state.ended = false;
      window.__OI__.mouse.clearToasts();
      window.__OI__.mouse.reset();
      /* 先在面板里判定失败：这时不该立刻弹，而是记下来 */
      state.view = 'pause';
      window.__OI__.mouse.setLastTry(performance.now() - 999999);
      window.__OI__.mouse.watchLockHint();
      const inPanel = window.__OI__.mouse.lastToast() || '';
      /* 回到世界：补提示。先清掉节流窗口 —— 真实场景里"被拒"和"点返回"
         之间隔着玩家操作，而测试是同一次调用里连着做的。 */
      state.view = 'world';
      window.__OI__.mouse.setHintAt(-999999);
      flushLockHint();
      return JSON.stringify({ inPanel: inPanel, afterReturn: window.__OI__.mouse.lastToast() });
    })()
  `, sandbox);
  const r = JSON.parse(raw);
  if (r.inPanel) throw new Error('在面板里就弹了提示，会压在菜单上');
  if (!/未锁定/.test(r.afterReturn)) throw new Error('回到世界后没有补提示："' + r.afterReturn + '"');
  return '面板内静默 → 返回后提示';
});

/* ============================ 9. 房间行为 ============================ */
console.log('\n== 6. 回到考场后的房间行为 ==');
check('按住 W 前进会被墙/桌挡住（房间边界内）', () => {
  vm.runInContext('switchArea("room"); state.pos.set(0, 1.65, -3);', sandbox);
  const before = vm.runInContext('JSON.stringify([+state.pos.x.toFixed(2), +state.pos.z.toFixed(2)])', sandbox);
  vm.runInContext('state.keys.w = true; for (let i = 0; i < 400; i++) animate(); state.keys.w = false;', sandbox);
  const after = vm.runInContext('JSON.stringify([+state.pos.x.toFixed(2), +state.pos.z.toFixed(2)])', sandbox);
  const inside = vm.runInContext(
    'Math.abs(state.pos.x) <= state.bounds.x + 0.001 && ' +
    'state.pos.z >= state.bounds.zMin - 0.001 && state.pos.z <= state.bounds.zMax + 0.001', sandbox);
  if (!inside) throw new Error('走到墙外了：' + after);
  return before + ' → ' + after;
});
check('跳跃能起跳并落回地面', () => {
  /* 这里不能用 animate() 的循环来推进：main.js 用 clock.getDelta()，而桩里
    那个 Clock 读的是真实墙上时间。测试循环跑得比真实时间快，
    每帧 dt 极小，跳跃永远走不完 —— 表现为"5 次里偶发失败一次"的抖动。
     直接喂一个确定性的 dt 才是在测物理，而不是在测机器速度。 */
  vm.runInContext(`
    tryJump();
    for (let i = 0; i < 400 && !onGround; i++) updateJump(1/60);
  `, sandbox);
  const y = vm.runInContext('jumpY', sandbox);
  if (Math.abs(y) > 0.001) throw new Error('没落回地面，jumpY = ' + y);
  if (!vm.runInContext('onGround', sandbox)) throw new Error('onGround 没复位');
  return 'jumpY 归零，onGround = true';
});
check('跳跃高度符合设计（约 1.0m）', () => {
  const peak = vm.runInContext(`
    tryJump();
    let hi = 0;
    for (let i = 0; i < 400 && !onGround; i++){ updateJump(1/120); if (jumpY > hi) hi = jumpY; }
    hi;
  `, sandbox);
  if (!(peak > 0.7 && peak < 1.4)) throw new Error('跳高 ' + peak.toFixed(2) + 'm，偏离设计值');
  return '峰值 ' + peak.toFixed(2) + ' m';
});
check('校园里打不到监考老师（区域隔离）', () => {
  /* 用 switchArea 切换，而不是直接改 state.area —— 那样会把 area 和 bounds
     弄成不一致的状态（area=campus 但 bounds 还是房间的），
     后面基于 bounds 的断言就会得出错误结论。*/
  const r = vm.runInContext(`
    switchArea("campus");
    state.pos.x = teacher.group.position.x;
    state.pos.z = teacher.group.position.z;
    state.yaw = 0;
    updateInteract();
    actionSpace === null;
  `, sandbox);
  vm.runInContext('switchArea("room");', sandbox);
  if (!r) throw new Error('校园里竟然能对老师出拳');
  return '校园内 actionSpace = null';
});
check('走廊里能打保安（保安会追出门）', () => {
  /* 之前 updateInteract 对 hall1/hall2 直接 hallInteract() + return，
     保安出拳判定只覆盖房间 —— 结果保安追到走廊里，左键完全没反应。
     这条把"走廊里保安在拳锋内 → actionSpace 必须给出拳"钉住。 */
  const r = vm.runInContext(`
    (() => {
      const saved = { area: state.area, px: state.pos.x, pz: state.pos.z, yaw: state.yaw };
      const savedG = securityGuards.slice(), savedS = state.guardsSpawned;
      let out = null, tempGuard = null;
      try {
        securityGuards.length = 0;
        state.guardsSpawned = 0;
        switchArea('hall1');
        state.pos.set(10.5, 1.65, 0);
        state.yaw = 0; yawTarget = 0;          /* 面朝 -Z */
        tempGuard = buildSecurityGuard(10.5, -1.2);
        tempGuard.userData = { speed: 1, alive: true, blink: 0 };
        securityGuards.push(tempGuard);
        updateInteract();
        out = { area: state.area, hasSpace: !!actionSpace,
                prompt: String(promptEl.textContent || '').slice(0, 14) };
      } finally {
        if (tempGuard) scene.remove(tempGuard.group);
        securityGuards.length = 0;
        savedG.forEach(g => securityGuards.push(g));
        state.guardsSpawned = savedS;
        switchArea(saved.area);
        state.pos.x = saved.px; state.pos.z = saved.pz;
        state.yaw = saved.yaw; yawTarget = saved.yaw;
      }
      return out;
    })()
  `, sandbox);
  if (r.area !== 'hall1') throw new Error('没切到走廊：' + r.area);
  if (!r.hasSpace) throw new Error('走廊里保安在拳锋内，actionSpace 却是 null（左键无反应）');
  if (!/出拳|抡/.test(r.prompt)) throw new Error('提示不对：' + r.prompt);
  return 'hall1 · actionSpace = 出拳 · ' + r.prompt;
});
check('保安不穿门：关着的门挡住保安，走近会自己开门', () => {
  const r = vm.runInContext(`
    (() => {
      const saved = { area: state.area, px: state.pos.x, pz: state.pos.z };
      const savedG = securityGuards.slice(), savedS = state.guardsSpawned;
      let door = null, tempGuard = null;
      const out = {};
      try {
        securityGuards.length = 0; state.guardsSpawned = 0;
        switchArea('hall1');
        door = classroomDoors.find(d => d.name === '404');
        if (!door) return { err: '找不到 404 门' };
        setDoorOpen(door, false);                 /* 先确保门是关着的 */
        out.blockedWhenClosed = guardCollides(7.9, 0, 0.3);   /* 门口（走廊西墙 x=8） */
        tempGuard = buildSecurityGuard(10.5, 0);
        tempGuard.userData = { speed: 1, alive: true, blink: 0 };
        securityGuards.push(tempGuard);
        tryGuardOpenDoor(9.0, 0);                 /* 保安贴近门 → 自己开 */
        out.stateAfter = door.state;
        out.blockedAfterOpen = guardCollides(7.9, 0, 0.3);
      } finally {
        if (door) setDoorOpen(door, false);
        if (tempGuard) scene.remove(tempGuard.group);
        securityGuards.length = 0;
        savedG.forEach(g => securityGuards.push(g));
        state.guardsSpawned = savedS;
        switchArea(saved.area);
        state.pos.x = saved.px; state.pos.z = saved.pz;
      }
      return out;
    })()
  `, sandbox);
  if (r.err) throw new Error(r.err);
  if (!r.blockedWhenClosed)
    throw new Error('门关着时，门口（x=7.9）居然不挡保安 —— 保安会穿门');
  if (r.stateAfter !== 'open') throw new Error('保安贴近关着的门却没开门：' + r.stateAfter);
  if (r.blockedAfterOpen) throw new Error('门开了门口还挡着 —— 关门碰撞没撤掉');
  return '关门挡 · 走近开门 · 开门放行';
});
check('终局在门外也能完成：走廊里按 E 走进白光', () => {
  const r = vm.runInContext(`
    (() => {
      state.started = true; state.ended = false; state.frozen = false; state.view = 'world';
      dismissDialogs();
      switchArea('hall1');
      state.doorOpen = true;
      doorOpenT = 0;                            /* 让 aimingAtWhiteLight 直接短路，不射线 */
      state.pos.set(8.6, 1.65, 0);              /* 门外：走廊西侧、正对门 */
      updateInteract();
      const near = { hasE: !!actionE, fn: actionE && actionE.fn.name,
                     prompt: String(promptEl.textContent || '') };
      state.pos.set(10.5, 1.65, 5);              /* 走廊里但离门远 */
      updateInteract();
      const far = { hasE: !!actionE };
      state.doorOpen = false; doorOpenT = 0;
      switchArea('room');
      return { near: near, far: far };
    })()
  `, sandbox);
  if (!r.near.hasE || r.near.fn !== 'walkOutOfTheRoom')
    throw new Error('门外（x=8.6）没有"走进白光"的通关动作：' + JSON.stringify(r.near));
  if (!/白光/.test(r.near.prompt)) throw new Error('门外提示不对：' + r.near.prompt);
  if (r.far.hasE) throw new Error('离门很远却触发了通关动作');
  return '门外 = 走进白光 · 远处不触发';
});
check('交互提示会刷新', () => {
  vm.runInContext('updateInteract()', sandbox);
  return 'prompt = ' + vm.runInContext('promptEl.textContent', sandbox).slice(0, 20);
});

/* ============================ 10. IDE / 提交 ============================ */
console.log('\n== 7. IDE / 提交 ==');
check('打开电脑面板', () => {
  vm.runInContext('openCode()', sandbox);
  if (vm.runInContext('state.view', sandbox) !== 'code') throw new Error('view 不是 code');
  return 'view = code';
});
check('显示器交互打开的是桌面（不是直接跳 IDE）', () => {
  /* interactables 里第一个不一定是显示器（实测是水杯"喝水"），
     所以按 label 找，不按下标找。这条测的是"桌面 → 文件夹 → 题目"这条路真的通：
     桌上显示器的 interact 动作应该是 openDesktop，而不是直接 openCode。 */
  const label = vm.runInContext(`
    (() => {
      const f = interactables.find(o => o.userData && o.userData.interact &&
                                        /桌面|CSP-S114514/.test(o.userData.interact.label));
      return f ? f.userData.interact.label : '';
    })()
  `, sandbox);
  if (!label) throw new Error('在 interactables 里找不到指向桌面的交互项');
  vm.runInContext('openDesktop()', sandbox);
  if (vm.runInContext('state.view', sandbox) !== 'launcher') throw new Error('没进桌面');
  vm.runInContext('closeDesktop(); openCode();', sandbox);
  return label.slice(0, 22);
});
check('语法高亮不破坏 HTML', () => {
  vm.runInContext('codeArea.value = "int main() { /* <b> */ return 0; } // <script>"; hlRender(codeArea.value);', sandbox);
  return 'hlRender 正常返回';
});
check('提交会写回 state.score', () => {
  vm.runInContext('state.code[state.curProb] = state.problems[0].starter; codeArea.value = state.code[state.curProb]; submitCode();', sandbox);
  const sc = vm.runInContext('state.score[state.curProb]', sandbox);
  if (sc === undefined) throw new Error('score 未写入');
  return '得分 ' + sc;
});
check('离开电脑', () => {
  vm.runInContext('closeCode()', sandbox);
  return 'view = ' + vm.runInContext('state.view', sandbox);
});

/* ============================ 11. 老师 / 保安 / 血条 ============================ */
console.log('\n== 8. 打老师 → 保安 → 血条 ==');
check('打监考老师会触发保安与血条', () => {
  vm.runInContext(`
    state.pos.x = teacher.group.position.x + 1.2;
    state.pos.z = teacher.group.position.z;
    state.yaw = Math.atan2(-(teacher.group.position.x - state.pos.x), -(teacher.group.position.z - state.pos.z));
    punchTeacher();
  `, sandbox);
  const guards = vm.runInContext('securityGuards.length', sandbox);
  const hpShown = vm.runInContext('state.hpVisible', sandbox);
  if (guards <= 0) throw new Error('没生成保安');
  if (!hpShown) throw new Error('血条没显示');
  return '保安 ' + guards + ' 名，血条已显示';
});
check('保安会朝玩家移动（位置真的变了）', () => {
  /* 保安的移动带障碍滑动（guards.js 里用 if (!collides(...)) 分轴放行），
     随机角度把保安刷在课桌紧贴着的位置时，它可能原地卡住 —— 真实的滑墙行为。
     所以这里把保安**放到一个确定的位置**（与玩家同处空旷地带），
     测的是"AI 会不会朝玩家走"，而不是"随机生成的方位会不会撞上桌子"。
     obstacles 用 try/finally 保证一定还原：否则一旦中途抛错，
     后面的测试会带着一个损坏的障碍表跑，失败会串到完全无关的断言上
     （实测这个坑把"读档后位置合法"那条也带崩了）。 */
  const r = vm.runInContext(`
    (() => {
      const saved = obstacles.slice();
      try {
        obstacles.length = 0;
        state.pos.x = SEAT_CENTER_X; state.pos.z = SEAT_CENTER_Z;
        const ang = Math.PI * 0.25;
        securityGuards[0].group.position.set(
          state.pos.x + Math.cos(ang) * 5, 0, state.pos.z + Math.sin(ang) * 5);
        const d0 = Math.hypot(state.pos.x - securityGuards[0].group.position.x,
                              state.pos.z - securityGuards[0].group.position.z);
        for (let i = 0; i < 120; i++) updateGuards(1/60, i/60);
        const d1 = Math.hypot(state.pos.x - securityGuards[0].group.position.x,
                              state.pos.z - securityGuards[0].group.position.z);
        return { d0: +d0.toFixed(3), d1: +d1.toFixed(3) };
      } finally {
        obstacles.length = 0; saved.forEach(o => obstacles.push(o));
      }
    })()
  `, sandbox);
  if (!(r.d1 < r.d0 - 0.2)) throw new Error('2 秒内只缩短了 ' + (r.d0 - r.d1).toFixed(3) + ' m，保安没靠近');
  return r.d0 + ' → ' + r.d1 + '（2 s）';
});
check('保安的移动速率符合设定（清空障碍后测纯速度）', () => {
  /* 清空障碍是刻意的：这一项测的是"速度参数有没有接上"，
     不是"寻路避障做得好不好"。两者分开测，失败时才知道该查哪儿。
     同样用 try/finally 保证障碍表还原。 */
  const r = vm.runInContext(`
    (() => {
      const saved = obstacles.slice();
      try {
        obstacles.length = 0;
        securityGuards.forEach(g => { g.group.position.set(state.pos.x + 6, 0, state.pos.z + 6); });
        const d0 = Math.hypot(state.pos.x - securityGuards[0].group.position.x,
                              state.pos.z - securityGuards[0].group.position.z);
        for (let i = 0; i < 60; i++) updateGuards(1/60, i/60);
        const d1 = Math.hypot(state.pos.x - securityGuards[0].group.position.x,
                              state.pos.z - securityGuards[0].group.position.z);
        return { d0: +d0.toFixed(3), d1: +d1.toFixed(3), speed: securityGuards[0].userData.speed };
      } finally {
        obstacles.length = 0; saved.forEach(o => obstacles.push(o));
      }
    })()
  `, sandbox);
  if (!(r.d1 < r.d0 - 0.4)) throw new Error('1 秒内只缩短了 ' + (r.d0 - r.d1).toFixed(3) + ' m，速度参数没生效');
  return r.d0 + ' → ' + r.d1 + '（1 s，速度 ' + r.speed.toFixed(2) + '）';
});
check('保安数量不会超过上限', () => {
  vm.runInContext('for (let i = 0; i < 300; i++) spawnTwoGuards();', sandbox);
  const n = vm.runInContext('securityGuards.length', sandbox);
  const max = vm.runInContext('GUARD_MAX_TOTAL', sandbox);
  if (n > max) throw new Error('保安 ' + n + ' 名，超过上限 ' + max);
  return n + ' / ' + max;
});

/* ============================ 背包 / 物品栏 ============================ */
console.log('\n== 8.5 背包 · 物品栏 · 臭水 ==');
check('开局配发：臭水 3 / 矿泉水 2 / 辣条 2，摆在快捷栏前 3 格', () => {
  const o = JSON.parse(vm.runInContext(`JSON.stringify((() => {
    initBag();
    return { stink: bagCount('stink'), water: bagCount('water'), spicy: bagCount('spicy'),
             hotbar: state.hotbar.join(','), idx: state.hotbarIdx,
             kinds: state.bag.map(e => e.id).join(',') };
  })())`, sandbox));
  if (o.stink !== 3 || o.water !== 2 || o.spicy !== 2)
    throw new Error('配发数量不对：臭水 ' + o.stink + ' / 矿泉 ' + o.water + ' / 辣条 ' + o.spicy);
  if (o.hotbar !== 'stink,water,spicy,')
    throw new Error('快捷栏摆位不对：[' + o.hotbar + ']');
  if (o.idx !== 0) throw new Error('默认选中的不是第 1 格：' + o.idx);
  return o.kinds + '  →  快捷栏 [' + o.hotbar + ']';
});
check('用掉一个物品：数量恰好 -1，格子和选中状态都不动', () => {
  const o = JSON.parse(vm.runInContext(`JSON.stringify((() => {
    const savedView = state.view, savedEnded = state.ended, savedFrozen = state.frozen;
    try {
      initBag();
      state.view = 'world'; state.ended = false; state.frozen = false;
      state.hotbarIdx = 0;
      const before = bagCount('stink');
      const used = useSelectedItem();
      return { before: before, after: bagCount('stink'), used: used,
               slot: state.hotbar[0], idx: state.hotbarIdx };
    } finally { state.view = savedView; state.ended = savedEnded; state.frozen = savedFrozen; }
  })())`, sandbox));
  if (!o.used) throw new Error('useSelectedItem() 说没用到');
  if (o.after !== o.before - 1) throw new Error('数量没变化：' + o.before + ' → ' + o.after);
  if (o.slot !== 'stink') throw new Error('用掉一个就把格子清了（还剩的时候不该清）：[' + o.slot + ']');
  if (o.idx !== 0) throw new Error('用一次就换了选中格：' + o.idx);
  return o.before + ' → ' + o.after + '，格子仍是 [' + o.slot + ']';
});
check('用光最后一瓶 → 快捷栏格子自动清空（不留按不出来的空槽）', () => {
  const o = JSON.parse(vm.runInContext(`JSON.stringify((() => {
    const savedView = state.view, savedEnded = state.ended, savedFrozen = state.frozen;
    try {
      initBag();
      state.view = 'world'; state.ended = false; state.frozen = false;
      state.hotbarIdx = 0;
      bagTake('stink', 2);                    /* 先花掉 2，只剩 1 */
      const mid = state.hotbar[0];
      const used = useSelectedItem();          /* 用掉最后 1 个 */
      return { mid: mid, used: used, count: bagCount('stink'),
               slot: state.hotbar[0], stillInBag: state.bag.some(e => e.id === 'stink') };
    } finally { state.view = savedView; state.ended = savedEnded; state.frozen = savedFrozen; }
  })())`, sandbox));
  if (o.mid !== 'stink') throw new Error('还剩 1 个时格子就已经空了：[' + o.mid + ']');
  if (!o.used) throw new Error('最后一个用不掉');
  if (o.count !== 0) throw new Error('数量应为 0，实际 ' + o.count);
  if (o.slot !== '') throw new Error('用光了格子还占着，按 Q 会打到空槽：[' + o.slot + ']');
  if (o.stillInBag) throw new Error('数量归零的条目还留在背包列表里');
  return '剩 1 个仍可用 → 用光后格子转为空、条目移出背包';
});
check('臭水真的熏晕保安：干呕期间既不靠近也不扣血', () => {
  const o = JSON.parse(vm.runInContext(`JSON.stringify((() => {
    const savedObst = obstacles.slice();
    const savedGuards = securityGuards.slice();
    const saved = { x: state.pos.x, z: state.pos.z, yaw: state.yaw, pitch: state.pitch,
                    view: state.view, ended: state.ended, frozen: state.frozen, hp: state.hp };
    try {
      obstacles.length = 0;
      state.view = 'world'; state.ended = false; state.frozen = false;
      initBag();
      state.pos.x = SEAT_CENTER_X; state.pos.z = SEAT_CENTER_Z;
      state.yaw = 0; state.pitch = 0;
      /* 一名保安摆在正前方 3 米：落在臭水投掷落点（5m）周围 2.6m 的圈里 */
      securityGuards.length = 1;
      securityGuards[0].userData.alive = true;
      securityGuards[0].userData.stinkUntil = 0;
      securityGuards[0].group.position.set(state.pos.x, 0, state.pos.z - 3);
      const d0 = Math.hypot(state.pos.x - securityGuards[0].group.position.x,
                            state.pos.z - securityGuards[0].group.position.z);
      const used = useSelectedItem();
      const stunned = (securityGuards[0].userData.stinkUntil || 0) > state.worldTime;
      const hp0 = state.hp;
      for (let i = 0; i < 60; i++) updateGuards(1/60, i/60);
      const d1 = Math.hypot(state.pos.x - securityGuards[0].group.position.x,
                            state.pos.z - securityGuards[0].group.position.z);
      return { used: used, stunned: stunned, d0: +d0.toFixed(2), d1: +d1.toFixed(2),
               hpSame: state.hp === hp0 };
    } finally {
      obstacles.length = 0; savedObst.forEach(o => obstacles.push(o));
      securityGuards.length = 0; savedGuards.forEach(g => securityGuards.push(g));
      state.pos.x = saved.x; state.pos.z = saved.z;
      state.yaw = saved.yaw; state.pitch = saved.pitch;
      state.view = saved.view; state.ended = saved.ended; state.frozen = saved.frozen;
      state.hp = saved.hp;
    }
  })())`, sandbox));
  if (!o.used) throw new Error('臭水没扔出去');
  if (!o.stunned) throw new Error('保安没被熏到（userData.stinkUntil 没设上）');
  if (!(o.d1 >= o.d0 - 0.05))
    throw new Error('熏晕期间保安还在靠近：' + o.d0 + ' → ' + o.d1 + ' m');
  if (!o.hpSame) throw new Error('站在 3 米外的保安把人扣血了');
  return '干呕标记已设 · 1 秒内距离 ' + o.d0 + ' → ' + o.d1 + ' m（没靠近）· 未扣血';
});
check('矿泉水：血满时不消耗，掉了血才回一格', () => {
  const o = JSON.parse(vm.runInContext(`JSON.stringify((() => {
    const saved = { view: state.view, ended: state.ended, frozen: state.frozen, hp: state.hp };
    try {
      initBag();
      state.view = 'world'; state.ended = false; state.frozen = false;
      state.hpVisible = true;
      state.hotbarIdx = 1;                    /* 第 2 格 = 矿泉水 */
      state.hp = HP_MAX;
      const full = useSelectedItem();          /* 血满 → 不该消耗 */
      const afterFull = bagCount('water');
      state.hp = HP_MAX - 1;
      const healed = useSelectedItem();        /* 掉血 → 回一格并消耗 */
      return { full: full, afterFull: afterFull, healed: healed,
               hp: state.hp, afterHeal: bagCount('water'), max: HP_MAX };
    } finally {
      state.view = saved.view; state.ended = saved.ended; state.frozen = saved.frozen;
      state.hp = saved.hp;
    }
  })())`, sandbox));
  if (o.full) throw new Error('血是满的还把矿泉水喝了（白扔玩家一瓶）');
  if (o.afterFull !== 2) throw new Error('血满时数量也被扣了：剩 ' + o.afterFull);
  if (!o.healed) throw new Error('掉了血喝矿泉水没生效');
  if (o.hp !== o.max) throw new Error('血没回到满：' + o.hp + '/' + o.max);
  if (o.afterHeal !== 1) throw new Error('回血后剩下的数量不对：' + o.afterHeal);
  return '血满=不消耗（剩 ' + o.afterFull + '）· 掉血=回满并消耗（剩 ' + o.afterHeal + '）';
});
check('辣条：只加疾走，走路速度不变（描述和实现必须一致）', () => {
  const o = JSON.parse(vm.runInContext(`JSON.stringify((() => {
    const savedObst = obstacles.slice();
    const savedKeys = state.keys;
    const saved = { x: state.pos.x, z: state.pos.z, yaw: state.yaw,
                    view: state.view, ended: state.ended, frozen: state.frozen,
                    spicy: state.spicyUntil, wt: state.worldTime };
    function run(keys, spicy){
      state.pos.x = SEAT_CENTER_X; state.pos.z = SEAT_CENTER_Z; state.yaw = 0;
      state.keys = keys;
      state.spicyUntil = spicy;
      const x0 = state.pos.x, z0 = state.pos.z;
      updatePlayer(1/60);
      return +Math.hypot(state.pos.x - x0, state.pos.z - z0).toFixed(6);
    }
    try {
      obstacles.length = 0;
      state.view = 'world'; state.ended = false; state.frozen = false;
      state.worldTime = 100;
      const walk  = run({ w: true }, 0);
      const sprint = run({ w: true, shift: true }, 0);
      const buffed = run({ w: true, shift: true }, 999);   /* 辣条生效中 */
      const walkBuffed = run({ w: true }, 999);            /* 走路不该变 */
      return { walk: walk, sprint: sprint, buffed: buffed, walkBuffed: walkBuffed,
               boost: SPICY_BOOST, sprintSpeed: SPRINT_SPEED };
    } finally {
      obstacles.length = 0; savedObst.forEach(o => obstacles.push(o));
      state.keys = savedKeys;
      state.pos.x = saved.x; state.pos.z = saved.z; state.yaw = saved.yaw;
      state.view = saved.view; state.ended = saved.ended; state.frozen = saved.frozen;
      state.spicyUntil = saved.spicy; state.worldTime = saved.wt;
    }
  })())`, sandbox));
  const expectSprint = o.sprintSpeed / 60;
  if (Math.abs(o.sprint - expectSprint) > 1e-4)
    throw new Error('疾走每秒位移不对：' + o.sprint + '，应约 ' + expectSprint.toFixed(6));
  if (Math.abs(o.buffed - o.sprint * o.boost) > 1e-4)
    throw new Error('辣条的加速没生效：' + o.buffed + '，应约 ' + (o.sprint * o.boost).toFixed(6));
  if (Math.abs(o.walkBuffed - o.walk) > 1e-6)
    throw new Error('辣条把走路也加速了（描述说的是疾走）：' + o.walk + ' → ' + o.walkBuffed);
  return '走 ' + (o.walk * 60).toFixed(2) + ' · 疾走 ' + (o.sprint * 60).toFixed(2) +
         ' · 吃辣条疾走 ' + (o.buffed * 60).toFixed(2) + ' m/s（走路未变）';
});


check('用光一摞再捡到同种东西：要同时进背包**并且**回到快捷栏', () => {
  /* 这条是玩家实测报上来的：打死保安掉了一瓶臭水，提示说"捡到了"，
     物品栏里却是空的。原因是用光最后一瓶时 bagTake 把格子清空了，
     而 bagAdd 只会往背包里塞，从不填回快捷栏 ——
     东西在（bagIds 里有），但看不见、按 Q 也只得到"这一格是空的"。 */
  const o = JSON.parse(vm.runInContext(`JSON.stringify((() => {
    const saved = { view: state.view, ended: state.ended, frozen: state.frozen,
                    started: state.started, area: state.area,
                    x: state.pos.x, z: state.pos.z };
    try {
      state.view = 'world'; state.ended = false; state.frozen = false;
      state.started = true; state.area = 'room';
      initBag();
      pickups.length = 0; pickupsPlaced = true;
      state.hotbarIdx = 0;
      for (let i = 0; i < 3; i++) useSelectedItem();      /* 用光 3 瓶臭水 */
      const afterUse = { count: bagCount('stink'), slot: state.hotbar[0] };

      addPickup('stink', state.pos.x, state.pos.z, 1);
      updatePickups(1/60, 0);                             /* 走过去捡起来 */

      const afterPick = { count: bagCount('stink'),
                          onBar: state.hotbar.indexOf('stink') >= 0,
                          idx: state.hotbar.indexOf('stink'),
                          slot0: state.hotbar[0],
                          ground: pickups.length,
                          inBag: state.bag.some(e => e.id === 'stink' && e.n > 0) };
      return { afterUse: afterUse, afterPick: afterPick };
    } finally {
      state.view = saved.view; state.ended = saved.ended; state.frozen = saved.frozen;
      state.started = saved.started; state.area = saved.area;
      state.pos.x = saved.x; state.pos.z = saved.z;
      pickups.length = 0;
    }
  })())`, sandbox));

  if (o.afterUse.count !== 0) throw new Error('前置条件不对：臭水还剩 ' + o.afterUse.count);
  if (o.afterUse.slot !== '') throw new Error('前置条件不对：用光之后格子没清空');
  if (o.afterPick.count !== 1) throw new Error('捡到之后背包数量应为 1，实际 ' + o.afterPick.count);
  if (!o.afterPick.inBag) throw new Error('捡到之后背包里没有这件东西');
  if (!o.afterPick.onBar)
    throw new Error('捡到了但没回到快捷栏（格子 ' + o.afterPick.slot0 + '）—— 玩家看见提示却找不到东西');
  if (o.afterPick.ground !== 0) throw new Error('地上的补给没消失，还剩 ' + o.afterPick.ground);
  return '用光后格子清空 → 捡到 1 瓶 → 自动回到第 ' + (o.afterPick.idx + 1) + ' 格';
});
check('快捷栏永远给新捡到的东西留着一格（4 格 / 3 种物品，永不重复）', () => {
  /* 这条守的是不变式，比"没格子了怎么办"更根本：
     物品只有 3 种、快捷栏 4 格、而且同一种物品只占一格 ——
     所以正常玩到不了"满了"那个状态。真要写"按 B 装上去"的提示，
     说明不变式已经破了，那才是该修的地方。 */
  const o = JSON.parse(vm.runInContext(`JSON.stringify((() => {
    const saved = { view: state.view, ended: state.ended, frozen: state.frozen,
                    started: state.started, area: state.area,
                    x: state.pos.x, z: state.pos.z };
    try {
      state.view = 'world'; state.ended = false; state.frozen = false;
      state.started = true; state.area = 'room';
      initBag();
      pickups.length = 0; pickupsPlaced = true;
      state.pos.x = 0; state.pos.z = 0;

      /* 一局打到底：三种物品全部用光，格子全部清空 */
      for (const id of ['stink', 'water', 'spicy']) bagTake(id, bagCount(id));
      const emptied = state.hotbar.join(',');

      /* 再一个一个捡回来，看每次能不能都挂上去 */
      const placed = {};
      for (const id of ['stink', 'water', 'spicy']){
        addPickup(id, 0, 0, 1);
        updatePickups(1/60, 0);
        placed[id] = state.hotbar.indexOf(id);
      }
      return { emptied: emptied, placed: placed, bar: state.hotbar.join(','),
               free: state.hotbar.filter(x => !x).length,
               dup: state.hotbar.filter((x, i, a) => x && a.indexOf(x) !== i).length,
               /* 只数"能在地上捡到"的种类：keep 的物品（手机）是开局配发的，
                  永远不会作为补给刷在地上，不参与这条不变式。 */
               kinds: Object.keys(ITEMS).filter(id => !ITEMS[id].keep).length,
               slots: HOTBAR_SLOTS };
    } finally {
      state.view = saved.view; state.ended = saved.ended; state.frozen = saved.frozen;
      state.started = saved.started; state.area = saved.area;
      state.pos.x = saved.x; state.pos.z = saved.z;
      pickups.length = 0;
    }
  })())`, sandbox));

  if (o.emptied !== ',,,') throw new Error('前置条件不对：用光之后快捷栏应全空，实际 [' + o.emptied + ']');
  for (const id in o.placed){
    if (o.placed[id] < 0) throw new Error('捡到的 ' + id + ' 没挂上快捷栏');
  }
  if (o.dup !== 0) throw new Error('快捷栏出现重复物品：' + o.bar);
  if (!(o.slots > o.kinds))
    throw new Error('快捷栏格数(' + o.slots + ')必须多于物品种类(' + o.kinds + ')，否则一定放不下');
  if (o.free < 1) throw new Error('三种物品全挂上之后没有空格了：' + o.bar);
  return '全用光 → 逐个捡回，全部自动挂上，还空着 ' + o.free + ' 格（' + o.bar + '）';
});
check('兜底：人为造出"满格且缺这一种"的坏快捷栏，也不要求玩家开背包', () => {
  /* 正常玩造不出这个状态（3 种物品塞不满 4 格且不重复），
     所以这里直接手写一个坏形状，模拟存档被改过。 */
  const o = JSON.parse(vm.runInContext(`JSON.stringify((() => {
    const saved = { view: state.view, ended: state.ended, frozen: state.frozen,
                    started: state.started, area: state.area,
                    x: state.pos.x, z: state.pos.z, idx: state.hotbarIdx };
    try {
      state.view = 'world'; state.ended = false; state.frozen = false;
      state.started = true; state.area = 'room';
      initBag();
      state.hotbar = ['water', 'spicy', 'water', 'spicy'];   /* 满格、且没有臭水 */
      state.hotbarIdx = 2;
      pickups.length = 0; pickupsPlaced = true;
      state.pos.x = 0; state.pos.z = 0;
      addPickup('stink', 0, 0, 1);
      updatePickups(1/60, 0);
      return { bar: state.hotbar.join(','), at: state.hotbar.indexOf('stink'),
               count: bagCount('stink'),
               toast: String(document.getElementById('toastStack').dataset.last || '') };
    } finally {
      state.view = saved.view; state.ended = saved.ended; state.frozen = saved.frozen;
      state.started = saved.started; state.area = saved.area;
      state.pos.x = saved.x; state.pos.z = saved.z;
      state.hotbarIdx = saved.idx;
      pickups.length = 0;
    }
  })())`, sandbox));
  if (o.count !== 4) throw new Error('臭水应为 3+1=4 个，实际 ' + o.count);
  if (o.at < 0) throw new Error('满格兜底没生效，臭水没挂上快捷栏：' + o.bar);
  if (o.at !== 2) throw new Error('应该换下当前选中的第 3 格，实际放在第 ' + (o.at + 1) + ' 格');
  if (o.toast.indexOf('按 B') >= 0)
    throw new Error('还在让玩家开背包：' + o.toast);
  if (o.toast.indexOf('换下了') < 0)
    throw new Error('换下了东西却没说：' + o.toast);
  return '第 3 格换下旧物品塞进臭水，提示：' + o.toast;
});
check('读档时快捷栏会去重并补齐到 4 格（坏存档不能把不变式带进来）', () => {
  const o = JSON.parse(vm.runInContext(`JSON.stringify((() => {
    initBag();
    bagRestore({ bag: [{ id: 'stink', n: 2 }, { id: 'stink', n: 1 }, { id: '水', n: 9 }],
                 hotbar: ['stink', 'stink', 'water'] });
    return { bar: state.hotbar.join(','), len: state.hotbar.length,
             dup: state.hotbar.filter((x, i, a) => x && a.indexOf(x) !== i).length,
             stink: bagCount('stink'), water: bagCount('water'),
             bagLen: state.bag.length };
  })())`, sandbox));
  if (o.len !== 4) throw new Error('快捷栏补齐后应为 4 格，实际 ' + o.len);
  if (o.dup !== 0) throw new Error('读档后快捷栏里有重复：' + o.bar);
  if (o.bar !== 'stink,water,,') throw new Error('去重后的摆位不对：[' + o.bar + ']');
  if (o.stink !== 3) throw new Error('同一个 id 的两条没合并：臭水 ' + o.stink + '（应为 3）');
  if (o.water !== 0) throw new Error('不存在的物品 id 被带进背包了');
  if (o.bagLen !== 1) throw new Error('背包条目应合并成 1 条，实际 ' + o.bagLen);
  return '重复的臭水合并成 3 个，快捷栏 [' + o.bar + ']，非法 id 被丢掉';
});
/* ============================ 补给点 ============================ */
console.log('\n== 8.6 补给：固定点 + 保安掉落 ==');
check('每个固定补给点都站得到（不在桌椅/墙/饮水机里，也不在贴墙缝里）', () => {
  const r = JSON.parse(vm.runInContext(`JSON.stringify((() => {
    const savedObst = obstacles.slice();
    try {
      obstacles.length = 0;
      registerRoomObstacles();
      const b = AREA_BOUNDS.room, bad = [], names = [];
      for (const s of PICKUP_SPOTS){
        names.push(ITEMS[s.id].name);
        if (collides(s.x, s.z, PLAYER_RADIUS))
          bad.push(ITEMS[s.id].name + '(' + s.x + ',' + s.z + ') 落在障碍里，人走不进去');
        if (!(s.x > -b.x + PLAYER_RADIUS && s.x < b.x - PLAYER_RADIUS &&
              s.z > b.zMin + PLAYER_RADIUS && s.z < b.zMax - PLAYER_RADIUS))
          bad.push(ITEMS[s.id].name + '(' + s.x + ',' + s.z + ') 越出房间边界');
      }
      return { bad: bad, names: names.join(' / ') };
    } finally {
      obstacles.length = 0; savedObst.forEach(o => obstacles.push(o));
    }
  })())`, sandbox));
  if (r.bad.length) throw new Error(r.bad.join('；'));
  return r.names + ' —— 全部可站立';
});
check('走进补给点自动捡进背包，地面上的补给随之消失', () => {
  const o = JSON.parse(vm.runInContext(`JSON.stringify((() => {
    const saved = { view: state.view, ended: state.ended, frozen: state.frozen,
                    started: state.started, area: state.area,
                    x: state.pos.x, z: state.pos.z };
    try {
      state.view = 'world'; state.ended = false; state.frozen = false;
      state.started = true; state.area = 'room';
      initBag();
      pickups.length = 0; pickupsPlaced = false;
      ensurePickups();
      const n0 = pickups.length;
      const target = pickups.filter(p => p.id === 'water')[0];
      const before = bagCount('water');
      state.pos.x = target.x; state.pos.z = target.z;
      updatePickups(1/60, 0);
      return { n0: n0, left: pickups.length, gained: bagCount('water') - before,
               gone: pickups.indexOf(target) < 0, want: PICKUP_SPOTS.length };
    } finally {
      state.view = saved.view; state.ended = saved.ended; state.frozen = saved.frozen;
      state.started = saved.started; state.area = saved.area;
      state.pos.x = saved.x; state.pos.z = saved.z;
    }
  })())`, sandbox));
  if (o.n0 !== o.want) throw new Error('铺了 ' + o.n0 + ' 个，应为 ' + o.want);
  if (o.gained !== 1) throw new Error('走过去没捡到，背包 +' + o.gained);
  if (o.left !== o.n0 - 1) throw new Error('地上的补给没消失，还剩 ' + o.left + ' 个');
  if (!o.gone) throw new Error('捡过的对象还留在 pickups 数组里');
  return '铺 ' + o.n0 + ' 个 → 走上去 +1 瓶水，剩 ' + o.left + ' 个';
});
check('背包满了不吞地上的补给（东西留在原地，不凭空蒸发）', () => {
  const o = JSON.parse(vm.runInContext(`JSON.stringify((() => {
    const saved = { view: state.view, ended: state.ended, frozen: state.frozen,
                    started: state.started, area: state.area,
                    x: state.pos.x, z: state.pos.z };
    try {
      state.view = 'world'; state.ended = false; state.frozen = false;
      state.started = true; state.area = 'room';
      initBag();
      bagAdd('stink', 99);                 /* 顶满一摞（stack = 9） */
      const full = bagCount('stink');
      pickups.length = 0; pickupsPlaced = true;
      const p = addPickup('stink', 0, 0, 1);
      state.pos.x = 0; state.pos.z = 0;
      updatePickups(1/60, 0);
      return { full: full, still: pickups.indexOf(p) >= 0, after: bagCount('stink'),
               cap: ITEMS.stink.stack };
    } finally {
      state.view = saved.view; state.ended = saved.ended; state.frozen = saved.frozen;
      state.started = saved.started; state.area = saved.area;
      state.pos.x = saved.x; state.pos.z = saved.z;
      pickups.length = 0;
    }
  })())`, sandbox));
  if (o.full !== o.cap) throw new Error('bagAdd 没把一摞顶到上限：' + o.full + ' / ' + o.cap);
  if (!o.still) throw new Error('背包满了，地上的补给却被删掉了');
  if (o.after !== o.cap) throw new Error('背包满时数量还变了：' + o.after);
  return '一摞顶到 ' + o.full + '，地上的补给留住了';
});
check('保安掉落节奏可复现：第 3 个掉臭水、第 5 个掉矿泉水', () => {
  const o = JSON.parse(vm.runInContext(`JSON.stringify((() => {
    pickups.length = 0; pickupsPlaced = true;
    const got = {};
    for (let k = 1; k <= 6; k++) got['第' + k + '个'] = maybeDropFromGuard(k, 0, 0) || '（不掉）';
    return { got: got, total: pickups.length };
  })())`, sandbox));
  const want = { '第1个': '（不掉）', '第2个': '（不掉）', '第3个': 'stink',
                 '第4个': '（不掉）', '第5个': 'water', '第6个': 'stink' };
  for (const k in want){
    if (o.got[k] !== want[k])
      throw new Error(k + ' 掉了 ' + o.got[k] + '，应为 ' + want[k]);
  }
  if (o.total !== 3) throw new Error('6 个保安共掉 ' + o.total + ' 个，应为 3');
  return '1-6 → ' + Object.values(o.got).join(' ');
});
check('掉落位置会被钳进房间，不会掉在墙上永远捡不到', () => {
  const o = JSON.parse(vm.runInContext(`JSON.stringify((() => {
    pickups.length = 0; pickupsPlaced = true;
    maybeDropFromGuard(3, 999, -999);     /* 故意给一个房间外的坐标 */
    const p = pickups[0];
    return { x: p.x, z: p.z, ox: Math.abs(p.x), oz: Math.abs(p.z),
             bx: AREA_BOUNDS.room.x, bz: AREA_BOUNDS.room.zMin };
  })())`, sandbox));
  if (o.ox > o.bx - 0.2) throw new Error('x 没钳住：' + o.x + '（房间半宽 ' + o.bx + '）');
  if (o.oz > Math.abs(o.bz) - 0.2) throw new Error('z 没钳住：' + o.z);
  return '越界坐标被钳到 (' + o.x + ', ' + o.z + ')';
});
check('场上补给有上限，超了收掉最老的（不无限堆）', () => {
  const o = JSON.parse(vm.runInContext(`JSON.stringify((() => {
    pickups.length = 0; pickupsPlaced = true;
    for (let i = 0; i < PICKUP_CAP + 5; i++) addPickup('water', 0, 0, 1);
    const len = pickups.length;
    pickups.length = 0;
    return { len: len, cap: PICKUP_CAP, made: PICKUP_CAP + 5 };
  })())`, sandbox));
  if (o.len !== o.cap)
    throw new Error('放了 ' + o.made + ' 个，场上留着 ' + o.len + ' 个（上限 ' + o.cap + '）');
  return '上限生效：始终 ' + o.len + ' 个';
});
/* ============================ 对手 · 名次 ============================ */
console.log('\n== 8.7 对手 · 名次 ==');
check('五个选手的成绩是确定性的，而且性格分明', () => {
  const o = JSON.parse(vm.runInContext(`JSON.stringify((() => {
    const C = CONTEST_LEN;
    const names = npcs.map(n => n.userData.name);
    const a = {}, b = {};
    for (const n of names){ a[n] = rivalTotal(n, C); b[n] = rivalTotal(n, C); }
    return { names: names, a: a, b: b };
  })())`, sandbox));
  if (o.names.length !== 5) throw new Error('选手应有 5 名，实际 ' + o.names.length);
  for (const n of o.names){
    if (o.a[n] !== o.b[n])
      throw new Error(n + ' 两次算出来不一样：' + o.a[n] + ' / ' + o.b[n] + '（成绩必须可复现）');
    if (o.a[n] > 400) throw new Error(n + ' 超过满分：' + o.a[n]);
    if (o.a[n] % 10 !== 0) throw new Error(n + ' 的分数不在评测机的分档上：' + o.a[n]);
  }
  /* 性格：小红慢而准，小刚抢交而糙 —— 分数要分得出来，
     否则五个人算出来一样，榜就是装饰 */
  if (!(o.a['小红'] > o.a['小刚']))
    throw new Error('小红 ' + o.a['小红'] + ' 没压过小刚 ' + o.a['小刚']);
  const order = o.names.slice().sort((x, y) => o.a[y] - o.a[x]);
  return order.map(n => n + ' ' + o.a[n]).join(' / ');
});
check('榜会换人领跑：小刚抢交先冲，小红后超', () => {
  /* 时间点按新节奏重新锚定：交卷现在压进赛程前 ~37%，
     所以"抢交先冲"发生在前 30 分钟，"后超"要在 80 分钟之后看。
     老版是 50% / 100%（交卷摊在整整 4 小时里）—— 那是被 bug 带着走的数字。 */
  const o = JSON.parse(vm.runInContext(`JSON.stringify((() => {
    const C = CONTEST_LEN;
    const pick = f => {
      const t = f * C, r = {};
      for (const n of npcs.map(x => x.userData.name)) r[n] = rivalTotal(n, t);
      return r;
    };
    return { early: pick(0.1), mid: pick(0.18), end: pick(1) };
  })())`, sandbox));
  if (!(o.early['小刚'] > o.early['小红']))
    throw new Error('开局抢交时小刚(' + o.early['小刚'] + ')没有领先小红(' + o.early['小红'] + ')');
  if (!(o.end['小红'] > o.end['小刚']))
    throw new Error('终盘小红(' + o.end['小红'] + ')没有反超小刚(' + o.end['小刚'] + ')');
  if (!(o.end['小红'] >= o.end['小明']))
    throw new Error('小红应当是最准的那个：小红 ' + o.end['小红'] + ' vs 小明 ' + o.end['小明']);
  return '开局 小刚 ' + o.early['小刚'] + ' > 小红 ' + o.early['小红'] +
         '　终盘 小红 ' + o.end['小红'] + ' > 小刚 ' + o.end['小刚'];
});
check('名次：满分第一、320 第三、200 垫底', () => {
  const o = JSON.parse(vm.runInContext(`JSON.stringify((() => {
    const C = CONTEST_LEN, saved = state.totalScore, out = {};
    try {
      for (const mine of [400, 320, 200]) { state.totalScore = mine; out[mine] = playerRank(C); }
      out.count = rivalCount();
    } finally { state.totalScore = saved; }
    return out;
  })())`, sandbox));
  if (o.count !== 6) throw new Error('全场应为 6 人（5 选手 + 你），实际 ' + o.count);
  if (o['400'] !== 1) throw new Error('满分应排第 1，实际第 ' + o['400']);
  if (o['320'] !== 3) throw new Error('320 分应排第 3，实际第 ' + o['320']);
  if (o['200'] !== 6) throw new Error('200 分应垫底第 6，实际第 ' + o['200']);
  return '400 → 1　320 → 3　200 → 6（共 ' + o.count + ' 人）';
});
check('干扰同学 3 次：他的榜上分数真的掉下来（干扰不是纯亏损）', () => {
  /* 注意度量点：交卷压进赛程前 ~37% 之后，"拖后 3 次"不会把谁顶过终点线，
     终盘总分回到原值。干扰的效果变成了**在榜上把他按住一段时间** ——
     所以这里量的是比赛中段的榜面，不是终盘。
     （老版量终盘能过，是因为交卷摊到 99% 赛程，那本身就是要修的那个 bug。） */
  const o = JSON.parse(vm.runInContext(`JSON.stringify((() => {
    const C = CONTEST_LEN, out = {};
    const step = DISTURB_DELAY_FRAC * CONTEST_LEN;
    const T = 0.20 * C;              /* ≈48 分钟赛程，正好卡在小红交卷中间 */
    out.windowMin = Math.round(3 * step / 60);
    const saved = state.totalScore;
    try {
      out[0] = rivalTotal('小红', T);
      for (let k = 1; k <= 3; k++){
        state.npcDelay['小红'] = k * step;
        out[k] = rivalTotal('小红', T);
      }
      /* 名次也得跟着动：0 分时被人压着，干扰完就能反超她 */
      state.totalScore = 0;
      state.npcDelay['小红'] = 0;
      out.rankBefore = playerRank(T);
      state.npcDelay['小红'] = 3 * step;
      out.rankAfter = playerRank(T);
    } finally { delete state.npcDelay['小红']; state.totalScore = saved; }
    return out;
  })())`, sandbox));
  for (let k = 1; k <= 3; k++){
    if (o[k] > o[k - 1])
      throw new Error('干扰 ' + k + ' 次之后分数反而涨了：' + o[k - 1] + ' → ' + o[k]);
  }
  if (!(o[3] < o[0]))
    throw new Error('干扰 3 次（约 ' + o.windowMin + ' 分钟）对他的榜上分数毫无影响：' +
                    o[0] + ' → ' + o[3]);
  if (!(o.rankAfter < o.rankBefore))
    throw new Error('干扰前后名次没变：第 ' + o.rankBefore + ' → 第 ' + o.rankAfter);
  return '赛程中段 小红 ' + o[0] + ' → 干扰 3 次后 ' + o[3] +
         ' · 我的名次 ' + o.rankBefore + ' → ' + o.rankAfter;
});
check('被放倒的人不再交卷（打人不是白打）', () => {
  const o = JSON.parse(vm.runInContext(`JSON.stringify((() => {
    const C = CONTEST_LEN;
    const n = npcs.filter(x => x.userData.name === '小明')[0];
    const ud = n.userData, savedState = ud.state;
    /* 放倒点要卡在小明还没交完的时候 —— 交卷压进前 37% 赛程之后，
       "四成时间点被放倒"时他早交完了，那种度量等于什么都没测。 */
    const downAt = 0.10 * C;
    try {
      const before = rivalTotal('小明', C);
      ud.state = 'down'; ud.downAt = downAt;
      const cut = rivalTotal('小明', C);
      ud.state = savedState; delete ud.downAt;
      return { before: before, cut: cut, back: rivalTotal('小明', C),
               atDown: rivalTotal('小明', downAt), last: rivalSubmitAt('小明', 3) };
    } finally { ud.state = savedState; delete ud.downAt; }
  })())`, sandbox));
  if (!(o.last > 0.10 * 14400))
    throw new Error('前置条件不成立：小明的最后一题在放倒点之前就交了');
  if (!(o.cut < o.before))
    throw new Error('被放倒之后分数没停：' + o.before + ' → ' + o.cut);
  if (o.cut !== o.atDown)
    throw new Error('被放倒后应当冻结在放倒那一刻的分数：' + o.cut + ' ≠ ' + o.atDown);
  if (o.back !== o.before)
    throw new Error('恢复状态后成绩没回来：' + o.back + ' ≠ ' + o.before);
  return '终盘 ' + o.before + ' → 放倒于 ' + Math.round(o.atDown / 60) +
         ' 分钟时冻结为 ' + o.cut + '（恢复后 ' + o.back + '）';
});
check('结算榜面：六行、有你、带箭头', () => {
  const o = JSON.parse(vm.runInContext(`JSON.stringify((() => {
    const saved = state.totalScore;
    try { state.totalScore = 320; return { text: rivalBoardText(CONTEST_LEN) }; }
    finally { state.totalScore = saved; }
  })())`, sandbox));
  const lines = o.text.split('\n');
  if (lines.length !== 6) throw new Error('榜面应有 6 行，实际 ' + lines.length);
  if (o.text.indexOf('第 1 名') < 0) throw new Error('榜面没有名次编号');
  if (o.text.indexOf('←') < 0) throw new Error('榜面上没标出哪个是你');
  for (let i = 0; i < lines.length; i++){
    if (lines[i].indexOf('第 ' + (i + 1) + ' 名') !== 0)
      throw new Error('第 ' + (i + 1) + ' 行编号不对：' + lines[i]);
  }
  return lines.join(' | ');
});

/* ============================ 老师的眼睛 ============================ */
console.log('\n== 8.8 老师的眼睛 ==');
check('巡逻轨迹确实会经过座位旁（判定半径不能小于最近距离）', () => {
  /* 这条是防我自己写死代码：第一版把半径拍成 2.0，
     而轨迹到座位的最近距离是 2.5 —— 那一版永远触发不到，而且不报错。 */
  const o = JSON.parse(vm.runInContext(`JSON.stringify((() => {
    let min = 1e9;
    for (let i = 0; i < 20000; i++){
      const t = i / 20000 * Math.PI * 2;
      const p = patrolPoint(t);
      const d = Math.hypot(p.x - SEAT_CENTER_X, p.z - SEAT_CENTER_Z);
      if (d < min) min = d;
    }
    return { min: min, radius: TEACHER_PEEK_RADIUS };
  })())`, sandbox));
  if (o.radius <= o.min)
    throw new Error('判定半径 ' + o.radius + ' 小于轨迹最近距离 ' +
                    o.min.toFixed(2) + ' —— 这一眼永远触发不到');
  return '轨迹最近 ' + o.min.toFixed(2) + '，判定半径 ' + o.radius;
});
check('坐在座位上玩电脑：老师经过就关掉并记警告，其余情况都不触发', () => {
  const o = JSON.parse(vm.runInContext(`JSON.stringify((() => {
    const hadTeacher = !!teacher;
    if (!teacher) teacher = buildTeacher(2.4, 0);
    const saved = { view: state.view, area: state.area, warn: state.warnCount,
                    x: state.pos.x, z: state.pos.z, wt: state.worldTime,
                    mode: teacher.userData.mode };
    const out = {};
    try {
      /* 巡逻轨迹最靠近座位是在 theta = 3*pi/2 处。
         注意不能先摆老师坐标再调用 —— updateTeacherWhenPaused(t) 会用
         巡逻路径把位置覆盖掉，摆好了也会被冲走（这一版踩过）。 */
      const T_NEAR = Math.PI * 1.5 / 0.15, T_FAR = 0;
      teacher.userData.mode = 'patrol';
      state.area = 'room';
      state.pos.x = SEAT_CENTER_X; state.pos.z = SEAT_CENTER_Z;
      state.warnCount = 0;
      state.worldTime = 100;

      state.view = 'launcher';
      updateTeacherWhenPaused(T_NEAR);
      out.near = { view: state.view, warn: state.warnCount,
                   hidden: desktopUI.classList.contains('hidden'),
                   dist: Math.hypot(teacher.group.position.x - state.pos.x,
                                    teacher.group.position.z - state.pos.z) };

      state.view = 'launcher';                       /* 冷却期内再来一次 */
      updateTeacherWhenPaused(T_NEAR);
      out.cool = { view: state.view, warn: state.warnCount };

      state.worldTime = 100 + TEACHER_PEEK_COOLDOWN + 1;
      state.view = 'launcher';                       /* 老师在场地另一头 */
      updateTeacherWhenPaused(T_FAR);
      out.far = { view: state.view, warn: state.warnCount,
                  dist: Math.hypot(teacher.group.position.x - state.pos.x,
                                   teacher.group.position.z - state.pos.z) };

      state.view = 'code';                           /* 你在写代码 */
      state.worldTime = 100 + TEACHER_PEEK_COOLDOWN * 3;
      updateTeacherWhenPaused(T_NEAR);
      out.working = { view: state.view, warn: state.warnCount };

      state.view = 'launcher';                       /* 他正走过来抓你走动 */
      state.worldTime = 100 + TEACHER_PEEK_COOLDOWN * 5;
      teacher.userData.mode = 'approach';
      updateTeacherWhenPaused(T_NEAR);
      out.chasing = { view: state.view, warn: state.warnCount };
      return out;
    } finally {
      state.view = saved.view; state.area = saved.area; state.warnCount = saved.warn;
      state.pos.x = saved.x; state.pos.z = saved.z; state.worldTime = saved.wt;
      teacher.userData.mode = saved.mode;
      if (!hadTeacher){ scene.remove(teacher.group); teacher = null; }
    }
  })())`, sandbox));

  if (!(o.near.dist <= 3.4))
    throw new Error('前置条件不对：老师离你 ' + o.near.dist.toFixed(2) + '，不在判定范围内');
  if (o.near.warn !== 1) throw new Error('老师就在身后，警告数应为 1，实际 ' + o.near.warn);
  if (o.near.view === 'launcher') throw new Error('被抓到玩电脑了，桌面却没被关掉');
  if (!o.near.hidden) throw new Error('桌面面板还显示着');
  if (o.cool.warn !== 1)
    throw new Error('冷却期里又记了一次警告（' + o.cool.warn + '）—— 他绕一圈能把你警告到死');
  if (o.cool.view !== 'launcher')
    throw new Error('冷却期内不该再关一次桌面');
  if (!(o.far.dist > 3.4)) throw new Error('前置条件不对：老师离你只有 ' + o.far.dist.toFixed(2));
  if (o.far.warn !== 1 || o.far.view !== 'launcher')
    throw new Error('老师隔着半个教室也把你抓了');
  if (o.working.warn !== 1 || o.working.view !== 'code')
    throw new Error('你在写代码也被抓了 —— 这一眼只该盯摸鱼');
  if (o.chasing.warn !== 1 || o.chasing.view !== 'launcher')
    throw new Error('他正在走过来抓走动时，不该顺带再关一次桌面');
  return '最近 ' + o.near.dist.toFixed(2) + ' 米 → 关桌面 + 1 次警告；' +
         '冷却 / 离得远 / 在写代码 / 他正抓你 —— 都不触发';
});
/* ============================ 12. 存档 ============================ */
console.log('\n== 9. 存档 ==');
check('save / load 往返一致', () => {
  vm.runInContext('state.score[state.problems[0].id] = 55; ' +
    'state.cardBalance = 7; state.vendingStock.water = 1; persistSave();', sandbox);
  if (!vm.runInContext('hasSave()', sandbox)) throw new Error('保存后 hasSave() 仍是 false');
  vm.runInContext('state.score[state.problems[0].id] = 0; ' +
    'state.cardBalance = 12; state.vendingStock.water = 3;', sandbox);
  vm.runInContext('tryLoadSave();', sandbox);
  const back = vm.runInContext('state.score[state.problems[0].id]', sandbox);
  if (back !== 55) throw new Error('读回来是 ' + back);
  const vend = JSON.parse(vm.runInContext(
    'JSON.stringify({ bal: state.cardBalance, water: state.vendingStock.water })', sandbox));
  if (vend.bal !== 7) throw new Error('余额读回来是 ' + vend.bal);
  if (vend.water !== 1) throw new Error('水库存读回来是 ' + vend.water);
  return '55 分 · 余额 7 · 水库存 1 成功往返';
});
check('入场阶段的存档：读回来仍是入场时钟', () => {
  const raw = vm.runInContext(`JSON.stringify((() => {
    const old = { exam: state.examStarted, admit: state.admitElapsed, elapsed: state.elapsed };
    try {
      state.examStarted = false; state.elapsed = 0; state.admitElapsed = 77;
      persistSave();
      state.examStarted = true; state.elapsed = 999; state.admitElapsed = 0;
      tryLoadSave();
      return { exam: state.examStarted, admit: state.admitElapsed, elapsed: state.elapsed };
    } finally {
      state.examStarted = old.exam;
      state.admitElapsed = old.admit;
      state.elapsed = old.elapsed;
    }
  })())`, sandbox);
  const r = JSON.parse(raw);
  if (r.exam !== false) throw new Error('读回来 examStarted 是 ' + r.exam);
  if (r.admit !== 77) throw new Error('读回来 admitElapsed 是 ' + r.admit);
  if (r.elapsed !== 0) throw new Error('入场阶段读回来 elapsed 是 ' + r.elapsed);
  return '入场时钟 77 秒 / 考试时钟 0 成功往返';
});
check('clearSave 会清掉存档', () => {
  vm.runInContext('clearSave()', sandbox);
  if (vm.runInContext('hasSave()', sandbox)) throw new Error('没清掉');
  return '已清除';
});
check('读档后玩家不会落在错误区域的边界外', () => {
  const area = vm.runInContext('state.area', sandbox);
  if (area !== 'campus' && area !== 'room') throw new Error('区域是 ' + area);
  const inside = vm.runInContext(
    'state.pos.x >= -state.bounds.x && state.pos.x <= state.bounds.x && ' +
    'state.pos.z >= state.bounds.zMin && state.pos.z <= state.bounds.zMax', sandbox);
  if (!inside) throw new Error('玩家在 ' + area + ' 的边界外');
  return 'area = ' + area + '，位置合法';
});

/* ============================ 13. 收尾 ============================ */
console.log('\n== 10. 收尾 ==');
check('再跑 300 帧不抛异常', () => {
  vm.runInContext('for (let i = 0; i < 300; i++) animate();', sandbox);
  return '连续 300 帧无异常';
});
check('交卷并出结算界面', () => {
  /* endContest() 自己会把 view 设回 'world' 并调 hideAllPanels()，
     结算画面是 showEnding() 单独拉起来的 —— 所以正确的断言是
     "ended 为真 + ending 面板可见"，不是 view === 'ending'。 */
  vm.runInContext('state.ended = false; endContest(false);', sandbox);
  if (!vm.runInContext('state.ended', sandbox)) throw new Error('state.ended 没置位');
  const shown = vm.runInContext('!endingUI.classList.contains("hidden")', sandbox);
  if (!shown) throw new Error('结算面板没显示');
  return 'ended = true，结算面板已显示';
});
check('结算后暂停菜单/编辑器都已收起', () => {
  const codeHidden = vm.runInContext('codeUI.classList.contains("hidden")', sandbox);
  if (!codeHidden) throw new Error('结算了 codeUI 还开着');
  return 'codeUI 已收起';
});

/* ============================ 汇总 ============================ */
console.log('\n' + '='.repeat(62));
if (failures === 0){
  console.log('全部通过。');
} else {
  console.log(failures + ' 项失败：');
  for (const f of fails) console.log('  · ' + f);
}
console.log('='.repeat(62));
process.exit(failures === 0 ? 0 : 1);