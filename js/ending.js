'use strict';
/* =========================================================================
   ending —— 结算与结局分支
   ---------------------------------------------------------------------
   结局分支全在这里：
     · 正常交卷 / 时间到     → endContest()
     · 五次走动被取消成绩    → endContest() 里的 wanderPenalty 分支
     · 打老师被保安抓走      → guards.js 的 endByGuards()
     · 代码里写屏蔽词        → npc.js 的 endByBannedWord()
     · 打满 200 名保安走白光 → guards.js 的 endByTotalVictory()
   ========================================================================= */

function showEnding(score, detailHtml){
  releaseLock();

  /* 实际用时 = 虚拟用时 / 时间流速（作弊的流速不算在"你花了多久"里） */
  const elapsedSec = state.elapsed / Math.max(1, timeScale);
  $('endStats').innerHTML =
    '<div class="stat"><div class="sv">' + fmtTime(elapsedSec) + '</div><div class="sl">实际用时</div></div>' +
    '<div class="stat"><div class="sv">' + state.warnCount + '</div><div class="sl">警告次数</div></div>' +
    '<div class="stat"><div class="sv">' + state.guardKills + '</div><div class="sl">击倒保安</div></div>';

  const achList = $('endAch');
  if (state.achievements.size){
    achList.innerHTML = Array.from(state.achievements)
      .map(id => ACHIEVEMENTS[id] ? '<span class="ach-chip">' + ACHIEVEMENTS[id].name + '</span>' : '')
      .join('');
  } else {
    achList.innerHTML = '';
  }

  $('endScore').textContent = score;
  $('endDetail').innerHTML = (detailHtml || '').replace(/\n/g, '<br>');
  endingUI.classList.remove('hidden');
}

function endContest(manual){
  if (state.ended) return;

  /* ---- 分支零：入场预留 + 4 小时都过了，还没进楼 → 缺考 ----
     必须排在"正常交卷"前面：否则一个迟到者会既拿 0 分、
     又白捡「神速交卷」（elapsed/ timeScale 只有很短一点）。 */
  if (state.missedEntry){
    state.ended = true;
    state.view = 'world';
    hideAllPanels();
    clearGuards();
    unlockAch('late');

    $('endTitle').textContent = '缺 考';
    $('endSub').textContent = '考试已经结束，本场没有你的成绩。';
    showEnding(0,
      '你在楼外耗掉了 ' + Math.round(state.admitElapsed / 60) + ' 分钟。\n' +
      '入场预留 30 分钟，考试 4 小时 —— 等你晃到门口，里面已经收卷了。\n\n' +
      '下一场记得早点到 —— 校门开着不代表考场一直开着。');
    clearSave();
    return;
  }

  /* ---- 分支一：本场曾离开座位 5 次 → 取消成绩 ---- */
  if (state.wanderPenaltyApplied){
    state.ended = true;
    state.view = 'world';
    hideAllPanels();
    clearGuards();
    unlockAch('wanderer');

    $('endTitle').textContent = '成 绩 已 取 消';
    $('endSub').textContent = '比赛结束。评测记录已封存。';
    showEnding(0,
      '监考老师翻开记录本，上面完整记着你五次擅自离场的时点。\n' +
      '依据《NOI 竞赛纪律》，本次成绩作废。\n\n' +
      '下次记得，考场里每一步都在镜头下。');
    clearSave();
    return;
  }

  /* ---- 分支二：正常交卷 ---- */
  state.ended = true;
  state.view = 'world';
  hideAllPanels();
  clearGuards();

  let total = 0;
  const detail = [];
  state.problems.forEach(p => {
    const sc = state.score[p.id] || 0;
    total += sc;
    detail.push(p.id + ' ' + p.name + '：' + sc + ' / ' + p.max);
  });

  if (total === 0) unlockAch('zero_king');
  if (state.warnCount === 0) unlockAch('clean_run');
  if (state.elapsed / Math.max(1, timeScale) <= 3600) unlockAch('speedrun');

  /* 名次：交完卷之后唯一还能让人在意一秒的数字。
     对手的分是他们按时交出来的，不是随机数 —— 见 rivals.js。 */
  const myRank = playerRank(state.elapsed);
  const all = rivalCount();
  if (all > 1){
    if (myRank === 1) unlockAch('champion');
    else if (myRank === all) unlockAch('last_place');
  }

  const board = all > 1
    ? '\n\n—— 榜 单 ——\n' + rivalBoardText(state.elapsed) +
      '\n\n你的名次：第 ' + myRank + ' / ' + all + ' 名'
    : '';

  $('endTitle').textContent = '比 赛 结 束';
  $('endSub').textContent = all > 1
    ? '评测机已停止运行，全场第 ' + myRank + ' 名。'
    : '评测机已停止运行，你的代码已被封存。';
  showEnding(total,
    detail.join('\n') +
    '\n\n用时 ' + fmtTime(state.elapsed) + ' · 被警告 ' + state.warnCount + ' 次' +
    (manual ? '\n（提前交卷）' : '\n（时间到，自动交卷）') +
    (state.guardKills > 0 ? '\n击倒保安 ' + state.guardKills + ' 名' : '') +
    board);
  clearSave();
}
