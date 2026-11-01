'use strict';
/* =========================================================================
   save —— 进度存档
   ---------------------------------------------------------------------
   存的是"这场考试的哪个切片"：四道题的 id、每题代码、每题得分、当前题、
   已用时间、警告次数、已解锁成就、背包、安检/手机状态、武器耐久。
   读档时必须按 id 还原本局的四道题 —— 否则玩家上次抽到的题和这次不一样，
   存档里的代码就对不上了。
   ========================================================================= */

const SAVE_KEY = 'oi_room_save_v1';
let autoSaveTimer = null;

function scheduleAutoSave(){
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(persistSave, 1200);
}

function persistSave(){
  if (!state.started || state.ended) return;
  try {
    const blob = {
      code: state.code,
      score: state.score,
      curProb: state.curProb,
      elapsed: state.elapsed,
      admitElapsed: state.admitElapsed,
      examStarted: state.examStarted,
      warnCount: state.warnCount,
      achievements: Array.from(state.achievements),
      problems: state.problems.map(p => p.id),
      bag: bagSnapshot(),
      /* 武器耐久也要跟档走：不存的话读一次档就能把抡断的扫把修好 */
      weaponWear: state.weaponWear,
      /* 安检与手机：这两个以前没存，于是读档之后会出现"过了安检但手机又回来了"，
         或者"从侧门进来的却记得自己过了安检"这种谁也说不清的状态。
         enteredRoom 故意不存：读档后区域还在校园，存成 true 会让人卡在
         "进不去楼也没法重新安检"的死角里。 */
      passedSecurity: state.passedSecurity,
      hasPhone: state.hasPhone,
      sneakedIn: state.sneakedIn,
      cardBalance: state.cardBalance,
      vendingStock: state.vendingStock,
      savedAt: Date.now()
    };
    localStorage.setItem(SAVE_KEY, JSON.stringify(blob));
  } catch(e){}
}

function tryLoadSave(){
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return false;
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object') return false;

    /* 题目集合必须完整还原，否则放弃整份存档（宁可重开也不给错题） */
    if (Array.isArray(o.problems) && o.problems.length === PROBLEM_COUNT){
      const restored = o.problems.map(id => PROBLEM_BY_ID.get(id)).filter(Boolean);
      if (restored.length !== PROBLEM_COUNT) return false;
      state.problems = restored;
      state.curProb = restored[0].id;
      updateAllDeskScreens();
    }

    if (o.code) state.code = o.code;
    if (o.score) state.score = o.score;
    if (o.curProb) state.curProb = o.curProb;
    if (typeof o.elapsed === 'number') state.elapsed = clamp(o.elapsed, 0, CONTEST_LEN);
    /* 入场阶段与考试时钟是两条线。老存档没有 examStarted 字段，
       但老版本的 elapsed 就是考试时钟 —— 按"已经开考"迁移最接近原意。
       新存档在入场阶段会显式存 examStarted: false。 */
    if (typeof o.examStarted === 'boolean') state.examStarted = o.examStarted;
    else state.examStarted = true;
    if (typeof o.admitElapsed === 'number')
      state.admitElapsed = clamp(o.admitElapsed, 0, EXAM_ENTRY_LIMIT + CONTEST_LEN);
    /* 两条时钟只能有一条在跑，读档时把另一条归零，免得 HUD 和结算各读各的 */
    if (state.examStarted) state.admitElapsed = 0;
    else state.elapsed = 0;
    if (typeof o.warnCount === 'number') state.warnCount = o.warnCount;
    if (Array.isArray(o.achievements)) state.achievements = new Set(o.achievements);
    /* 背包是"少一瓶就真少一瓶"的资源，必须跟档走；
       老存档没有 bag 字段时保持 initBag() 给的开局配发，不当成空包。 */
    if (o.bag) bagRestore(o.bag);
    if (o.weaponWear && typeof o.weaponWear === 'object'){
      state.weaponWear = {};
      for (const id in o.weaponWear){
        if (ITEMS[id] && ITEMS[id].melee && typeof o.weaponWear[id] === 'number')
          state.weaponWear[id] = o.weaponWear[id];
      }
    }
    /* 老存档没有这几个字段 —— 只在真正存过时才覆盖，
       否则读一份旧档就会把手机状态冲成 undefined（表现为"手机凭空没了"）。 */
    if (typeof o.passedSecurity === 'boolean') state.passedSecurity = o.passedSecurity;
    if (typeof o.hasPhone === 'boolean') state.hasPhone = o.hasPhone;
    if (typeof o.sneakedIn === 'boolean') state.sneakedIn = o.sneakedIn;
    /* 自动售货机：老存档没有这两个字段，保持开局默认值即可。
       库存逐项夹到 0..该商品上限，防止改过的存档把机器刷成无限供货。 */
    if (typeof o.cardBalance === 'number')
      state.cardBalance = clamp(Math.floor(o.cardBalance), 0, 9999);
    if (o.vendingStock && typeof o.vendingStock === 'object'){
      for (const g of VENDING_GOODS){
        const v = o.vendingStock[g.id];
        if (typeof v === 'number')
          state.vendingStock[g.id] = clamp(Math.floor(v), 0, g.stock);
      }
    }
    /* 背包和 hasPhone 是同一件事的两份记录：老存档的 bag 里没有手机，
       而 hasPhone 又是默认的 true —— 不对齐就会出现"背包里没有却能用"。 */
    reconcilePhone();

    recalcScore();
    lastHudProbsKey = '';        /* 强制 HUD 题目区重画 */
    renderHudProbs();
    return true;
  } catch(e){ return false; }
}

function clearSave(){
  try { localStorage.removeItem(SAVE_KEY); } catch(e){}
}

function hasSave(){
  try { return !!localStorage.getItem(SAVE_KEY); } catch(e){ return false; }
}
