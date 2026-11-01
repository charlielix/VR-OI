'use strict';
/* =========================================================================
   interact —— 准星交互判定（E / F / 左键）
   ---------------------------------------------------------------------
   判定优先级刻意排成这样：保安 → 老师 → 同学电脑/干扰 → 出口 → 桌面物品。
   越"打断性强"的目标越靠前，玩家在混战里按左键时不会误开草稿纸。

   另有一条重要约定：动作判定不依赖指针锁定。指针意外释放时，E / 左键
   依然能交互和出拳，只有"点击画面重捕鼠标"这一条兜底提示会变。
   ========================================================================= */

let lastInteractKey = '';

/* PUNCH_ARC / GUARD_PUNCH_RANGE / TEACHER_PUNCH_RANGE / NPC_DISTURB_RANGE
   都在 core.js：本文件在 combat.js 与 guards.js 之前加载，
   这些半径若声明在那两个文件里，加载期就会踩上暂时性死区。
   PUNCH_ARC 是攻击窗口的半角（0.4 rad ≈ 23°），比 360° 全向判定收紧很多 ——
   "正面对准"才有用，这是打击感的一部分。 */

/* arc 可选：空手用 PUNCH_ARC，武器传自己的半角进来（见 combat.js 的 punchArc）。
   注意 punchReach / punchArc / heldWeaponId 都在 combat.js ——
   本文件比它先加载，所以不能在这里写死半径，只能调函数。 */
function inAttackArc(x, z, arc){
  const half = (arc === undefined) ? PUNCH_ARC : arc;
  const fx = -Math.sin(state.yaw), fz = -Math.cos(state.yaw);
  const tx = x - state.pos.x, tz = z - state.pos.z;
  const len = Math.hypot(tx, tz);
  if (len < 1e-4) return true;                   /* 贴身也算 */
  return (fx * tx + fz * tz) / len > Math.cos(half);
}

function setPrompt(txt){
  if (lastInteractKey === txt) return;
  lastInteractKey = txt;
  promptEl.textContent = txt;
}

function updateInteract(){
  actionE = null; actionF = null; actionSpace = null;
  promptEl.classList.add('hidden');
  promptEl.classList.toggle('bright', aimingAtWhiteLight());

  if (state.view !== 'world' || !state.started || state.ended || state.frozen) return;

  /* 弹窗期间：场景交互全部让位给弹窗按钮 */
  if (hasDialog()){
    promptEl.classList.add('hidden');
    return;
  }

  /* ---- 校园区域：整套判定换一套 ----
     校园里没有保安、没有监考、也没有桌子。如果让流程继续往下走，
     会拿校园坐标去比房间的常量（比如门口距离 ROOM_W/2），
     于是站在校园里就被告知"离开考场需要先按 H 举手"。
     所以这里直接分流，校园有自己的优先级顺序（安检 → 志愿者 → 传送圈）。 */
  if (state.area === 'campus'){
    campusInteract();
    return;
  }

  /* ---- 1. 保安（房间 / 走廊都算）----
     保安会追出教室（main.js 的 updateGuards 在房间和走廊都跑），
     所以出了门也必须能打 —— 否则走廊里左键就完全没反应。 */
  for (let i = 0; i < securityGuards.length; i++){
    const g = securityGuards[i];
    if (!g.userData.alive) continue;
    const reach = punchReach();
    const d = Math.hypot(state.pos.x - g.group.position.x, state.pos.z - g.group.position.z);
    if (d < reach && inAttackArc(g.group.position.x, g.group.position.z, punchArc())){
      actionSpace = { fn: punchGuardsArc };
      const wId = heldWeaponId();
      setPrompt('[ 左键 ] ' + (wId ? '抡' + ITEMS[wId].name : '出拳') +
                '（拳锋 ' + reach.toFixed(1) + 'm · 前方扇形）');
      promptEl.classList.remove('hidden');
      return;
    }
  }

  /* ---- 2. 监考老师（房间 / 走廊追出来时都算）----
     必须限制在 room / hall：老师和玩家座位都在房间坐标系里，
     从校园那边看它们是"近在咫尺"的（校园整体平移到 +Z 500），
     少了这一条，你在校门口就能隔空出拳打老师。
     老师没在追的时候待在房间里，走廊这边的距离判定自然打不到。 */
  if ((state.area === 'room' || state.area === 'hall1' || state.area === 'hall2')
      && teacher && !teacher.userData.leaving && teacher.userData.mode !== 'warn'){
    const d = Math.hypot(state.pos.x - teacher.group.position.x, state.pos.z - teacher.group.position.z);
    if (d < TEACHER_PUNCH_RANGE && inAttackArc(teacher.group.position.x, teacher.group.position.z)){
      actionSpace = { fn: punchTeacher };
      setPrompt('[ 左键 ] 殴打监考老师（后果自负）');
      promptEl.classList.remove('hidden');
      return;
    }
  }

  /* ---- 走廊：过了保安 / 老师这一关，剩下的交给走廊专用判定 ---- */
  if (state.area === 'hall1' || state.area === 'hall2'){
    hallInteract();
    return;
  }

  /* ---- 3. 其他选手 ---- */
  for (let i = 0; i < npcs.length; i++){
    const n = npcs[i];
    const ud = n.userData;
    if (!ud) continue;
    const d = Math.hypot(state.pos.x - ud.seatX, state.pos.z - ud.seatZ);
    if (d >= 2.3) continue;

    if (ud.state === 'seated'){
      /* 监考倒台之后，同学也进入可攻击范围（此前不该有这条交互） */
      if (state.teacherDown){
        const dBody = Math.hypot(state.pos.x - n.group.position.x, state.pos.z - n.group.position.z);
        if (dBody <= GUARD_PUNCH_RANGE && inAttackArc(n.group.position.x, n.group.position.z)){
          actionSpace = { fn: () => downNPC(n) };
          setPrompt('[ 左键 ] 殴打同学 ' + ud.name + '（他已经不敢告老师了）');
          promptEl.classList.remove('hidden');
          return;
        }
      }
      const dBody = Math.hypot(state.pos.x - n.group.position.x, state.pos.z - n.group.position.z);
      if (dBody > NPC_DISTURB_RANGE) continue;
      actionF = { fn: () => disturbNPC(i) };
      setPrompt('[ F ] 干扰' + ud.name + '（他可能会报告老师）');
      promptEl.classList.remove('hidden');
      return;
    }

    if (ud.state === 'walking_away' || ud.state === 'away'){
      actionE = { fn: () => useNPCComputer(i) };
      setPrompt('[ E ] 使用' + ud.name + '的电脑');
      promptEl.classList.remove('hidden');
      return;
    }
  }

  /* ---- 4. 出口（+X 墙门洞 → 楼内走廊，见 checkBuildingDoors） ----
     404 的门能开关：关着按 E 开，开着直接走；终局白光门也在这个门洞。 */
  const dDoor = Math.hypot(state.pos.x - (ROOM_W / 2 - 0.15), state.pos.z);
  if (dDoor < 3.0){
    if (state.doorOpen){
      actionE = { fn: walkOutOfTheRoom };
      setPrompt('[ E ] 走出去');
    } else if (doorInteractPrompt()){
      /* 站在 404 门边：开门/关门提示由 doorInteractPrompt 接管 */
    } else {
      setPrompt(state.bathroomApproved
        ? '往前走就出考场（老师已批准，不会追）'
        : '往前走就出考场（老师会发现并追上来）');
    }
    promptEl.classList.remove('hidden');
    return;
  }

  /* ---- 5. 桌面物品（射线拾取） ---- */
  raycaster.setFromCamera(CENTER, camera);
  raycaster.far = 3.2;
  const hits = raycaster.intersectObjects(interactables, false);
  if (hits.length && hits[0].object.userData.interact){
    const it = hits[0].object.userData.interact;
    actionE = { fn: it.action };
    setPrompt('[ E ] ' + it.label);
    promptEl.classList.remove('hidden');
    return;
  }

  /* ---- 6. 兜底：指针释放了 ---- */
  if (!pointerLocked){
    setPrompt('鼠标已释放 —— 点击画面继续考试');
    promptEl.classList.remove('hidden');
  } else {
    lastInteractKey = '';
  }
}

function doInteract(key){
  if (state.view !== 'world' || state.ended || state.frozen) return;
  if (key === 'e' && actionE) actionE.fn();
  if (key === 'f' && actionF) actionF.fn();
  if (key === 'space' && actionSpace) actionSpace.fn();
}

function drinkWater(){
  audio.beep(520, 0.08, 0.05);
  setTimeout(() => audio.beep(420, 0.1, 0.04), 110);
  toast('你喝了一口水，感觉清醒了一些。', 1600);
}
