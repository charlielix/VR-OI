'use strict';
/* =========================================================================
   main —— 事件绑定 / 主循环 / 初始化入口
   ---------------------------------------------------------------------
   这一层只做三件事：把输入接到各系统上、按帧推进世界、把世界建起来。
   具体玩法都在各自的文件里（campus / world / player / npc / teacher / guards …），
   这里不重新实现任何一条规则 —— 一旦这里出现"老师怎么走""保安怎么追"，
   就会出现两份真相，改一处忘一处。

   两个时间基准要分清楚：
     · realDt       真实秒。UI、镜头、计时的"输入侧"用它。
     · worldDt      吃了顿帧与慢放的世界秒。NPC、AI、物理用它 ——
                    通报弹窗期间世界真的变慢，而比赛时钟照走。
   ========================================================================= */

let lastInteractUpdate = 0;
/* 通报弹窗期间的世界倍率（guards.js 调 beginSlowMo / endSlowMo） */
let slowMoScale = 1;

/* 世界时间步长：顿帧 × 慢放。考试计时用 realDt，不受这里影响 */
function worldDtFor(realDt){
  const hs = hitStop > 0 ? 0.12 : 1;
  return realDt * hs * slowMoScale;
}
function beginSlowMo(){ slowMoScale = 0.1; }
function endSlowMo(){ slowMoScale = 1; }

/* 滚轮切快捷栏：dir = +1 下一格 / -1 上一格，到头绕回去。
   单独抽成函数是为了能被直接测（滚轮事件在无头环境里不好造）。 */
function cycleHotbar(dir){
  const n = HOTBAR_SLOTS;
  if (!n) return state.hotbarIdx | 0;
  const cur = clamp(state.hotbarIdx | 0, 0, n - 1);
  const next = ((cur + dir) % n + n) % n;
  selectHotbar(next);
  return next;
}

/* 快速入场的作弊键：在校园里快速连按 3 次 Backspace / Delete，
   跳过安检直接坐进 404 —— 手机、背包一样都不没收（等价于绕过安检）。
   计数带时间窗，超过 FAST_ENTER_WINDOW 没按就重头算。 */
let fastEnterCount = 0, fastEnterLastAt = 0;
const FAST_ENTER_WINDOW = 1500, FAST_ENTER_N = 3;
function fastEnterKey(){
  const now = performance.now();
  if (now - fastEnterLastAt > FAST_ENTER_WINDOW) fastEnterCount = 0;
  fastEnterLastAt = now;
  fastEnterCount++;
  if (fastEnterCount >= FAST_ENTER_N){
    fastEnterCount = 0;
    fastEnterLastAt = 0;
    fastEnterExam();               /* 定义在 campus.js，跟随进楼那套时钟逻辑 */
  }
}

/* 这些视图下 3D 世界被全屏覆盖层盖住，可以跳过渲染 */
const VIEW_NO_RENDER = new Set([
  'code', 'paper', 'bag', 'phone', 'corridor', 'bathroom', 'npcComputer',
  'launcher', 'ending', 'pause'
]);

/* =========================================================================
   事件绑定
   ========================================================================= */
function bindEvents(){
  /* 左键 mousedown（不是 click）：
     ① 只认 button === 0，右键/中键什么都不做；
     ② 弹窗上悬停着按钮时，点击就是"确认那个按钮" —— 这一条不做的话，
        弹窗声明了能用鼠标点，点击却被前面的 return 吞掉，玩家就是"点了没反应"；
     ③ 未锁定时点击先申请指针锁定，不当作交互 —— 否则会变成
        "点了没反应、但世界状态已经变了"；
     ④ 其余情况：准星指着可攻击目标就出拳，否则普通交互。 */
  renderer.domElement.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    if (!state.started || state.ended) return;
    if (dlgHoverBtn){ activateDialogButton(); return; }
    if (hasDialog()){ if (!pointerLocked) requestLock(); return; }
    if (!pointerLocked && !actionSpace){ requestLock(); return; }
    doInteract(actionSpace ? 'space' : 'e');
  });

  document.addEventListener('keydown', e => {
    /* ---- 走廊 ---- */
    if (state.view === 'corridor'){
      if (e.code === 'KeyW' || e.code === 'ArrowUp'){
        state.keys['w'] = true; e.preventDefault();
      }
      return;
    }
    /* ---- 洗手间 ---- */
    if (state.view === 'bathroom'){
      if (e.code === 'KeyW'){ state.keys['w'] = true; e.preventDefault(); }
      if (e.code === 'Space'){ state.keys['space'] = true; e.preventDefault(); }
      const step = BATHROOM_STEPS[bathroomStepIdx];
      if (step && step.key === 'e' && e.code === 'KeyE'){
        finishBathroom(); e.preventDefault();
      }
      return;
    }
    /* ---- 同学的电脑 ---- */
    if (state.view === 'npcComputer'){
      if (e.code === 'Escape' || e.code === 'KeyE'){
        closeNPCComputer(); e.preventDefault();
      }
      return;
    }
    /* ---- 背包 ----
       必须单独路由 KeyB：下面那句 `state.view !== 'world'` 会把 B 一起拦掉，
       于是"按 B 打开"能开、"按 B"关不掉 —— 玩家会以为卡住了。 */
    if (state.view === 'bag'){
      if (e.code === 'KeyB'){ closeBag(); e.preventDefault(); }
      return;
    }
    /* ---- 手机 ----
       同一个坑：不单独路由，按 P 就关不掉，只剩 Esc 能关。 */
    if (state.view === 'phone'){
      if (e.code === 'KeyP'){ closePhone(); e.preventDefault(); }
      /* 停在 2048 那一屏时方向键归游戏，否则按一下就把页面滚走了 */
      else if (g2048HandleKey(e.code)) e.preventDefault();
      return;
    }

    /* ---- 电脑桌面 / 小恐龙 ----
       小恐龙开着的时候，方向键和空格归它 —— 不路由过去的话，
       按 ↓ 会滚动页面（而恐龙本该蹲下）。没开小恐龙就交给 Esc / 关窗。 */
    if (state.view === 'launcher'){
      if (dinoPane && !dinoPane.classList.contains('hidden')){
        dinoKey(e, true);
        return;
      }
      if (e.code === 'Escape'){ closeDesktop(); }
      return;
    }

    /* ---- Esc：关掉当前面板 ---- */
    if (e.code === 'Escape'){
      if (state.view === 'pause'){ closePauseMenu(); return; }
      if (state.view === 'code'){ closeCode(); return; }
      if (state.view === 'paper'){ closePaper(); return; }
      if (state.view === 'bag'){ closeBag(); return; }
      if (state.view === 'phone'){ closePhone(); return; }
      if (hasDialog()){ closeTeacherDialog(); return; }
      if (state.view === 'world' && state.started && !state.ended){
        /* 已锁定时交给 pointerlockchange 处理，避免一次 Esc 开两次面板 */
        if (!pointerLocked) openPauseMenu();
        return;
      }
      return;
    }
    if (state.view !== 'world') return;

    /* 左右方向键切快捷栏：数字键让给弹窗了，滚轮之外再留一路键盘 */
    if (e.code === 'ArrowLeft'){ cycleHotbar(-1); e.preventDefault(); return; }
    if (e.code === 'ArrowRight'){ cycleHotbar(1); e.preventDefault(); return; }

    /* Backspace / Delete 三连按：快速入场（见 fastEnterKey），
       只在校园阶段有效，进考场后按下也无害 */
    if (e.code === 'Backspace' || e.code === 'Delete'){
      fastEnterKey();
      e.preventDefault();
      return;
    }

    /* 数字键 1-9：**只**用来选弹窗的第 n 个选项。
       以前没弹窗时 1-4 还兼职选快捷栏，于是"打架时按 2 喝水"
       和"弹窗里按 2 选第二项"撞在一起 —— 一个键两种含义，必然出事。
       快捷栏改用滚轮（见下面的 wheel 监听）。 */
    if (hasDialog() && /^Digit[1-9]$/.test(e.code)){
      selectDialogOption(Number(e.code.slice(5)) - 1);
      e.preventDefault();
      return;
    }
    if (e.code === 'KeyQ'){ useSelectedItem(); return; }
    if (e.code === 'KeyB'){ openBag(); e.preventDefault(); return; }
    /* P：掏手机。弹窗期间不掏 —— 否则面板会盖在弹窗上，而弹窗没关会吞输入 */
    if (e.code === 'KeyP'){
      if (!hasDialog()) togglePhone();
      e.preventDefault();
      return;
    }

    const k = KEYMAP[e.code];
    if (k){
      state.keys[k] = true;
      if ('wasd'.includes(k)) e.preventDefault();
    }
    if (e.code === 'KeyE'){
      if (hasDialog()) activateDialogButton();          /* 弹窗优先 */
      else doInteract(actionSpace ? 'space' : 'e');
    }
    if (e.code === 'KeyF') doInteract('f');
    if (e.code === 'Space'){
      if (!hasDialog()) tryJump();                      /* 弹窗期间不跳，防误触 */
      e.preventDefault();
    }
    if (e.code === 'KeyH') callTeacher();
  });

  document.addEventListener('keyup', e => {
    if (state.view === 'corridor'){
      if (e.code === 'KeyW' || e.code === 'ArrowUp') state.keys['w'] = false;
      return;
    }
    if (state.view === 'bathroom'){
      if (e.code === 'KeyW') state.keys['w'] = false;
      if (e.code === 'Space') state.keys['space'] = false;
      return;
    }
    if (state.view === 'launcher'){
      if (dinoPane && !dinoPane.classList.contains('hidden')) dinoKey(e, false);
      return;
    }
    const k = KEYMAP[e.code];
    if (k) state.keys[k] = false;
  });

  window.addEventListener('blur', () => { state.keys = {}; });

  /* ---------- 指针锁定 ---------- */
  document.addEventListener('pointerlockchange', () => {
    pointerLocked = document.pointerLockElement === lockElement();
    if (pointerLocked) lastLockAt = performance.now();
    else if (state.view === 'world' && state.started && !state.ended) openPauseMenu();
  });
  document.addEventListener('pointerlockerror', () => {
    if (canLockView()) toast('鼠标锁定失败，点击画面重试。', 1600);
  });
  /* 鼠标位移 → 视角目标角；平滑由 applyLook 完成 */
  document.addEventListener('mousemove', e => {
    if (pointerLocked){
      if (!LOOK_VIEWS.has(state.view)) return;
      /* 锁定瞬间浏览器可能补发一次巨大位移，忽略头 120ms */
      if (performance.now() - lastLockAt < 120) return;
      const mx = clamp(e.movementX || 0, -MAX_MOUSE_STEP, MAX_MOUSE_STEP);
      const my = clamp(e.movementY || 0, -MAX_MOUSE_STEP, MAX_MOUSE_STEP);
      yawTarget   -= mx * mouseSens * SENS_SCALE;
      pitchTarget -= my * mouseSens * SENS_SCALE;
      pitchTarget = clamp(pitchTarget, -1.35, 1.35);
      return;
    }
    /* 未锁定：记录鼠标 NDC，供弹窗按钮拾取 */
    dlgMouseNdc.set((e.clientX / innerWidth) * 2 - 1,
                    -(e.clientY / innerHeight) * 2 + 1);
  });

  /* ---------- 滚轮切快捷栏 ----------
     数字键让给弹窗选项（见 keydown），所以切格子靠滚轮。
     一格一格地转，转到底绕回去 —— 4 格的东西不该需要"到头了"这种提示。

     必须判 state.started：开始界面的介绍卡片比视口高，玩家要滚轮往下滑
     才够得到「进入考场」。这里要是无条件 preventDefault，那个滚轮就死了 ——
     而玩家看到的症状是"开始界面滚轮用不了、按钮还点不到"。 */
  window.addEventListener('wheel', e => {
    if (!state.started || state.view !== 'world' || state.ended || state.frozen) return;
    const dir = e.deltaY > 0 ? 1 : (e.deltaY < 0 ? -1 : 0);
    if (!dir) return;
    e.preventDefault();
    cycleHotbar(dir);
  }, { passive: false });

  /* resize 防抖：拖窗口时避免反复重建 drawing buffer */
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      camera.aspect = innerWidth / innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(innerWidth, innerHeight);
      resizePostFX();
      dinoFitCanvas();
      forceRedraw = true;
    }, 150);
  });

  /* ---------- 滑条 ---------- */
  function bindSlider(id, apply){
    const el = $(id);
    if (!el) return;
    el.addEventListener('input', () => {
      apply(parseFloat(el.value));
      scheduleSaveViewSettings();
      syncViewUI();
    });
  }
  bindSlider('turnSliderStart',   v => mouseSens = sliderToSens(v));
  bindSlider('turnSlider',        v => mouseSens = sliderToSens(v));
  bindSlider('smoothSliderStart', v => smoothAmount = v / 100);
  bindSlider('smoothSlider',      v => smoothAmount = v / 100);
  bindSlider('timeSliderStart',   v => timeScale = v);
  bindSlider('timeSlider',        v => timeScale = v);
  bindSlider('volSliderStart',    v => audio.setVolume(v / 100));
  bindSlider('volSlider',         v => audio.setVolume(v / 100));
  bindSlider('guardSpeedSliderStart', v => guardSpeedScale = v / 100);
  bindSlider('guardSpeedSlider',      v => guardSpeedScale = v / 100);

  /* ---------- 开关 ---------- */
  const mt = $('muteToggle');
  if (mt){
    mt.classList.toggle('on', !audio.muted);
    mt.onclick = () => {
      audio.setMuted(!audio.muted);
      mt.classList.toggle('on', !audio.muted);
      saveViewSettings();
    };
  }
  for (const id of ['shakeToggle', 'shakeToggleStart']){
    const el = $(id);
    if (!el) continue;
    el.classList.toggle('on', shakeEnabled);
    el.onclick = () => {
      shakeEnabled = !shakeEnabled;
      el.classList.toggle('on', shakeEnabled);
      saveViewSettings();
    };
  }
  for (const id of ['combatFxToggle', 'combatFxToggleStart']){
    const el = $(id);
    if (!el) continue;
    el.classList.toggle('on', combatLightFx);
    el.onclick = () => {
      combatLightFx = !combatLightFx;
      el.classList.toggle('on', combatLightFx);
      saveViewSettings();
      toast(combatLightFx ? '战斗光影：开。' : '战斗光影：关（画面保持平时亮度）。', 1600);
    };
  }
  for (const id of ['guardSpawnSel', 'guardSpawnSelStart']){
    const el = $(id);
    if (!el) continue;
    el.value = guardSpawnMode;
    el.onchange = () => {
      guardSpawnMode = el.value;
      saveViewSettings();
      toast(guardSpawnMode === 'door' ? '保安将从考场门口固定涌入。'
          : guardSpawnMode === 'elevator' ? '保安将从电梯间一路跑进来。'
          : '保安将围着玩家随机出现。', 1800);
    };
  }

  /* ---------- 暂停菜单 ---------- */
  $('btnResume').onclick = closePauseMenu;
  $('btnPauseEnd').onclick = () => {
    if (confirm('确定要提前交卷离场吗？')){
      pauseMenu.classList.add('hidden');
      endContest(true);
    }
  };
  $('btnSave').onclick = () => { persistSave(); toast('进度已保存', 1200); };
  $('btnClearSave').onclick = () => { clearSave(); toast('存档已清除', 1200); };
  $('btnSettings').onclick = openPauseMenu;

  /* ---------- 各面板的关按钮 ---------- */
  const bindClick = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
  bindClick('btnCloseNPCComp', closeNPCComputer);
  bindClick('btnCloseDesktop', () => {
    if (dinoPane && !dinoPane.classList.contains('hidden')) dinoStop();
    closeDesktop();
  });
  bindClick('btnDinoBack', dinoStop);
  bindClick('btnLeave', closeCode);

  /* ---------- 代码编辑器 ---------- */
  codeArea.addEventListener('input', () => {
    saveCode();
    scheduleHighlight();
    if (Math.random() < 0.7) audio.key();
  });
  codeArea.addEventListener('keydown', e => {
    if (e.code === 'Tab'){
      e.preventDefault();
      const s = codeArea.selectionStart, en = codeArea.selectionEnd;
      codeArea.value = codeArea.value.substring(0, s) + '    ' +
                       codeArea.value.substring(en);
      codeArea.selectionStart = codeArea.selectionEnd = s + 4;
      saveCode();
      scheduleHighlight();
    }
    if (e.code !== 'Escape') e.stopPropagation();
  });
  codeArea.addEventListener('scroll', () => {
    codeHighlight.scrollTop = codeArea.scrollTop;
    codeHighlight.scrollLeft = codeArea.scrollLeft;
  });
  codeArea.addEventListener('keyup', e => {
    if (e.code !== 'Escape') e.stopPropagation();
  });
  codeArea.addEventListener('click', updateCursorInfo);
  codeArea.addEventListener('keyup', updateCursorInfo);

  $('btnSubmit').onclick = submitCode;
  $('btnReset').onclick = () => {
    const p = state.problems.find(x => x.id === state.curProb);
    if (!p) return;
    if (confirm('确定要重置本题代码吗？')){
      codeArea.value = p.starter;
      state.code[state.curProb] = p.starter;
      scheduleHighlight();
    }
  };
  $('btnEnd').onclick = () => {
    if (state.ended) return;
    if (confirm('确定要提前交卷离场吗？')) endContest(true);
  };
  $('btnRestart').onclick = () => { clearSave(); location.reload(); };
  $('btnClearSaveStart').onclick = () => {
    if (confirm('确定要清空存档吗？已保存的代码和进度都会丢失。')){
      clearSave();
      toast('存档已清除', 1500);
    }
  };

  /* ---------- 开始 ---------- */
  $('btnStart').onclick = () => {
    audio.init();
    audio.setVolume(audio.volume);
    $('start').classList.add('hidden');
    hud.classList.remove('hidden');
    minimapWrap.classList.remove('hidden');
    crosshair.classList.remove('hidden');
    state.started = true;
    yawTarget = state.yaw; pitchTarget = state.pitch;
    clock.getDelta();
    toast('入场开始！先沿砖路去第三教学楼过安检。WASD 移动，E 交互。', 2800);
    /* 点击按钮是用户手势，此时申请指针锁定成功率最高 */
    requestLock();
    if (tryLoadSave()) toast('已恢复上次的答题进度。', 2200);
  };
}

/* =========================================================================
   主循环
   ========================================================================= */
function animate(){
  requestAnimationFrame(animate);
  const realDt = Math.min(clock.getDelta(), 0.1);
  const t = performance.now() * 0.001;

  /* 时钟分两条：入场阶段只走 admitElapsed，考试时钟保持 0；
     真正进楼后（examStarted）才走 elapsed。这样早到不会白扣时间，
     迟到则从"超出 30 分钟预留"的那一段开始扣。 */
  if (state.started && !state.ended){
    if (state.examStarted){
      state.elapsed += realDt * timeScale;
      if (state.elapsed >= CONTEST_LEN) endContest(false);
    } else {
      state.admitElapsed += realDt * timeScale;
      if (state.admitElapsed >= EXAM_ENTRY_LIMIT + CONTEST_LEN){
        state.missedEntry = true;
        endContest(false);
      }
    }
  }

  if (hitStop > 0) hitStop -= realDt;
  /* 通报弹窗把世界放到 0.1x；弹窗消失（选项或 Esc）即恢复 */
  if (state.slowMoDlg && dialogs.indexOf(state.slowMoDlg) < 0){
    state.slowMoDlg = null;
    endSlowMo();
  }
  const worldDt = worldDtFor(realDt);
  state.worldTime += worldDt;

  const inWorld = state.view === 'world';

  if (inWorld && state.started && !state.ended && !state.frozen){
    applyLook(realDt);
    updatePlayer(worldDt);       /* 移动也吃慢放：通报期间世界真的变慢 */
  }

  /* 3D 悬浮弹窗：惯性追随 + 相切朝向 + 按钮拾取 */
  if (dialogs.length) updateDialogs(realDt);
  if (debrisList.length) updateDebris(worldDt);
  updateReticle(realDt);
  updateItemFx(realDt);

  if (state.view === 'corridor') updateCorridor(realDt);
  if (state.view === 'bathroom') updateBathroom(realDt);
  if (state.doorOpen) updateDoorLight(realDt);

  /* ---- 世界逻辑：只在世界视图下跑，避免在 IDE / 草稿纸里空跑 AI ---- */
  if (inWorld){
    if (state.area === 'campus'){
      /* 校园段：传送圈动画、跑路判定、封场广播、学生走动 */
      updateCampusArea(worldDt, t);
    } else {
      /* 老师 AI 的整棵状态机在 teacher.js 里 —— 房间巡场、楼内追击都在这儿推 */
      updateTeacher(worldDt, t);

      /* 越界切区：从 404 走出走廊 / 从走廊走回 404（见 building.js） */
      checkBuildingDoors();

      /* 教室门 10 秒自动关 */
      updateClassroomDoors();

      /* 保安 / 警灯：房间和走廊都追 —— 一旦开打，出了门也甩不掉追兵 */
      updateGuards(worldDt, t);

      if (state.area === 'room'){
        /* ---- 404 教室：选手 AI / 掉落物 / 紧张值 ---- */
        updateNPCs(worldDt, t);
        updatePickups(worldDt, t);
        updateTension(worldDt, state.guardKills, nearestGuardDist, lastMoveSpeed);
        setPostDamp(combatLightFx ? getTension() : 0);
      } else {
        /* ---- 楼内走廊（hall1/hall2）：外班同学发呆 + 被干扰 ---- */
        updateForeignNpcs(worldDt, t);
        updateTension(worldDt, state.guardKills, nearestGuardDist, lastMoveSpeed);
        setPostDamp(combatLightFx ? getTension() : 0);
      }
      updateGuardLights(nearestGuardDist, t);

      deepenContactShadows(t);
      scheduleDeskScreensUpdate();

      /* 被老师抓到擅自离场 5 次 → 时间锁定惩罚（wanderCount 只在 chaseCaught 累加） */
      if (state.started && !state.ended && !state.wanderPenaltyApplied
          && state.wanderCount >= 5){
        applyWanderPenalty();
      }
    }

    /* 交互提示：只在必要时刷新（每 80ms） */
    const now = performance.now();
    if (now - lastInteractUpdate > 80){
      lastInteractUpdate = now;
      updateInteract();
    }
  } else if (state.view !== 'pause' && state.view !== 'ending'){
    /* 开着面板时老师照样巡场：否则打开电脑就等于让时间停住，
       "玩小恐龙被老师撞见"这件事永远不会发生。只推进走位与那一眼。 */
    updateTeacherWhenPaused(t);
  }

  /* ---- HUD ---- */
  if (state.started && !state.ended){
    /* 入场阶段显示预留倒计时；超过 30 分钟后显示"迟到 + 现在进场还剩多少"；
       进楼之后才是真正的考试剩余时间。 */
    let remain, txt, warn;
    if (state.examStarted){
      remain = Math.max(0, CONTEST_LEN - state.elapsed);
      txt = fmtTime(remain);
      warn = remain < 1800;
    } else if (state.admitElapsed <= EXAM_ENTRY_LIMIT){
      remain = Math.max(0, EXAM_ENTRY_LIMIT - state.admitElapsed);
      txt = '入场 ' + fmtTime(remain);
      warn = remain < EXAM_RUSH_MARGIN;
    } else {
      const late = state.admitElapsed - EXAM_ENTRY_LIMIT;
      remain = Math.max(0, CONTEST_LEN - late);
      txt = '迟到 ' + fmtTime(remain);
      warn = remain < 1800;
    }
    if (hudTimer.textContent !== txt){
      hudTimer.textContent = txt;
      const ideTime = $('ideTime');
      if (ideTime) ideTime.textContent = fmtTime(remain);
    }
    hudTimer.classList.toggle('warn', warn);
    const alive = aliveGuardCount();
    const all = rivalCount();
    const rank = all > 1 ? playerRank(state.elapsed) : 1;
    const wId = heldWeaponId();
    const key = state.totalScore + '|' + state.warnCount + '|' + alive + '|' + rank + '|' + wId;
    if (hudScore.dataset.key !== key){
      hudScore.dataset.key = key;
      const guardInfo = alive > 0
        ? '　<span style="color:#ff6b78;font-size:16px">\u26A0 保安 ' + alive + '</span>'
        : '';
      const rankInfo = all > 1
        ? '　<span style="color:#8fa3c8;font-size:16px">第 ' + rank + '/' + all + ' 名</span>'
        : '';
      /* 手上那件武器要看得见 —— 不然换了武器、武器散了都只能靠猜 */
      const hand = wId
        ? '　<span style="color:#ffcc57;font-size:16px">手持 ' + ITEMS[wId].name + '</span>'
        : '';
      hudScore.innerHTML =
        '总分 <b>' + state.totalScore + '</b> / ' + TOTAL_MAX + '　' +
        '<span style="color:#5d6880;font-size:16px">警告 ' + state.warnCount + ' 次</span>' +
        guardInfo + rankInfo + hand;
    }
    const tn = getTension();
    hudTimer.classList.toggle('tense', tn > 0.05);
    minimapWrap.classList.toggle('tense', tn > 0.05);
    drawMinimap();

    /* ---- 名次变化要出声 ----
       HUD 上那个"第 N 名"数字变化本身太安静：玩家的实际感受是
       "我好像一直第一名"。所以谁超过了你、你超过了谁，都直说。 */
    if (rank !== state.lastRank){
      const was = state.lastRank;
      state.lastRank = rank;
      if (was && rank > was){
        const who = rivalNeighbor(state.elapsed, true);
        toast((who || '有人') + '超过了你 —— 现在第 ' + rank + ' 名', 2000);
        audio.beep(300, 0.10, 0.05, 'square');
      } else if (was && rank < was){
        const who = rivalNeighbor(state.elapsed, false);
        toast('你超过了' + (who || '一个人') + ' —— 现在第 ' + rank + ' 名', 2000);
      }
    }
  }

  /* ---- 渲染 ---- */
  if (!VIEW_NO_RENDER.has(state.view) || forceRedraw){
    renderFrame(realDt);
    forceRedraw = false;
  }
}

/* =========================================================================
   初始化
   ========================================================================= */
function init(){
  loadViewSettings();
  syncViewUI();

  renderer = new THREE.WebGLRenderer({
    canvas: $('scene'),
    antialias: true,
    powerPreference: 'high-performance'
  });
  /* DPR 上限 1.5：视觉差异极小，填充率大幅下降 */
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(innerWidth, innerHeight);
  if (THREE.sRGBEncoding) renderer.outputEncoding = THREE.sRGBEncoding;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x090b11);
  scene.fog = new THREE.FogExp2(0x090b11, 0.038);

  camera = new THREE.PerspectiveCamera(74, innerWidth / innerHeight, 0.05, 120);
  camera.rotation.order = 'YXZ';

  scene.add(new THREE.AmbientLight(0xffffff, 0.42));
  scene.add(new THREE.HemisphereLight(0xc8d8ff, 0x232833, 0.5));

  /* 玩家状态：出生点在校门外，面朝校园（yaw = 0 即 -Z） */
  state.pos = new THREE.Vector3(CP.x + CAMPUS_SPAWN.x, PLAYER_EYE, CP.z + CAMPUS_SPAWN.z);
  state.yaw = CAMPUS_SPAWN.yaw;
  state.pitch = 0;
  yawTarget = state.yaw;
  pitchTarget = 0;
  camera.position.copy(state.pos);
  camera.rotation.set(0, state.yaw, 0);

  state.problems = pickProblems();
  state.curProb = state.problems[0].id;

  /* 房间先建（registerRoomObstacles 要用到它登记的桌椅），
     校园最后建 —— buildCampusArea 会把 obstacles 换成校园那一套。 */
  buildWorld();
  buildBuildingArea();
  buildCampusArea();
  updateAllDeskScreens();
  initReticle();
  initPostFX();
  initGuardLights();
  initTension();
  initHp();
  initCampusLights();
  initBag();
  ensurePickups();

  bindEvents();
  initPaperEvents();
  initPhoneEvents();
  renderHudProbs();

  clock = new THREE.Clock();
  animate();

  /* ---- 供自动化 / 调试使用 ----
     state / scene / renderer 给 browsercheck 读；launcher.dinoState() 和
     mouse.* 是 smoke 的测试夹具 —— 小恐龙状态和指针锁定提示的内部变量
     都是模块级 let，不是 sandbox 的属性，只能从这里进出。 */
  window.__OI__ = {
    state: state, scene: scene, camera: camera, renderer: renderer,
    judgeCode: judgeCode, pickProblems: pickProblems,
    guardWarnTier: guardWarnTier, tensionTarget: tensionTarget,
    PROBLEM_POOL: PROBLEM_POOL,
    launcher: {
      dinoState: () => ({
        running: dinoRunning, over: dinoOver, score: dinoScore, speed: dinoSpeed,
        y: dinoY, onGround: dinoOnGround, obstacles: dinoObs.length,
        high: state.dinoHigh
      })
    },
    mouse: {
      reset(){ lockHintAt = 0; lockHintArmed = false; lastLockTryAt = 0; clearToasts(); },
      setLastTry(v){ lastLockTryAt = v; },
      setHintAt(v){ lockHintAt = v; },
      clearToasts(){ clearToasts(); },
      watchLockHint(){ watchLockHint(); },
      lastToast(){ return String(toastStack.dataset.last || ''); },
      armed(){ return lockHintArmed; }
    },
    campus: {
      switchArea: switchArea,
      campusInteract: campusInteract,
      teleportToExamDoor: teleportToExamDoor,
      doSecurityCheck: doSecurityCheck,
      enter404Classroom: enter404Classroom,
      enterSideDoor: enterSideDoor,
      talkToVolunteer: talkToVolunteer,
      portalRing: portalRing,
      CP: CP, CAMPUS_SPAWN: CAMPUS_SPAWN,
      CAMPUS_PORTAL_X: CAMPUS_PORTAL_X, CAMPUS_PORTAL_Z: CAMPUS_PORTAL_Z,
      CAMPUS_AUDIT_Z: CAMPUS_AUDIT_Z
    }
  };
}
