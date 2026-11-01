'use strict';
/* =========================================================================
   teacher —— 监考老师：巡逻 / 抓走动 / 惩罚 / 举手对话
   ---------------------------------------------------------------------
   老师的巡逻路线是一条"超椭圆"（|x/a|^n + |z/b|^n = 1，n = 0.7）：
   比正椭圆更方，一个人绕场一圈的轨迹更接近真实的巡查习惯。
   玩家离开座位超过 2 秒就被叫去谈话；五次随意走动触发"时间锁定"惩罚 ——
   监考在你低头记录时偷偷把挂钟拨快一大格，这个惩罚刻意不解释。
   ========================================================================= */

const TEACHER_WARNINGS = [
  '同学，比赛期间请不要随意走动，回到自己座位上。',
  '我刚才提醒过你了。再走动我要记录违纪了。',
  '这是最后一次口头警告，请立刻回到座位。',
  '……你再乱走，我就只能按考场纪律处理了。'
];

const TEACHER_PATROL_A = 6.5, TEACHER_PATROL_B = 5.5, TEACHER_PATROL_N = 0.7;
const TEACHER_SPEED = 3.2;
const WANDER_RADIUS = 3.5;      /* 离座位多远算"走动" */
const WANDER_GRACE = 2.0;       /* 持续多久才叫老师 */

/* 老师踱到座位旁边时的那一眼 */
const TEACHER_PEEK_RADIUS = 3.4;
/* 冷却按世界时钟算（≈真实秒）。用比赛时钟会变成不到 1 秒 ——
   比赛时钟跑的是 timeScale 倍速，14 个比赛秒只有 0.9 秒真时间。 */
const TEACHER_PEEK_COOLDOWN = 18;
let teacherPeekUntil = 0;

/* 超椭圆参数点 */
function patrolPoint(theta){
  const c = Math.cos(theta), s = Math.sin(theta);
  return {
    x: TEACHER_PATROL_A * Math.sign(c) * Math.pow(Math.abs(c), TEACHER_PATROL_N),
    z: TEACHER_PATROL_B * Math.sign(s) * Math.pow(Math.abs(s), TEACHER_PATROL_N)
  };
}

function updateTeacher(worldDt, t){
  if (!teacher || state.frozen) return;
  const tm = teacher.userData;
  const pos = teacher.group.position;

  if (tm.mode === 'patrol'){
    const p1 = patrolPoint(t * 0.15);
    const p2 = patrolPoint(t * 0.15 + 0.02);
    pos.x = p1.x;
    pos.z = p1.z;
    pos.y = Math.abs(Math.sin(t * 4)) * 0.008;      /* 走路时极轻微起伏 */
    teacher.group.rotation.y = Math.atan2(p2.x - p1.x, p2.z - p1.z);

  } else if (tm.mode === 'approach'){
    const dx = state.pos.x - pos.x, dz = state.pos.z - pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 1.4){
      tm.mode = 'warn';
      teacher.group.rotation.y = Math.atan2(dx, dz);
      showTeacherWarning();
    } else {
      const sp = TEACHER_SPEED * worldDt;
      const nx = pos.x + (dx / d) * sp, nz = pos.z + (dz / d) * sp;
      if (!collides(nx, pos.z, 0.3)) pos.x = nx;
      if (!collides(pos.x, nz, 0.3)) pos.z = nz;
      teacher.group.rotation.y = Math.atan2(dx, dz);
    }

  } else if (tm.mode === 'warn'){
    /* 站定盯着你 */
    teacher.group.rotation.y = Math.atan2(state.pos.x - pos.x, state.pos.z - pos.z);

  } else if (tm.mode === 'returning'){
    const target = patrolPoint(t * 0.15);
    const dx = target.x - pos.x, dz = target.z - pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.3){
      tm.mode = 'patrol';
    } else {
      const sp = 3.0 * worldDt;
      pos.x += (dx / d) * sp;
      pos.z += (dz / d) * sp;
      teacher.group.rotation.y = Math.atan2(dx, dz);
    }

  } else if (tm.mode === 'chase'){
    /* 追出考场：在全楼范围内追玩家，追上就押回座位 */
    const dx = state.pos.x - pos.x, dz = state.pos.z - pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 1.4){
      tm.mode = 'warn';
      chaseCaught();
    } else if (d > 0.001){
      const sp = (TEACHER_SPEED + 0.8) * worldDt;
      const nx = pos.x + (dx / d) * sp, nz = pos.z + (dz / d) * sp;
      if (!collides(nx, pos.z, 0.3)) pos.x = nx;
      if (!collides(pos.x, nz, 0.3)) pos.z = nz;
      teacher.group.rotation.y = Math.atan2(dx, dz);
    }
  }
}

/* ---------------------------- 老师的那一眼 ----------------------------
   巡逻时他会瞄一眼你的屏幕。开着电脑桌面（小恐龙、乱逛文件夹）或者
   正在翻同学的电脑，他就当场给你关掉、记一次警告。
   在此之前小恐龙是纯白送的分数、老师的巡逻只是布景 —— 这一眼把整屋子的
   氛围从"布景"变成"风险"，而且它只在你真的在摸鱼时触发，不冤枉人。

   两个必须记住的数（都是量出来的，不是估的）：
     · 巡逻轨迹到座位最近只有 2.5 —— 半径设成 2.0 就永远触发不到；
     · 他每圈只有约 3 秒会进到 3.4 以内，所以这不是"一直盯着你"，
       而是"每 42 秒有一段窗口"。连着玩小恐龙，多半会撞上一次。 */
function checkTeacherPeek(){
  if (!teacher || state.ended || state.frozen || state.area !== 'room') return;
  const tm = teacher.userData;
  if (tm.mode !== 'patrol') return;            /* 正在抓你走动时不用另算 */
  if (state.worldTime < teacherPeekUntil) return;

  const v = state.view;
  if (v !== 'launcher' && v !== 'npcComputer' && v !== 'phone') return;

  const d = Math.hypot(teacher.group.position.x - state.pos.x,
                       teacher.group.position.z - state.pos.z);
  if (d > TEACHER_PEEK_RADIUS) return;

  teacherPeekUntil = state.worldTime + TEACHER_PEEK_COOLDOWN;

  if (v === 'launcher') closeDesktop();
  else if (v === 'phone'){
    /* 手机比小恐龙严重：货还在手上。当场没收，并记一笔"人赃并获" */
    confiscatePhone();
    unlockAch('phone_caught');
  }
  else closeNPCComputer();
  /* 从 IDE 打开的桌面会退回 IDE，那里放不下世界里的弹窗，干脆一起收掉 */
  if (state.view === 'code') closeCode();

  state.warnCount++;                           /* 只算警告：人一直在座位上，不算走动 */
  audio.beep(200, 0.28, 0.06, 'square');
  toast(v === 'launcher'
    ? '监考老师在你身后站住了：“……小恐龙？” 他伸手把显示器关掉了。'
    : v === 'phone'
      ? '监考老师：“手机。” 他伸出手，什么也没多问。手机被收走了。'
      : '监考老师：“这个座位不是你的吧。” 他把你从同学的电脑前撵了回去。', 3300);
}

/* 面板视图下老师照样巡场。
   否则打开电脑就等于让时间停住 —— updateTeacher() 挂在 view==='world' 分支里，
   你在 launcher 视图时他根本不动，"玩小恐龙被老师撞见"这件事永远不会发生。
   这里只推进巡逻走位、只跑这一眼；模式机（走过来抓人那套）仍归 world 分支，
   免得他在你开着面板时突然弹一个世界空间对话框出来。 */
function updateTeacherWhenPaused(t){
  if (!teacher || state.area !== 'room') return;
  const tm = teacher.userData;
  if (tm.mode !== 'patrol') return;
  const p1 = patrolPoint(t * 0.15);
  const p2 = patrolPoint(t * 0.15 + 0.02);
  teacher.group.position.x = p1.x;
  teacher.group.position.z = p1.z;
  teacher.group.position.y = Math.abs(Math.sin(t * 4)) * 0.008;
  teacher.group.rotation.y = Math.atan2(p2.x - p1.x, p2.z - p1.z);
  checkTeacherPeek();
}

function triggerTeacherWarning(){
  if (!teacher) return;
  state.warnCount++;
  state.wanderCount++;
  state.teacherWarnActive = true;
  state.wanderTimer = 0;
  teacher.userData.mode = 'approach';
}

/* 五次走动 → 时间锁定：剩余虚拟时间压回 10 分钟，流速锁到 30x，
   让这 10 分钟在 20 秒内跑完。滑条会被禁用并显示"锁定"。 */
function applyWanderPenalty(){
  if (state.wanderPenaltyApplied) return;
  state.wanderPenaltyApplied = true;

  state.elapsed = CONTEST_LEN - 600;
  timeScale = 30;

  ['timeSliderStart', 'timeSlider'].forEach(id => {
    const e = $(id);
    if (e){ e.disabled = true; e.style.opacity = '0.4'; }
  });
  const sv1 = $('timeValueStart'), sv2 = $('timeValue');
  if (sv1) sv1.textContent = '锁定';
  if (sv2) sv2.textContent = '锁定';

  toast('监考老师低头在记录本上写了些什么。等你再抬头时，' +
        '挂钟的指针不知为何跳了一大格。', 5000);
  audio.beep(220, 0.5, 0.05, 'sawtooth');
  setTimeout(() => audio.beep(160, 0.6, 0.05, 'sawtooth'), 250);
}

function showTeacherWarning(){
  const idx = Math.min(state.warnCount - 1, TEACHER_WARNINGS.length - 1);
  openDialog({
    title: '监考老师（第 ' + state.warnCount + ' 次警告）',
    text: TEACHER_WARNINGS[idx],
    options: [{
      label: '好的老师，我马上回去！',
      cb: dlg => {
        closeDialog(dlg);
        if (teacher) teacher.userData.mode = 'returning';
        state.teacherWarnActive = false;
        state.wanderTimer = 0;
      }
    }]
  });
}

/* ---------------------------- 追出考场 ---------------------------- */
/* 老师追到当前楼层：1F 就从 404 门口追出来，2F 从西墙尽头追出来 */
function relocateTeacherToFloor(){
  if (!teacher) return;
  const z = currentFloorZ();
  teacher.group.position.set(BD_X0 + 0.5, 0, z - 3);
}

function enterTeacherChase(){
  if (!teacher || state.ended || state.frozen) return;
  const tm = teacher.userData;
  if (tm.mode === 'chase'){ relocateTeacherToFloor(); return; }
  if (tm.mode === 'warn' || tm.mode === 'approach') return;
  tm.mode = 'chase';
  relocateTeacherToFloor();
  toast('监考老师追了出来：“现在是考试时间！”', 3000);
  audio.beep(300, 0.28, 0.05, 'square');
}

function stopTeacherChase(){
  if (!teacher) return;
  const tm = teacher.userData;
  if (tm.mode === 'chase' || tm.mode === 'warn'){
    tm.mode = 'patrol';
    teacher.group.position.set(2.4, 0, 0);
  }
}

function chaseCaught(){
  if (state.ended) return;
  state.warnCount++;
  state.wanderCount++;
  state.teacherWarnActive = true;
  openDialog({
    title: '监考老师（第 ' + state.warnCount + ' 次警告）',
    text: '老师一把抓住你的胳膊：“擅自离开考场，跟我回座位。”\n\n' +
          '他押着你穿过走廊，把你按回了椅子上。',
    options: [{
      label: '……知道了',
      cb: dlg => {
        closeDialog(dlg);
        state.teacherWarnActive = false;
        state.bathroomApproved = false;
        state.wanderTimer = 0;
        switchArea('room');
        state.pos.set(SEAT_CENTER_X, 1.65, SEAT_CENTER_Z + 0.92);
        state.yaw = 0; state.pitch = 0; yawTarget = 0; pitchTarget = 0;
        if (teacher){ teacher.userData.mode = 'patrol'; teacher.group.position.set(2.4, 0, 0); }
        toast('你被老师押回了座位。', 2000);
        audio.beep(220, 0.3, 0.05, 'sawtooth');
      }
    }]
  });
}

/* ---------------------------- 举手（H） ---------------------------- */
function callTeacher(){
  if (state.view !== 'world' || state.ended || state.frozen) return;
  if (!teacher){
    toast('监考老师已经跑了……没人能帮你了。', 2000);
    return;
  }

  const opts = [];
  if (!state.bathroomApproved){
    opts.push({
      text: '老师，我想去洗手间',
      reply: '好，去吧。出门右转走到头就是。快去快回，别耽误太久。',
      action: () => {
        state.bathroomApproved = true;
        toast('老师同意了。直接往前走就能出考场。', 3000);
      }
    });
  } else {
    opts.push({ text: '我已经获得许可了', reply: '嗯，那你去吧，快去快回。' });
  }
  opts.push(
    { text: '我这道题读不懂题意', reply: '你先自己再读一遍题面。如果确实是题目描述有歧义，我会帮你记录，但不解释算法。' },
    { text: '我的电脑好像有点问题', reply: '稍等，我看看……嗯，重启一下编译器试试？不行的话我给你换台机器。' },
    { text: '我想再要一张草稿纸', reply: '好的，一会儿给你送过来。' },
    { text: '没事了，谢谢老师', reply: '好的，继续加油。' }
  );

  showTeacherDialog('同学，有什么事吗？', opts);
}

function showTeacherDialog(text, options){
  /* 选项按钮进入"回复态"：不关弹窗，只把正文换成老师的回答，
     按钮替换成一个关闭用的"好的" */
  openDialog({
    title: '监考老师',
    text: text,
    options: options.map(opt => ({
      label: opt.text,
      cb: dlg => {
        if (opt.action) opt.action();
        setDialogContent(dlg, {
          text: opt.reply,
          options: [{ label: '好的', cb: d => closeDialog(d) }]
        });
      }
    }))
  });
}

function closeTeacherDialog(){
  dismissDialogs();
  crosshair.classList.remove('hidden');

  /* Esc 关掉警告窗时必须兜底复位：
     否则 teacherWarnActive 一直是 true、老师卡在 'warn' 模式，
     之后玩家再走动就永远检测不到 */
  if (state.teacherWarnActive){
    state.teacherWarnActive = false;
    state.wanderTimer = 0;
    if (teacher && teacher.userData.mode === 'warn') teacher.userData.mode = 'returning';
  }
}
