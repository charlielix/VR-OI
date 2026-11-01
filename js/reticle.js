'use strict';
/* =========================================================================
   reticle —— 3D 准星
   ---------------------------------------------------------------------
   为什么不用 DOM 画准星：DOM 准星没法参与"指向白光时反色"，也没法
   把视线停留进度环画得贴着准星缩放。这里把它做成挂在相机下的 3D 组：
     · 两根正交细条 = "+"；指向可交互目标时旋转 45° 变 "×"
     · 指向攻击目标时放大 1.5x 并渐变成红色
     · 外圈进度环用极坐标 shader 画弧，展示弹窗按钮的视线停留进度
   旋转 / 缩放 / 变色全部走指数平滑，所以跟手但不生硬。
   ========================================================================= */

const RETICLE_DIST = 0.5;
const RETICLE_LEN = 0.015, RETICLE_TH = 0.0013;
const RETICLE_RING_R = 0.0275;

const RETICLE_WHITE = new THREE.Color(0xffffff);
const RETICLE_RED = new THREE.Color(0xff5f6d);
const RETICLE_DARK = new THREE.Color(0x141822);

let reticle = null, retRing = null, retRingU = null;
const retBars = [];
let retAngle = 0, retScale = 1, retMix = 0;
const _retCol = new THREE.Color();

function initReticle(){
  const g = new THREE.Group();
  g.position.set(0, 0, -RETICLE_DIST);
  g.renderOrder = 1000;

  const mkBar = (w, h) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.001),
      new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.92,
        depthTest: false, depthWrite: false
      }));
    m.renderOrder = 1000;
    return m;
  };
  const hBar = mkBar(RETICLE_LEN, RETICLE_TH);
  const vBar = mkBar(RETICLE_TH, RETICLE_LEN);
  retBars.push(hBar, vBar);
  g.add(hBar); g.add(vBar);

  retRingU = { uProgress: { value: 0 }, uDark: { value: 0 } };
  retRing = new THREE.Mesh(
    new THREE.PlaneGeometry(RETICLE_RING_R * 2, RETICLE_RING_R * 2),
    new THREE.ShaderMaterial({
      uniforms: retRingU,
      transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
      vertexShader: [
        'varying vec2 vUv;',
        'void main(){',
        '  vUv = uv;',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
        '}'
      ].join('\n'),
      fragmentShader: [
        'precision mediump float;',
        'varying vec2 vUv;',
        'uniform float uProgress;',
        'uniform float uDark;',
        'void main(){',
        '  vec2 p = vUv - 0.5;',
        '  float r = length(p) * 2.0;',
        '  float a = atan(p.y, p.x);',
        /* 从正上方为 0 开始顺时针填充 */
        '  float ang = fract((a + 1.5707963) / 6.2831853);',
        '  float ring = step(0.78, r) * step(r, 0.96);',
        '  float fill = step(ang, uProgress);',
        '  float alpha = ring * (0.20 + 0.80 * fill);',
        '  if (alpha < 0.02) discard;',
        '  vec3 base = mix(vec3(0.36, 0.55, 1.0), vec3(0.10, 0.14, 0.22), uDark);',
        '  vec3 hot  = mix(vec3(1.0), vec3(0.86, 0.22, 0.30), uDark);',
        '  gl_FragColor = vec4(mix(base, hot, fill), alpha);',
        '}'
      ].join('\n')
    }));
  retRing.renderOrder = 1000;
  retRing.visible = false;
  g.add(retRing);

  /* 准星整体进 UI 层：不参与后处理拖影，永远锐利 */
  g.traverse(o => { o.layers.set(1); });

  camera.add(g);
  scene.add(camera);      /* 相机的子节点要被渲染，相机必须先挂进场景 */
  reticle = g;
}

function updateReticle(dt){
  if (!reticle) return;
  reticle.visible = !crosshair.classList.contains('hidden');
  if (!reticle.visible){ retRing.visible = false; return; }

  const dwell = dialogDwell();
  const attacking = !!actionSpace;
  const interactive = attacking || !!actionE || !!actionF || dwell.active;

  const targetAngle = interactive ? -Math.PI / 4 : 0;
  retAngle += (targetAngle - retAngle) * (1 - Math.exp(-dt * 14));
  for (const b of retBars) b.rotation.z = retAngle;

  const targetScale = attacking ? 1.5 : 1;
  retScale += (targetScale - retScale) * (1 - Math.exp(-dt * 12));

  const targetMix = attacking ? 1 : 0;
  retMix += (targetMix - retMix) * (1 - Math.exp(-dt * 10));

  /* 紧张态也让准星泛血色；指着门口白光时底色反色，否则白底上找不到准星 */
  const tn = getTension() * 0.45;
  const base = aimingAtWhiteLight() ? RETICLE_DARK : RETICLE_WHITE;
  _retCol.copy(base).lerp(RETICLE_RED, Math.max(retMix, tn));
  for (const b of retBars) b.material.color.copy(_retCol);

  /* 紧张态呼吸 */
  const breathe = 1 + 0.05 * getTension() * Math.sin(performance.now() * 0.006);
  reticle.scale.setScalar(retScale * breathe);

  retRingU.uDark.value = aimingAtWhiteLight() ? 1 : 0;
  retRing.visible = dwell.progress > 0.002;
  if (retRing.visible) retRingU.uProgress.value = dwell.progress;
}
