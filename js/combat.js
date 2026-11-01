'use strict';
/* =========================================================================
   combat —— 出拳 / 打监考 / 开门 / 最终结局
   ---------------------------------------------------------------------
   打击感 = 爆散(debris) + 视角回弹(kickView) + 顿帧(hitStop) + 合成音效。
   四样缺一样都会"软"。顿帧只减速世界逻辑，相机与计时不受影响，
   所以命中的那一瞬画面会凝住，而比赛时钟还在走 —— 这正是想要的。
   ========================================================================= */

/* TEACHER_PUNCH_RANGE 与 GUARD_PUNCH_RANGE 在 core.js —— 跨文件共用的
   交互半径统一由第一个加载的脚本持有，避免加载期暂时性死区 */

/* ---------------------------- 手上的武器 ----------------------------
   空手 = 拳锋 2.2m / 半角 0.4。手上那件武器按它自己的数值来。
   武器不是"另一种攻击"，它就是同一记挥击 —— 只是够得更远、扫得更宽、
   推得更狠、砸得更沉，而且会散架。所以出拳的判定、顿帧、爆散、通报全都复用。
   注意武器**不占快捷栏**（state.weapon 是独立的一格），
   否则打架时得在"武器 / 水 / 臭水"之间来回切 —— 那才是真的变弱。 */
/* 判的是 it.melee，不是 kind ——
   臭水的 kind 也是 '武器'（投掷类），按 kind 判会把它当成近战武器，
   于是 punchReach() 变成 2.2 + undefined = NaN，整条出拳判定静默失效。 */
function heldWeaponId(){
  const id = state.weapon || '';
  const it = id ? ITEMS[id] : null;
  if (!it || !it.melee || bagCount(id) <= 0) return '';
  return id;
}
function punchReach(){
  const id = heldWeaponId();
  return GUARD_PUNCH_RANGE + (id ? ITEMS[id].reach : 0);
}
function punchArc(){
  const id = heldWeaponId();
  return id ? ITEMS[id].arc : PUNCH_ARC;
}

/* 抡一下掉一次耐久。掉光了当场散架 —— 考场里的东西本来就不该是永久神装。
   最后三下会提前报，免得玩家以为还能一直抡。 */
function wearWeapon(id){
  if (!id) return;
  const it = ITEMS[id];
  const left = (state.weaponWear[id] === undefined ? it.uses : state.weaponWear[id]) - 1;
  if (left > 0){
    state.weaponWear[id] = left;
    if (left <= 3) toast(it.name + '快散架了（还能抡 ' + left + ' 下）。', 1600);
    return;
  }
  delete state.weaponWear[id];
  bagTake(id, 1);            /* bagTake 里会把 state.weapon 清成空手 */
  toast(it.name + '散架了。', 1900);
  audio.beep(160, 0.30, 0.06, 'square');
}

/* 把一名保安往外推开 + 让他踉跄一下。
   这就是"击退"：没被打倒的那些会被推出拳锋，短暂追不上来。
   位移逐轴判碰撞，撞墙时那一个轴不动（不能把人推进桌子里）。 */
function pushGuard(g, dist){
  const p = g.group.position;
  const dx = p.x - state.pos.x, dz = p.z - state.pos.z;
  const d = Math.hypot(dx, dz) || 1;
  let moved = false;
  const nx = p.x + (dx / d) * dist, nz = p.z + (dz / d) * dist;
  if (!collides(nx, p.z, 0.3)){ p.x = nx; moved = true; }
  if (!collides(p.x, nz, 0.3)){ p.z = nz; moved = true; }
  /* 踉跄：复用干呕那个"站着不动"的判定（guards.js 里 stunned 现在也认它） */
  g.userData.staggerUntil = state.worldTime + 0.45;
  return moved;
}

/* 统计挥击范围内（距离 + 扇形）的活保安。reach / arc 由手上的武器决定 */
function guardsInPunchRange(reach, arc){
  const out = [];
  for (const g of securityGuards){
    if (!g.userData.alive) continue;
    const d = Math.hypot(state.pos.x - g.group.position.x, state.pos.z - g.group.position.z);
    if (d <= reach + 0.3 && inAttackArc(g.group.position.x, g.group.position.z, arc)) out.push(g);
  }
  return out;
}

/* 击倒单个保安（扫拳的单元）。
   返回 false 表示本回合已结束（打满 200 触发隐藏结局，停止后续结算）。
   用引用而非索引：prune 之后索引会错位。 */
function killGuard(g, power){
  if (!g || !g.userData.alive) return true;
  g.userData.alive = false;
  /* power 越大碎块飞得越远 —— 这是"拿板凳砸下去更沉"的唯一可见证据。
     不传就是空手的 3.9。 */
  spawnBodyDebris(g.group, { speed: power || 3.9 });   /* 先炸散再摘组 */
  scene.remove(g.group);
  state.guardKills++;
  /* 掉补给。位置取保安倒下的地方（上面已经 scene.remove，但 position 还读得到）。 */
  maybeDropFromGuard(state.guardKills, g.group.position.x, g.group.position.z);
  if (state.guardKills >= GUARD_MAX_TOTAL){
    openFinalDoor();
    return false;
  }
  return true;
}

/* 一拳扫倒拳锋内所有保安（不是一个） */
function punchGuardsArc(){
  if (state.view !== 'world' || state.ended || state.frozen) return;

  /* 手上的武器：没选武器就是空手。判定和通报都跟着它走 */
  const wId = heldWeaponId();
  const wName = wId ? ITEMS[wId].name : '';

  const victims = guardsInPunchRange(punchReach(), punchArc());
  if (!victims.length){
    toast(wId ? '一' + wName + '抡了个空。' : '你的拳头抡了个空。', 1100);
    return;
  }

  let n = 0;
  const power = wId ? ITEMS[wId].power : 0;
  for (const g of victims){
    if (!killGuard(g, power)){ n++; break; }   /* 触发隐藏结局，停止结算 */
    n++;
  }
  if (state.ended) return;

  if (wId) wearWeapon(wId);

  /* ---- 击退 ----
     范围比拳锋大一圈、扇形也放宽：被打倒的不推（已经飞了），
     剩下的人被推开 + 踉跄 0.45 秒。空手也推，只是推得很近。
     这就是"拿武器更强"的手感来源 —— 不只是够得远，还能把人顶出去。 */
  const knock = wId ? ITEMS[wId].knock : 0.35;
  let pushed = 0;
  for (const g of guardsInPunchRange(punchReach() + 1.3, punchArc() + 0.2)){
    if (!g.userData.alive || victims.indexOf(g) >= 0) continue;
    if (pushGuard(g, knock)) pushed++;
  }

  audio.punch();
  kickView(0.06, (Math.random() - 0.5) * 0.06);
  hitStop = 0.09 + Math.min(0.06, n * 0.02);

  /* 通报里把击退也说出来 —— 不然"推开了几个人"是完全看不见的效果 */
  const tail = pushed > 0 ? '，还推开了 ' + pushed + ' 名' : '';
  if (wId){
    toast(wName + (n > 1 ? '抡倒 ' + n + ' 名' : '撂倒一个') + tail + '！', 1500);
  } else {
    toast((n > 1 ? '一拳放倒 ' + n + ' 名' : '一拳撂倒一个') + tail + '！', 1500);
  }
  checkGuardKillMilestones(state.guardKills);
  /* 一整拳只掷一次通报，避免连杀弹出一堆面板 */
  maybeGuardWarning();

  /* 每倒一名补一批，错开进场避免叠在一起 */
  for (let i = 0; i < n; i++){
    setTimeout(() => {
      if (state.ended) return;
      spawnTwoGuards();
      if (i === 0) toast('门口又冲进来两名替补保安……', 1700);
      audio.beep(200, 0.3, 0.06, 'sawtooth');
    }, 900 + i * 260);
  }
}

/* ---------------------------- 打监考老师 ---------------------------- */
/* 手机被没收过的话，打倒监考老师等于把它拿回来 —— 那部手机就在他桌角的收纳盒里。
   判 state.hasPhone 而不是 bagCount：confiscatePhone 是两样一起清的，
   reconcilePhone 读档时还会再对齐一次，所以这两份状态始终同一个值。
   返回 true 表示这次真的还了（调用方要因此播一句通报）。 */
function recoverPhoneFromTeacher(){
  if (state.hasPhone) return false;
  state.hasPhone = true;
  bagAdd('phone', 1);
  toast('你从他桌角的收纳盒里摸回了自己的手机。', 2400);
  return true;
}

function punchTeacher(){
  if (state.view !== 'world' || state.ended || state.frozen) return;
  if (!teacher || teacher.userData.leaving) return;
  teacher.userData.leaving = true;

  const d = Math.hypot(state.pos.x - teacher.group.position.x,
                       state.pos.z - teacher.group.position.z);
  /* 武器同样加长打老师的距离 —— 但他够得着你，你也够得着他，公平 */
  const tReach = TEACHER_PUNCH_RANGE + (heldWeaponId() ? ITEMS[heldWeaponId()].reach : 0);
  if (d > tReach){
    teacher.userData.leaving = false;
    toast('你离监考老师太远了。', 1400);
    return;
  }
  if (!inAttackArc(teacher.group.position.x, teacher.group.position.z, punchArc())){
    teacher.userData.leaving = false;
    toast('你一拳打向了空气 —— 对准老师再来。', 1300);
    return;
  }

  const dx = state.pos.x - teacher.group.position.x;
  const dz = state.pos.z - teacher.group.position.z;
  teacher.group.rotation.y = Math.atan2(dx, dz);
  teacher.armL.rotation.x = -1.4;
  teacher.armR.rotation.x = -1.4;

  audio.punch();
  spawnBodyDebris(teacher.group, { speed: 3.2 });
  kickView(0.045, (Math.random() - 0.5) * 0.05);
  hitStop = 0.07;

  toast('你一拳打在了监考老师的胳膊上……', 1600);
  unlockAch('teacher_hit');

  /* 监考已倒：从这一刻起同学也可以打了，并且你有了血条 */
  state.teacherDown = true;
  revealHp();
  recoverPhoneFromTeacher();

  setTimeout(() => {
    if (teacher){
      scene.remove(teacher.group);
      teacher = null;
    }
    toast('监考老师夺门而出，叫来了保安！', 2200);
    audio.beep(880, 0.15, 0.05, 'sawtooth');
    audio.beep(440, 0.25, 0.05, 'sawtooth');

    setTimeout(() => {
      if (state.ended) return;
      spawnTwoGuards();
      toast('两名保安从门口冲了进来！', 2600);
      audio.beep(140, 0.4, 0.07, 'sawtooth');
    }, 700);
  }, 800);
}

/* ---------------------------- 终局：开门 ---------------------------- */
/* 打完全部 200 名保安：不直接结算，先开门 + 弹警告，等玩家自己走出去 */
function openFinalDoor(){
  if (state.doorOpen || state.ended) return;
  openTheDoor();
  audio.beep(880, 0.3, 0.06, 'sine');
  setTimeout(() => audio.beep(1320, 0.4, 0.05, 'sine'), 260);
  toast('走廊尽头那扇门，开了。', 3000);

  /* 慢放 0.4s 再弹窗，让开门的动作先被看见 */
  setTimeout(() => {
    if (state.ended) return;
    openDialog({
      title: '警告',
      text: '门开了。\n\n' +
            '不是考场这一扇 —— 是走廊尽头那扇从来打不开的门。\n' +
            '它开的时候没有声音，只有光。白得不像这个考场里该有的东西。\n\n' +
            '保安们停下了动作，齐刷刷望向那个方向，然后让开了路。\n' +
            '广播里只剩电流噪音。你听见过这样的召唤吗？',
      options: [{ label: '去看看', cb: dlg => closeDialog(dlg) }]
    });
  }, 1400);
}

function openTheDoor(){
  state.doorOpen = true;
  doorLightMesh.visible = true;
  doorGlowMesh.visible = true;
  doorFloorMesh.visible = true;
}

/* 每帧推进开门动画（1.6s 平滑完成） */
function updateDoorLight(dt){
  if (!state.doorOpen || !doorGroup || doorOpenT >= 1) return;
  doorOpenT = Math.min(1, doorOpenT + dt / 1.6);
  const e = doorOpenT * doorOpenT * (3 - 2 * doorOpenT);   /* smoothstep */
  doorGroup.rotation.y = -1.9 * e;                          /* 约 109° */
  doorLightMesh.material.opacity = 0.45 + 0.55 * e;
  doorGlowMesh.material.opacity = 0.75 * e;
  doorFloorMesh.material.opacity = 0.9 * e;
  doorPointLight.intensity = 7 * e;
}

/* 准星是否指着门口白光（用于反色，保证准星可读） */
function aimingAtWhiteLight(){
  if (!state.doorOpen || doorOpenT < 0.12 || !doorLightMesh) return false;
  raycaster.setFromCamera(CENTER, camera);
  raycaster.far = 16;
  return raycaster.intersectObject(doorLightMesh, false).length > 0;
}

/* 真的走出白光：此时才结算 */
function walkOutOfTheRoom(){
  if (state.ended) return;
  endByTotalVictory();
}
