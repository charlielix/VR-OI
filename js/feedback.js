'use strict';
/* =========================================================================
   feedback —— 字幕堆叠与成就解锁
   ========================================================================= */

const TOAST_MAX = 4;
const activeToasts = new Map();      /* text → { el, num, count, timer } */
let toastClock = 0;

/* 同内容的提示不重复起幕，只在尾部累计 x2 / x3 并刷新存活时间；
   超过 TOAST_MAX 条时立刻收起最早的一条，避免糊满半个屏幕。 */
function toast(text, ms){
  const dur = ms || 2000;

  /* 记下最后一条，只给调试/测试用（不参与游戏逻辑）。
     挂在 toastStack 元素上而不是新增全局变量：多一个模块级 let
     就多一份跨文件暂时性死区的风险，而这里只需要"能读到"。 */
  try { toastStack.dataset.last = text; } catch(e){}

  const hit = activeToasts.get(text);
  if (hit){
    hit.count++;
    hit.num.textContent = 'x' + hit.count;
    clearTimeout(hit.timer);
    hit.timer = setTimeout(() => hideToast(text), dur);
    hit.el.classList.remove('bump');
    void hit.el.offsetWidth;             /* 强制重排以重启动画 */
    hit.el.classList.add('bump');
    return;
  }

  const el = document.createElement('div');
  el.className = 'toast';
  const body = document.createElement('span');
  body.textContent = text;
  const num = document.createElement('i');
  num.className = 'n';
  el.appendChild(body);
  el.appendChild(num);
  toastStack.appendChild(el);

  const rec = { el: el, num: num, count: 1, timer: 0 };
  rec.timer = setTimeout(() => hideToast(text), dur);
  activeToasts.set(text, rec);
  toastClock++;

  while (activeToasts.size > TOAST_MAX){
    hideToast(activeToasts.keys().next().value);
  }
}

function hideToast(text){
  const rec = activeToasts.get(text);
  if (!rec) return;
  activeToasts.delete(text);
  clearTimeout(rec.timer);
  rec.el.classList.add('out');
  setTimeout(() => rec.el.remove(), 320);
}

function clearToasts(){
  for (const k of Array.from(activeToasts.keys())) hideToast(k);
  /* 调试记录也要一起清。不清就会留上一条文本，
     而"最后一条提示"正是测试用来判断有没有误报的依据 ——
     残留会让后续断言拿到过期值、把"没提示"误判成"提示了"。 */
  try { delete toastStack.dataset.last; } catch(e){}
}

/* ---------------------------- 成就 ---------------------------- */
const ACHIEVEMENTS = {
  first_ac:    { name: '初次 AC',   desc: '拿到第一道题的 Accepted' },
  full_score:  { name: '满分大神',  desc: '四道题全部 AC' },
  submitter:   { name: '一个都不落', desc: '四道题每道都至少提交过一次' },
  guard_5:     { name: '格斗入门',  desc: '击倒 5 名保安' },
  guard10:     { name: '初露拳脚',  desc: '击倒 10 名保安' },
  guard20:     { name: '考场一害',  desc: '击倒 20 名保安' },
  guard50:     { name: '保安克星',  desc: '击倒 50 名保安' },
  guard100:    { name: '百人斩',    desc: '击倒 100 名保安' },
  army:        { name: '一人军队',  desc: '击倒全部 200 名保安（隐藏结局）' },
  clean_run:   { name: '安分守己',  desc: '零警告完赛' },
  zero_king:   { name: '零分传奇',  desc: '交卷时 0 分' },
  trouble:     { name: '校园霸王',  desc: '干扰 3 名选手' },
  speedrun:    { name: '神速交卷',  desc: '1 小时内交卷' },
  banned:      { name: '失言者',    desc: '因屏蔽词被取消成绩' },
  teacher_hit: { name: '袭师者',    desc: '殴打了监考老师' },
  explorer:    { name: '厕所旅行家', desc: '完整去过一次洗手间' },
  wanderer:    { name: '红圈五连',  desc: '同一场考试五次擅自离场被老师抓回' },
  escape:      { name: '开小差',    desc: '未经许可走出考场（老师会追）' },
  hall_mischief: { name: '串门捣蛋', desc: '干扰 5 名外班同学' },

  /* ---- 校园段（从校门口走到考场） ---- */
  portal:      { name: '走个捷径',   desc: '第一次使用校门口的传送光圈' },
  security:    { name: '正规入场',   desc: '老老实实从正门进来，再过安检通道' },
  sideentry:   { name: '不正规入场', desc: '没走安检 —— 从员工通道进的楼' },
  rush:        { name: '压线进场', desc: '入场预留只剩 3 分钟内才进考场' },
  late:        { name: '缺考',     desc: '入场预留 + 4 小时都过了仍未进场 —— 本场没有成绩' },
  late_entry:  { name: '迟到入场', desc: '开考 30 分钟后才进考场 —— 按迟到扣除考试时间' },
  phone:       { name: '夹带',       desc: '把没封存的手机带进了考场，还掏出来看了' },
  phone_caught:{ name: '人赃并获',   desc: '在考场里看手机，被监考逮个正着' },
  phone2048:   { name: '2048',       desc: '在考场里用手机合出了 2048 —— 你今天是来干嘛的' },
  classroom:   { name: '404 找到了', desc: '进入 404 教室' },
  dino:        { name: '摸鱼选手',   desc: '在小恐龙里刷出个人最高分' },
  runaway:     { name: '跑路了兄弟', desc: '从校门口往外跑出去 —— 出发之后记得回来' },
  champion:    { name: '榜一',       desc: '交卷时排在全场第一' },
  last_place:  { name: '垫底王',     desc: '交卷时排在全场最后' }
};

function unlockAch(id){
  if (state.achievements.has(id)) return;
  state.achievements.add(id);
  const a = ACHIEVEMENTS[id];
  if (!a) return;
  clearTimeout(achTimer);
  achNotify.innerHTML =
    '<div class="at">成就解锁</div><div class="an">' + a.name + '</div>' +
    '<div style="font-size:11.5px;opacity:.85;margin-top:4px">' + a.desc + '</div>';
  achNotify.classList.add('show');
  achTimer = setTimeout(() => achNotify.classList.remove('show'), 3200);
  audio.beep(880, 0.12, 0.05);
  setTimeout(() => audio.beep(1174, 0.15, 0.04), 110);
}
