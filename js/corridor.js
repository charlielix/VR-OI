'use strict';
/* =========================================================================
   corridor —— 走廊往返与洗手间流程
   ---------------------------------------------------------------------
   这两段刻意不做成 3D：走廊用一张会向你缩放的门 + 按住 W 的推进条，
   洗手间是 6 步按住式流程。做成"低分辨率的第一人称幻觉"比真三维更省钱，
   也更符合"你正在梦里走这段路"的气质。
   ========================================================================= */

let corridorPhase = 'toilet', corridorProgress = 0, corridorDone = false;

function enterCorridor(phase){
  state.view = 'corridor';
  releaseLock();
  state.keys = {};
  corridorPhase = phase;
  corridorProgress = 0;
  corridorDone = false;
  corridorUI.classList.remove('hidden');
  crosshair.classList.add('hidden');
  promptEl.classList.add('hidden');

  const stepEl = $('corrStep'), hintEl = $('corrHint'), labelEl = $('corrDoorLabel');
  if (phase === 'toilet'){
    stepEl.textContent = '沿着走廊走向洗手间……';
    labelEl.textContent = '洗手间';
  } else {
    stepEl.textContent = '沿着走廊走回考场……';
    labelEl.textContent = '考场';
  }
  hintEl.textContent = '按住 W 前进';
  updateCorridorUI();
}

function updateCorridorUI(){
  const p = corridorProgress;
  const scale = 0.55 + p * 1.5;
  const vanEl = $('corrVanish');
  if (vanEl) vanEl.style.transform = 'translate(-50%,-50%) scale(' + scale.toFixed(3) + ')';
  if (corrBar) corrBar.style.width = (p * 100).toFixed(1) + '%';
}

function updateCorridor(realDt){
  if (corridorDone) return;
  if (state.keys['w']) corridorProgress += realDt * 0.32;

  if (corridorProgress >= 1){
    corridorProgress = 1;
    corridorDone = true;
    updateCorridorUI();
    setTimeout(() => {
      corridorUI.classList.add('hidden');
      if (corridorPhase === 'toilet'){
        startBathroom();
      } else {
        /* 回到座位：位置、朝向、许可状态全部复位 */
        state.view = 'world';
        state.keys = {};
        crosshair.classList.remove('hidden');
        requestLock();
        state.pos.set(0, 1.65, -2.08);
        state.yaw = 0; state.pitch = 0;
        yawTarget = 0; pitchTarget = 0;
        state.bathroomApproved = false;
        state.wanderTimer = 0;
        state.teacherWarnActive = false;
        toast('你回到了座位上，继续答题。', 2000);
        unlockAch('explorer');
      }
    }, 500);
    return;
  }
  updateCorridorUI();
}

/* ============================ 洗手间 ============================ */
const BATHROOM_STEPS = [
  { text: '走向小便池',       key: 'w',     hold: 1.8, hint: '按住 W 前进' },
  { text: '解手',             key: 'space', hold: 3.0, hint: '按住 空格 解手' },
  { text: '走向洗手池',       key: 'w',     hold: 1.6, hint: '按住 W 前进' },
  { text: '洗手',             key: 'space', hold: 2.5, hint: '按住 空格 洗手' },
  { text: '擦干双手',         key: 'space', hold: 1.5, hint: '按住 空格 擦干' },
  { text: '整理衣物，准备返回', key: 'e',   hold: 0,   hint: '按 E 离开洗手间' }
];

let bathroomStepIdx = 0, bathroomHold = 0, lastBathroomStepIdx = -1;

function startBathroom(){
  state.view = 'bathroom';
  releaseLock();
  state.keys = {};
  crosshair.classList.add('hidden');
  promptEl.classList.add('hidden');
  bathroomUI.classList.remove('hidden');
  bathroomStepIdx = 0;
  bathroomHold = 0;
  lastBathroomStepIdx = -1;
  updateBathroomUI();
}

function updateBathroomUI(){
  const step = BATHROOM_STEPS[bathroomStepIdx];
  if (!step) return;

  /* 只在步骤切换时写文本、重建圆点 —— 每帧重建 6 个 DOM 太浪费 */
  if (bathroomStepIdx !== lastBathroomStepIdx){
    lastBathroomStepIdx = bathroomStepIdx;
    bathStepText.textContent = step.text;
    bathHint.textContent = step.hint;
    bathSub.textContent = '第 ' + (bathroomStepIdx + 1) + ' / ' + BATHROOM_STEPS.length + ' 步';

    let html = '';
    for (let i = 0; i < BATHROOM_STEPS.length; i++){
      let cls = '';
      if (i < bathroomStepIdx) cls = 'done';
      else if (i === bathroomStepIdx) cls = 'on';
      html += '<i class="' + cls + '"></i>';
    }
    bathDots.innerHTML = html;
  }

  if (step.key === 'e') bathBar.style.width = '100%';
  else bathBar.style.width = Math.min(100, (bathroomHold / step.hold) * 100) + '%';
}

function updateBathroom(realDt){
  const step = BATHROOM_STEPS[bathroomStepIdx];
  if (!step) return;
  if (step.key === 'e'){ bathBar.style.width = '100%'; return; }

  let pressing = false;
  if (step.key === 'w' && state.keys['w']) pressing = true;
  if (step.key === 'space' && state.keys['space']) pressing = true;

  if (pressing){
    bathroomHold += realDt;
    if (bathroomHold >= step.hold){
      bathroomStepIdx++;
      bathroomHold = 0;
      if (bathroomStepIdx >= BATHROOM_STEPS.length){ finishBathroom(); return; }
      audio.beep(660, 0.06, 0.035);
    }
  } else {
    bathroomHold = Math.max(0, bathroomHold - realDt * 0.6);
  }
  updateBathroomUI();
}

function finishBathroom(){
  bathroomUI.classList.add('hidden');
  /* 洗手间现在是 3D 地点：解完手直接回到世界，就站在洗手间门口，
     之后自己走回 404（跨界时 checkBuildingDoors 会把许可复位）。 */
  state.view = 'world';
  state.keys = {};
  crosshair.classList.remove('hidden');
  requestLock();
  unlockAch('explorer');
  toast('你洗完了手，走出了洗手间。', 2000);
}
