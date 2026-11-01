'use strict';
/* =========================================================================
   problems —— 抽题逻辑
   ---------------------------------------------------------------------
   题面与起始模板都是静态数据（assets/problems/*.js），本文件只负责：
     · 建立 id → 题目的索引
     · 每局随机抽 4 道
   抽题用部分 Fisher-Yates：只洗前 count 个，避免 splice 的 O(n) 挪动。
   ========================================================================= */

const PROBLEM_POOL = PROBLEM_DATA;

/* id → 题目，供读档时按 id 还原本局的四道题 */
const PROBLEM_BY_ID = new Map(PROBLEM_POOL.map(p => [p.id, p]));

function pickProblems(){
  const pool = PROBLEM_POOL.slice();
  const count = Math.min(PROBLEM_COUNT, pool.length);
  for (let i = 0; i < count; i++){
    const j = i + Math.floor(Math.random() * (pool.length - i));
    const tmp = pool[i];
    pool[i] = pool[j];
    pool[j] = tmp;
  }
  return pool.slice(0, count);
}

/* 题目难度 → 显示用的星标（纯展示） */
function difficultyStars(d){
  const n = clamp(Math.round(d || 3), 1, 5);
  return '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n);
}
