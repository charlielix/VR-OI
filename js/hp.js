'use strict';
/* =========================================================================
   hp —— 玩家血条
   ---------------------------------------------------------------------
   设计意图：血条不是一开始就有的。打倒监考老师之前，被保安抓住就是
   直接结局（"学生怎么能打人"）；打倒监考之后，你才"有资格"被打 —— 
   从这一刻起你有了 3 格血和 1 秒的受击无敌。
   受击间隔用世界时钟计时，所以通报弹窗的慢放期间连无敌帧也一起变慢。
   ========================================================================= */

const HP_MAX = 3;
const PLAYER_HURT_INVULN = 1000;    /* 毫秒 */

/* 纯函数：本次被抓是扣血还是致命 */
function guardHitResult(hpVisible, hp){
  if (!hpVisible || hp <= 0) return 'fatal';
  if (hp - 1 <= 0) return 'fatal';
  return 'damage';
}

/* 纯函数：此刻是否还在无敌期（时间基准为世界时钟，单位秒） */
function playerInvulnerable(now){
  return now - (state.lastDamageAt || 0) < PLAYER_HURT_INVULN / 1000;
}

function initHp(){
  state.hp = HP_MAX;
  state.hpVisible = false;
  renderHp();
}

function revealHp(){
  if (state.hpVisible) return;
  state.hpVisible = true;
  state.hp = HP_MAX;
  renderHp();
  toast('你现在有血条了', 2600);
}

function renderHp(){
  const bar = $('hpBar');
  if (!bar) return;
  bar.classList.toggle('show', !!state.hpVisible);
  const cells = bar.children;
  for (let i = 0; i < cells.length; i++) cells[i].classList.toggle('on', i < state.hp);
}

/* 被保安抓住：扣 1 格。返回是否还活着 */
function damagePlayer(g, now){
  const r = guardHitResult(state.hpVisible, state.hp);

  if (redFlash){
    redFlash.style.opacity = '0.55';
    setTimeout(() => { redFlash.style.opacity = '0'; }, 200);
  }
  audio.beep(160, 0.22, 0.07, 'sawtooth');

  if (r === 'damage'){
    state.hp--;
    renderHp();
    toast('你被命中了！', 1500);
    /* 把动手的保安推开一点，给玩家喘息空间 */
    if (g){
      const dx = g.group.position.x - state.pos.x;
      const dz = g.group.position.z - state.pos.z;
      const len = Math.hypot(dx, dz) || 1;
      g.group.position.x = state.pos.x + dx / len * 1.6;
      g.group.position.z = state.pos.z + dz / len * 1.6;
    }
    return true;
  }
  return false;   /* 血量耗尽 → 由调用方走结局 */
}
