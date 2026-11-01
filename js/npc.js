'use strict';
/* =========================================================================
   npc —— 屏蔽词机制 + 选手 NPC 状态机
   ---------------------------------------------------------------------
   同学有完整的状态机：
     seated ──(被干扰 3 次)──▶ walking_away ──▶ away ──(5s)──▶ walking_back ──▶ seated
   走到监考处就开始告状（弹窗 + 警告计数），中途你可以去用他的电脑 ——
   这就是"偷看别人代码"的玩法闭环：你得先把人赶走。
   ========================================================================= */

/* ---------------------------- 屏蔽词 ---------------------------- */
function showBannedWordDialog(word){
  /* 弹窗是世界空间的，所以必须先收起 IDE 让世界重新可见 */
  closeCode();
  const display = word.toUpperCase();
  openDialog({
    title: '监考老师',
    text: '等等……\n\n' +
      '我在你的代码里看到了 "' + display + '"。\n\n' +
      '这是暴戾语言。根据《NOI 竞赛纪律》，考试期间任何形式的\n' +
      '不文明用语都会被记录，并取消本次比赛成绩。\n\n' +
      '请跟我去考务办公室。',
    options: [{
      label: '……（无法辩解）',
      cb: dlg => {
        closeDialog(dlg);
        endByBannedWord(word);
      }
    }]
  });
  audio.beep(180, 0.5, 0.06, 'sawtooth');
  setTimeout(() => audio.beep(120, 0.7, 0.06, 'sawtooth'), 250);
}

function endByBannedWord(word){
  if (state.ended) return;
  state.ended = true;
  hideAllPanels();
  clearGuards();
  unlockAch('banned');

  $('endTitle').textContent = '取 消 成 绩';
  $('endSub').textContent = '你的代码中包含暴戾语言 "' + word.toUpperCase() + '"。';
  showEnding(0,
    '监考老师把你的代码截了图，作为证据附在违纪记录里。\n' +
    '本次比赛成绩作废。\n\n' +
    '赛场上可以打暴力，不能打嘴炮。\n下次请注意文明用语。');
}

/* ---------------------------- 干扰同学 ---------------------------- */
const DISTURB_LINES = [
  '干嘛啊你？别动我键盘！',
  '……你走开，我正在想题。',
  '呜呜呜，我要举手了！',
  '老师！！有人捣乱！！'
];

const NPC_DOWN_LINES = [
  '你一拳放倒了同学！考场里彻底乱了。',
  '又倒一个。现在这排座位只剩你和键盘声。',
  '他趴下了，笔滚到了过道中间。'
];

/* 每干扰一次，他后面所有题的交卷时刻整体推后比赛时长的这个比例。
   没有这个，"干扰"就只剩"惹他生气" —— 花时间、冒违纪风险，换不来任何东西。
   取 0.06（约 14 分钟）是有讲究的：题与题之间本来就隔 0.13，
   所以连着干扰 3 次（正好是他起身去告状的那个阈值）才够掉一道题 ——
   于是"惹毛他 → 他离开 → 你偷看 → 他回来已经落后"闭成一个环。 */
const DISTURB_DELAY_FRAC = 0.06;

function disturbNPC(i){
  const n = npcs[i];
  if (!n || !n.userData || n.userData.state !== 'seated') return;
  if (state.view !== 'world' || state.ended || state.frozen) return;

  const ud = n.userData;
  ud.anger++;
  state.npcDelay[ud.name] = (state.npcDelay[ud.name] || 0) + DISTURB_DELAY_FRAC * CONTEST_LEN;
  audio.beep(280 + Math.random() * 200, 0.08, 0.04);
  audio.beep(180, 0.12, 0.05, 'triangle');

  /* 扭头看你一眼，再甩回去 */
  const dx = state.pos.x - n.group.position.x;
  const dz = state.pos.z - n.group.position.z;
  n.group.rotation.y = Math.atan2(dx, dz);
  n.head.rotation.x = -0.35;
  setTimeout(() => { if (n.head) n.head.rotation.x = 0; }, 350);

  const line = DISTURB_LINES[Math.min(ud.anger - 1, DISTURB_LINES.length - 1)];
  /* 顺口把那句机制说清楚一次，否则玩家永远不会知道干扰能拉低对方的榜位 */
  toast(ud.name + '：“' + line + '”　（他这题被打断，交卷要晚了）', 1900);
  state.wanderTimer = Math.max(0, state.wanderTimer - 1.5);

  if (npcs.filter(x => x.userData && x.userData.anger > 0).length >= 3) unlockAch('trouble');

  if (ud.anger >= 3){
    ud.state = 'walking_away';
    ud.timer = 0;
    toast(ud.name + ' 猛地站起来，朝监考老师走去了……', 2200);
    audio.beep(660, 0.1, 0.05);
  }
}

/* 每个选手做的是他自己的题 —— 按名字定，稳定可复现（同一台电脑永远是同一份）。
   关键：必须从**整本题库**里挑，而不是从 state.problems（你这一局的四道）里挑。
   以前所有人共用 state.npcProbId，而它是从你的四道题里抽的 ——
   于是你偷看谁的屏幕，看到的都是你正在做的那道题，标题都是 "// P90001"，
   看着就是你自己的电脑。 */
function npcProblemId(name){
  const pool = PROBLEM_POOL;
  if (!pool || !pool.length) return '';
  return pool[hashStr('prob|' + name) % pool.length].id;
}

function npcProblemName(name){
  const id = npcProblemId(name);
  const p = PROBLEM_BY_ID.get(id);
  return p ? p.name : id;
}

/* ---------------------------- 偷看他的电脑 ---------------------------- */
function useNPCComputer(i){
  const n = npcs[i];
  if (!n) return;
  const ud = n.userData;
  /* 只有"人在座位上"才拦。被打倒的人也得能看 ——
     他人都躺地上了，还回一句"他还在座位上"，是最让人火大的那种 bug。 */
  const away = ud.state === 'away' || ud.state === 'walking_away' || ud.state === 'down';
  if (!away){
    toast('他还在座位上，你不好动手。', 1500);
    return;
  }
  state.view = 'npcComputer';
  crosshair.classList.add('hidden');
  promptEl.classList.add('hidden');
  releaseLock();
  $('npcCompHead').textContent = ud.name + '的电脑';
  /* 把他的题名也显示出来 —— 不然"一个文件头 + 一段 C++"看起来全是你的电脑 */
  $('npcCompTag').textContent = '未经允许 · ' + npcProblemName(ud.name);
  $('npcCompCode').textContent = genNpcCode(ud.name, npcProblemId(ud.name));
  npcComputerUI.classList.remove('hidden');
  audio.beep(520, 0.06, 0.035);
  setTimeout(() => audio.beep(660, 0.06, 0.035), 90);

  /* 有时候会有人回来 —— 制造一点紧张 */
  if (Math.random() < 0.28){
    setTimeout(() => {
      if (state.view === 'npcComputer') toast('远处传来脚步声……有人回来了。', 2200);
    }, 3200);
  }
}

function closeNPCComputer(){
  npcComputerUI.classList.add('hidden');
  state.view = 'world';
  crosshair.classList.remove('hidden');
  requestLock();
}

/* 放倒同学（监考倒台后才可用）：部件炸散、组退场。
   userData.state 置为 'down'，状态机不认识它，会自然跳过。 */
function downNPC(n){
  if (!n || n.userData.state === 'down') return false;
  spawnBodyDebris(n.group, { speed: 3.2 });
  scene.remove(n.group);
  n.userData.state = 'down';
  n.userData.anger = 0;
  /* 记下被放倒的时刻：从这一刻起他不再交卷（rivals.js 用这个截断他的成绩）。
     否则把人打躺下之后榜上分数还在一路涨，打人就白打了。 */
  n.userData.downAt = state.elapsed;

  audio.punch();
  kickView(0.055, (Math.random() - 0.5) * 0.055);
  hitStop = 0.08;
  toast(NPC_DOWN_LINES[Math.floor(Math.random() * NPC_DOWN_LINES.length)], 1600);
  return true;
}

/* ---------------------------- 同学告状 ---------------------------- */
function triggerNPCComplaint(name){
  openDialog({
    title: '监考老师',
    text: name + '举手报告：“老师！他一直在干扰我答题！”\n\n' +
      '监考老师皱眉看向你：\n' +
      '“同学，比赛期间禁止干扰其他选手。这是第 ' + (state.warnCount + 1) +
      ' 次警告，再有下次就记录违纪了。”',
    options: [{
      label: '我知道了',
      cb: dlg => {
        closeDialog(dlg);
        state.warnCount++;
        if (teacher) teacher.userData.mode = 'patrol';
        state.wanderTimer = 0;
      }
    }]
  });
}

/* ---------------------------- 状态机 ---------------------------- */
function updateNPCs(realDt, t){
  for (let i = 0; i < npcs.length; i++){
    const n = npcs[i];
    const ud = n.userData;
    if (!ud || ud.state === 'down') continue;

    const upright = (ud.state === 'walking_away' || ud.state === 'away' || ud.state === 'walking_back');
    if (n.legsSit) n.legsSit.visible = !upright;
    if (n.legsStand) n.legsStand.visible = upright;

    if (ud.state === 'seated'){
      const v = Math.sin(t * 6 + n.phase) * 0.06;
      n.armL.rotation.x = v;
      n.armR.rotation.x = -v;
      n.head.rotation.x = Math.sin(t * 3 + n.phase) * 0.05;
      n.group.rotation.y += (ud.baseRot - n.group.rotation.y) * Math.min(1, realDt * 4);

    } else if (ud.state === 'walking_away'){
      const tx = 2.4, tz = 0;                     /* 监考常驻位置附近 */
      const dx = tx - n.group.position.x, dz = tz - n.group.position.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.5){
        n.group.position.set(tx, 0, tz);
        ud.state = 'away';
        ud.timer = 5.0;
        if (teacher) triggerNPCComplaint(ud.name);
        else toast(ud.name + '跑到监考处，发现老师不见了……', 2200);
      } else {
        const sp = 1.6 * realDt;
        n.group.position.x += (dx / d) * sp;
        n.group.position.z += (dz / d) * sp;
        n.group.rotation.y = Math.atan2(dx, dz);
        const v = Math.sin(t * 9 + n.phase) * 0.35;
        n.armL.rotation.x = v;
        n.armR.rotation.x = -v;
      }

    } else if (ud.state === 'away'){
      /* 在监考处站一会儿：老师没了就朝空处比划 */
      ud.timer -= realDt;
      const ty = teacher ? 0 : -5.5;
      n.group.rotation.y = Math.atan2(2.4 - n.group.position.x, ty - n.group.position.z);
      n.armL.rotation.x = -0.5 + Math.sin(t * 8) * 0.3;
      n.armR.rotation.x = -0.5 + Math.cos(t * 8) * 0.3;
      if (ud.timer <= 0) ud.state = 'walking_back';

    } else if (ud.state === 'walking_back'){
      const dx = ud.seatX - n.group.position.x;
      const dz = ud.seatZ - n.group.position.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.15){
        n.group.position.set(ud.seatX, 0, ud.seatZ);
        n.group.rotation.y = ud.baseRot;
        ud.state = 'seated';
        ud.anger = 0;
        n.armL.rotation.x = 0;
        n.armR.rotation.x = 0;
        n.head.rotation.x = 0;
      } else {
        const sp = 1.6 * realDt;
        n.group.position.x += (dx / d) * sp;
        n.group.position.z += (dz / d) * sp;
        n.group.rotation.y = Math.atan2(dx, dz);
        const v = Math.sin(t * 9 + n.phase) * 0.35;
        n.armL.rotation.x = v;
        n.armR.rotation.x = -v;
      }
    }
  }
}
