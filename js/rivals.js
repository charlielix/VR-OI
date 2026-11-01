'use strict';
/* =========================================================================
   rivals —— 其他选手的成绩曲线（名次的来源）
   ---------------------------------------------------------------------
   五个同学不是布景：每人有自己的一套 4 题曲线，按自己的节奏依次交卷。
   全部确定性生成（hashStr(名字|题号)），跟 npcgen.js 的原则一致 ——
   同一局里同一个 (人, 题) 永远是同一份成绩，测试才可言说。

   为什么要这个东西：OI 里唯一有意义的数字是名次。
   没有对手的时候，"320 / 400" 不说明任何事 —— 你不知道自己算强还是垫底，
   也就没有"再来一局"的理由。而"榜一就坐你旁边"会让干扰同学
   （原先只能招来警告的纯亏损动作）变成一笔真实的交易。
   ========================================================================= */

/* pace  节奏：占比赛时长的比例，越小交得越早
   sharp 水平：能拿到的分档，0..1
   这两个数和 npcgen.js 里的代码风格是对应的：小刚抢交但糙，小红慢但最准。
   sharp 之间的差距要留得比 ±jitter 大，否则量化的分档会把性格抹平 ——
   第一版 0.86 和 0.95 都顶到 80/100，两个人算出来一模一样的 380。

   【pace 为什么是这几个小数字】
   第一版 pace 是 0.18~0.55，也就是"最快的对手在赛程 18% 处才交第一题"。
   按 CONTEST_LEN = 4 小时、比赛时钟 15 倍速算，那是一个人 3.1 真实分钟之后 ——
   而四道小题两分钟就能交完。于是从第 1 秒到结束你都是第一名，
   屏幕上从来没有第二个人动过，玩家的结论只能是"其他人不会得分"。
   现在把 pace 压进赛程前 20%：最快的 40 秒左右就开始交，最慢的也在
   5 真实分钟内走完全程。玩家出手快依然赢，但榜是活的。 */
const RIVAL_PROFILE = {
  '小明': { pace: 0.07, sharp: 0.82 },
  '小红': { pace: 0.13, sharp: 0.95 },
  '小刚': { pace: 0.04, sharp: 0.50 },
  '小强': { pace: 0.10, sharp: 0.72 },
  '小丽': { pace: 0.17, sharp: 0.62 }
};
const RIVAL_FALLBACK = { pace: 0.09, sharp: 0.60 };
const RIVAL_STEP = 10;          /* 评测机给分是分档的：0 / 10 / … / 100 */
const RIVAL_JITTER = 0.20;      /* ±0.10 的上下起伏 —— 比 sharp 的间距小 */
/* 同一人每题之间的间隔（占赛程比例）。四个题 × 5% = 20% 赛程，
   和上面 pace 的上限配合，正好让"最后一题"落在赛程 ~37% 处。 */
const RIVAL_PACE_STEP = 0.05;

/* 纯函数，但每帧都要问一遍名次，所以算一次就记住 */
const rivalScoreMemo = Object.create(null);
const rivalTimeMemo = Object.create(null);

function rivalProblemScore(name, i){
  const k = name + '|' + i;
  if (rivalScoreMemo[k] !== undefined) return rivalScoreMemo[k];
  const p = RIVAL_PROFILE[name] || RIVAL_FALLBACK;
  const rng = mulberry32(hashStr(name + '|' + i + '|score'));
  const v = clamp(p.sharp + (rng() - 0.5) * RIVAL_JITTER, 0, 1);
  const sc = Math.round(v * (100 / RIVAL_STEP)) * RIVAL_STEP;
  rivalScoreMemo[k] = sc;
  return sc;
}

function rivalSubmitAt(name, i){
  const k = name + '|' + i;
  if (rivalTimeMemo[k] !== undefined) return rivalTimeMemo[k];
  const p = RIVAL_PROFILE[name] || RIVAL_FALLBACK;
  const rng = mulberry32(hashStr(name + '|' + i + '|time'));
  const frac = clamp(p.pace + i * RIVAL_PACE_STEP + rng() * 0.02, 0.02, 0.99);
  const t = frac * CONTEST_LEN;
  rivalTimeMemo[k] = t;
  return t;
}

/* 紧挨着你的那个人：above = 分数比你高的里面最低的，否则比你低的里面最高的。
   名次变化时用来把"谁超过了你"说出来 —— 只说"现在第 2 名"没有信息量。 */
function rivalNeighbor(elapsedSec, above){
  let best = null, bestScore = above ? Infinity : -Infinity;
  for (let i = 0; i < npcs.length; i++){
    const ud = npcs[i].userData;
    if (!ud || !ud.name) continue;
    const s = rivalTotal(ud.name, elapsedSec, ud);
    const ok = above ? (s > state.totalScore && s < bestScore)
                     : (s <= state.totalScore && s > bestScore);
    if (ok){ best = ud.name; bestScore = s; }
  }
  return best;
}

function rivalNpcByName(name){
  for (let i = 0; i < npcs.length; i++){
    const ud = npcs[i].userData;
    if (ud && ud.name === name) return ud;
  }
  return null;
}

/* 某人在 elapsedSec 时刻的总分。
   u 传 userData 就用它的下调：被放倒以后不再交卷（downAt 之后的分不算）。
   被干扰则整体推后 state.npcDelay[name] 秒 —— 见 npc.js 的 disturbNPC。 */
function rivalTotal(name, elapsedSec, u){
  const ud = u || rivalNpcByName(name);
  if (ud && ud.state === 'down'){
    if (typeof ud.downAt !== 'number') return 0;
    elapsedSec = Math.min(elapsedSec, ud.downAt);
  }
  const delay = (state.npcDelay && state.npcDelay[name]) || 0;
  let total = 0;
  const n = Math.max(1, state.problems.length);
  for (let i = 0; i < n; i++){
    if (elapsedSec >= rivalSubmitAt(name, i) + delay) total += rivalProblemScore(name, i);
  }
  return total;
}

/* 榜单：五名选手 + 自己。同分时把"你"排在前面 ——
   和 playerRank 的口径一致（它只数分数严格高于你的人数）。 */
function rivalBoard(elapsedSec){
  const rows = [];
  for (let i = 0; i < npcs.length; i++){
    const ud = npcs[i].userData;
    if (!ud || !ud.name) continue;
    rows.push({
      name: ud.name,
      score: rivalTotal(ud.name, elapsedSec, ud),
      down: ud.state === 'down'
    });
  }
  rows.push({ name: '你', score: state.totalScore, me: true });
  rows.sort((a, b) => (b.score - a.score) || (a.me ? -1 : (b.me ? 1 : 0)));
  return rows;
}

function rivalCount(){ return npcs.length + 1; }

function playerRank(elapsedSec){
  let ahead = 0;
  for (let i = 0; i < npcs.length; i++){
    const ud = npcs[i].userData;
    if (!ud || !ud.name) continue;
    if (rivalTotal(ud.name, elapsedSec, ud) > state.totalScore) ahead++;
  }
  return ahead + 1;
}

/* 结算页面用的榜面。对齐靠全角空格，不指望字体等宽。 */
function rivalBoardText(elapsedSec){
  const rows = rivalBoard(elapsedSec);
  const out = [];
  for (let i = 0; i < rows.length; i++){
    out.push('第 ' + (i + 1) + ' 名　' + rows[i].name + '　' + rows[i].score +
             (rows[i].down ? '（被放倒）' : '') + (rows[i].me ? '　←' : ''));
  }
  return out.join('\n');
}
