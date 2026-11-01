'use strict';
/* =========================================================================
   postfx —— 自研拖影后处理（三通道 ping-pong，零外部依赖）
   ---------------------------------------------------------------------
   链路：
     world ──▶ rtFrame（不含 UI 层）
              │
              ├─ mix(rtFrame, rtAccA, damp) ──▶ rtAccB ──▶ 交换 A/B
                                                        │
                                                        ▼
                                        blit(linear→sRGB) ──▶ 屏幕
                                                              │
                                        UI 层叠加（清深度，只渲染 layer 1）

   三个坑记在这里，免得以后重踩：
     1) 相机 layers 默认只有 0，准星和弹窗在 layer 1 —— 每条渲染路径都必须
        显式确保 layer 1 会被渲染到，否则准星凭空消失。
     2) three 对 scene.background 会 forceClear，即使 autoClear=false 也清屏；
        所以 UI 覆盖 pass 前要临时把 background 摘掉。
     3) 中间缓冲是 linear 空间，blit 用 sRGB 编码保存到 rt —— 换句话说
        中间值必须已经被钳制在 [0,1]，否则高光溢出会在拖影里结块。
        因此 world pass 关掉色调映射（toneMapping = None），把钳制交给 float 缓冲。
   ========================================================================= */

const POST_DAMP_MIN = 0.2, POST_DAMP_MAX = 0.9;

let postOK = false, postPrimed = false;
let rtFrame = null, rtAccA = null, rtAccB = null;
let postScene = null, postCamera = null, postQuad = null;
let blendMat = null, blitMat = null;
let postDamp = POST_DAMP_MIN;

const POST_VERT = [
  'varying vec2 vUv;',
  'void main(){',
  '  vUv = uv;',
  '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
  '}'
].join('\n');

const POST_BLEND_FRAG = [
  'precision mediump float;',
  'uniform sampler2D tNew;',
  'uniform sampler2D tOld;',
  'uniform float damp;',
  'varying vec2 vUv;',
  'void main(){',
  '  vec4 n = texture2D(tNew, vUv);',
  '  vec4 o = texture2D(tOld, vUv);',
  '  gl_FragColor = mix(n, o, damp);',
  '}'
].join('\n');

/* linear → sRGB。式子即标准 IEC 61966-2-1 传递函数 */
const POST_BLIT_FRAG = [
  'precision mediump float;',
  'uniform sampler2D tSrc;',
  'varying vec2 vUv;',
  'vec3 toSRGB(vec3 c){',
  '  return mix(c * 12.92, 1.055 * pow(c, vec3(0.4166667)) - 0.055, step(0.0031308, c));',
  '}',
  'void main(){',
  '  gl_FragColor = vec4(toSRGB(texture2D(tSrc, vUv).rgb), 1.0);',
  '}'
].join('\n');

function initPostFX(){
  try {
    const dpr = renderer.getPixelRatio ? renderer.getPixelRatio() : 1;
    const w = Math.max(1, Math.floor(innerWidth * dpr));
    const h = Math.max(1, Math.floor(innerHeight * dpr));
    const mkRT = () => new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat, depthBuffer: true, stencilBuffer: false
    });
    rtFrame = mkRT(); rtAccA = mkRT(); rtAccB = mkRT();

    postScene = new THREE.Scene();
    postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    postQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    postQuad.frustumCulled = false;

    blendMat = new THREE.ShaderMaterial({
      uniforms: { tNew: { value: null }, tOld: { value: null }, damp: { value: postDamp } },
      vertexShader: POST_VERT, fragmentShader: POST_BLEND_FRAG,
      depthTest: false, depthWrite: false
    });
    blitMat = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null } },
      vertexShader: POST_VERT, fragmentShader: POST_BLIT_FRAG,
      depthTest: false, depthWrite: false
    });

    postQuad.material = blendMat;
    postScene.add(postQuad);
    postOK = true;
    postPrimed = false;
  } catch(e){
    console.warn('postfx 初始化失败，退回直接渲染', e);
    postOK = false;
  }
  return postOK;
}

function setPostDamp(t){ postDamp = lerp(POST_DAMP_MIN, POST_DAMP_MAX, clamp(t, 0, 1)); }

function resizePostFX(){
  if (!postOK) return;
  const dpr = renderer.getPixelRatio ? renderer.getPixelRatio() : 1;
  const w = Math.max(1, Math.floor(innerWidth * dpr));
  const h = Math.max(1, Math.floor(innerHeight * dpr));
  rtFrame.setSize(w, h);
  rtAccA.setSize(w, h);
  rtAccB.setSize(w, h);
  postPrimed = false;
}

function renderFrame(dt){
  if (!postOK){
    camera.layers.enable(1);
    try { renderer.render(scene, camera); }
    finally { camera.layers.disable(1); }
    return;
  }

  const damp = postPrimed ? postDamp : 0;   /* 首帧 damp=0 播种，避免从黑屏渐入 */
  postPrimed = true;

  /* 1. 世界 → rtFrame（屏蔽 UI 层） */
  camera.layers.disable(1);
  renderer.setRenderTarget(rtFrame);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);

  /* 2. 累积：accum = mix(rtFrame, rtAccA, damp) → rtAccB，然后交换 */
  blendMat.uniforms.tNew.value = rtFrame.texture;
  blendMat.uniforms.tOld.value = rtAccA.texture;
  blendMat.uniforms.damp.value = damp;
  postQuad.material = blendMat;
  renderer.setRenderTarget(rtAccB);
  renderer.render(postScene, postCamera);
  renderer.setRenderTarget(null);
  const tmp = rtAccA; rtAccA = rtAccB; rtAccB = tmp;

  /* 3. blit 到屏幕（linear → sRGB） */
  blitMat.uniforms.tSrc.value = rtAccA.texture;
  postQuad.material = blitMat;
  renderer.render(postScene, postCamera);

  /* 4. UI 层叠加：摘背景、清深度、只渲染 layer 1 */
  const bg = scene.background;
  scene.background = null;
  camera.layers.enable(1);
  camera.layers.disable(0);
  renderer.autoClear = false;
  try {
    renderer.clearDepth();
    renderer.render(scene, camera);
  } finally {
    renderer.autoClear = true;
    camera.layers.enable(0);
    scene.background = bg;
  }
}
