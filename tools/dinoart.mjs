/* =========================================================================
   dinoart.mjs —— 小恐龙 / 仙人掌 / 翼龙的**候选美术预览器**（不启浏览器）
   ---------------------------------------------------------------------
   为什么要有这个：这套精灵是手绘位图和 fillRect 拼出来的，读坐标在脑子里
   拼不出形状。把绘制逻辑在 Node 里原样重放一遍、打成字符画，就能一行一行
   看着改 —— 而且不用起 Chrome，一次迭代不到一秒。

   它和 launcher.js 的关系：这里是"草稿"，launcher.js 里是"定稿"。
   两边必须一致，所以：
     · 位图直接从 launcher.js 里读（不复制一份，避免两份走散）
     · 仙人掌几何直接 eval launcher.js 里那两段函数
   改完 launcher.js 再跑这个，看到的就一定是真实结果。

   用法：node tools/dinoart.mjs [--all]
   ========================================================================= */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '..', 'js', 'launcher.js'), 'utf8');

/* ---- 从 launcher.js 里抠出真值：位图、几何、腿部逻辑 ---- */function grab(name, open = '{', close = '}'){
  const i = SRC.indexOf('const ' + name + ' = ');
  if (i < 0) throw new Error('没找到 ' + name);
  const start = SRC.indexOf(open, i);
  let depth = 0, j = start;
  for (; j < SRC.length; j++){
    if (SRC[j] === open) depth++;
    else if (SRC[j] === close){ depth--; if (!depth) break; }
  }
  return SRC.slice(i, j + 1);
}
function grabFn(name){
  const i = SRC.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('没找到 ' + name);
  const start = SRC.indexOf('{', i);
  let depth = 0, j = start;
  for (; j < SRC.length; j++){
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}'){ depth--; if (!depth) break; }
  }
  return SRC.slice(i, j + 1);
}

const DINO = (0, eval)('(' + grab('DINO').slice('const DINO = '.length) + ')');
const DINO_BODY = eval(grab('DINO_BODY', '[', ']').slice('const DINO_BODY = '.length));
const DINO_OBS = eval(grab('DINO_OBS', '[', ']').slice('const DINO_OBS = '.length));
const DINO_SQUASH = Number(SRC.match(/const DINO_SQUASH = ([\d.]+)/)[1]);

/* ---- 候选位图：按"每行的连续区间"生成，省得手数 32 个点 ---- */
const SPEC = [
  [[18, 30]],                       /*  0 头顶：两侧各收（原版头 45% 宽，这里 16 列）*/
  [[16, 31]],                       /*  1 */
  [[16, 18], [21, 31]],             /*  2 眼：19..20 挖空，纵向 2 行 */
  [[16, 18], [21, 31]],             /*  3 眼 */
  [[16, 31]],                       /*  4 */
  [[16, 31]],                       /*  5 */
  [[16, 31]],                       /*  6 */
  [[16, 31]],                       /*  7 头底 */
  [[16, 24]],                       /*  8 张嘴：口缝一直开到前缘（原版就是开着的）*/
  [[16, 28]],                       /*  9 下颚比口缝伸得远 */
  [[0, 1], [15, 22]],               /* 10 尾巴只 2 列宽（原版 6/44 = 14%）*/
  [[0, 2], [14, 22]],               /* 11 */
  [[0, 4], [11, 24]],               /* 12 肩 */
  [[0, 5], [9, 22], [23, 25]],      /* 13 手臂：原版是悬空的 2x2，这里接到胸上 */
  [[0, 22]],                        /* 14 背 */
  [[0, 22]],                        /* 15 */
  [[0, 22]],                        /* 16 */
  [[1, 22]],                        /* 17 */
  [[2, 22]],                        /* 18 */
  [[4, 21]],                        /* 19 */
  [[6, 21]],                        /* 20 */
  [[7, 20]],                        /* 21 肚 */
  [[7, 20]],                        /* 22 */
  [[7, 20]]                         /* 23 平底：腿（列 13..20）接在这一行 */
];
function buildBody(spec){
  return spec.map(spans => {
    const row = new Array(32).fill('.');
    for (const [a, b] of spans) for (let c = a; c <= b; c++) row[c] = 'X';
    return row.join('');
  });
}
const CAND = buildBody(SPEC);

/* ---- 一个最小的 2D 画布：只实现 fillRect，坐标取整规则和真画布一致 ---- */
function makeCtx(w, h){
  const px = new Uint8Array(w * h);          /* 0 = 背景，>0 = 墨色深浅 */
  const ctx = {
    w, h, fillStyle: '#000',
    rects: 0,
    fillRect(x, y, rw, rh){
      ctx.rects++;
      const tone = ctx.fillStyle === '#f7f7f7' ? 0
                 : ctx.fillStyle === '#8a8a8a' ? 1
                 : ctx.fillStyle === '#dcdcdc' ? 1 : 2;
      const x0 = Math.round(x), y0 = Math.round(y);
      const x1 = Math.round(x + rw), y1 = Math.round(y + rh);
      for (let yy = Math.max(0, y0); yy < Math.min(h, y1); yy++){
        for (let xx = Math.max(0, x0); xx < Math.min(w, x1); xx++){
          px[yy * w + xx] = tone;
        }
      }
    }
  };
  return { ctx, px };
}

/* 把画布按 cols×rows 打印（每格 = 画布上 1 像素） */
function dump(px, w, x0, y0, cols, rows, label){
  const out = [];
  for (let r = 0; r < rows; r++){
    let line = '';
    for (let c = 0; c < cols; c++){
      const v = px[(y0 + r) * w + (x0 + c)] || 0;
      line += v === 0 ? '.' : v === 1 ? '+' : '#';
    }
    out.push(line);
  }
  console.log('\n' + label);
  out.forEach((l, i) => console.log(String(i).padStart(3) + ' |' + l + '|'));
  return out;
}

/* ---- 把 launcher.js 里的绘制函数搬过来跑（浅层沙箱） ---- */
const sandbox = { DINO, DINO_BODY, DINO_SQUASH, Math };
const fnSrc = ['dinoDrawShape', 'dinoDrawLegs', 'dinoCactusGeom', 'dinoDrawCactus',
               'dinoDrawBird'].map(grabFn).join('\n');
const build = new Function('DINO', 'DINO_BODY', 'DINO_SQUASH',
  fnSrc + '\nreturn { dinoDrawShape, dinoDrawLegs, dinoCactusGeom, dinoDrawCactus, dinoDrawBird };');
/* 预览用候选位图；旧位图留着做对比 */
const BODY = CAND;
const ART = build(DINO, BODY, DINO_SQUASH);
if (BODY.length !== 24) throw new Error('候选位图必须 24 行，现在 ' + BODY.length);

/* 把候选位图打成可以直接粘回 launcher.js 的字面量 */
console.log('/* ---- 候选 DINO_BODY（24 行 × 32 列）---- */');
console.log(CAND.map(r => "  '" + r + "',").join('\n'));
const badLen = CAND.filter(r => r.length !== 32);
console.log(badLen.length ? '✗ 有 ' + badLen.length + ' 行不是 32 列' : '✓ 24 行 × 32 列');

const W = 200, H = DINO.GROUND + 40;
/* 必须用 DINO.GROUND：仙人掌的几何是相对地面线算的，预览里另起一个地面
   会让它画到画布外面去（第一次就踩了这个 —— 整张图全空）。 */
const G = DINO.GROUND;

/* ============================ 小恐龙 ============================ */
for (const duck of [false, true]){
  for (const frame of [0, 1]){
    if (duck && frame === 1) continue;    /* 蹲下两帧差别只有一个偏移，看一帧就够 */
    const { ctx, px } = makeCtx(W, H);
    const s = DINO.PX;
    const sq = duck ? DINO_SQUASH : 1;
    const bodyY = G - DINO_BODY.length * s * sq - 6 * s;
    const bodyX = 6 * s;
    ctx.fillStyle = '#535353';
    ART.dinoDrawShape(ctx, bodyX, bodyY, s, duck);
    ART.dinoDrawLegs(ctx, bodyX + 4 * s, bodyY, s, duck, frame);
    const label = '小恐龙【' + (duck ? '蹲下' : '站立') + '】帧 ' + frame +
      '　（每字符 = 1 画布像素，s=' + s + '）';
    dump(px, W, bodyX - 4, Math.round(bodyY) - 2, 32 * s + 10, DINO_BODY.length * s * sq + 4 * s + 6, label);
  }
}

/* ============================ 仙人掌 ============================ */
for (const spec of [{ w: 19, h: 58, name: '单株' }, { w: 57, h: 74, name: '成组' }]){
  const { ctx, px } = makeCtx(W, H);
  const o = { kind: 'cactus', x: 20, y: G - spec.h, w: spec.w, h: spec.h };
  ART.dinoDrawCactus(ctx, o);
  const g = ART.dinoCactusGeom(o);
  dump(px, W, 4, G - spec.h - 4, spec.w + 24, spec.h + 8,
       '仙人掌【' + spec.name + '】 w=' + spec.w + ' h=' + spec.h +
       '　可见 ' + g.left + '..' + g.right);
}

/* ============================ 翼龙 ============================ */
for (const frame of [0, 1]){
  const { ctx, px } = makeCtx(W, H);
  const o = { kind: 'bird', x: 20, y: 40, w: 66, h: 30 };
  ART.dinoDrawBird(ctx, o, frame);
  dump(px, W, 16, 20, 80, 44, '翼龙【帧 ' + frame + '】　可见范围要落在判定盒 y=40..70 附近');
}

/* ============================ 体检 ============================ */
console.log('\n' + '='.repeat(70));
console.log('自检');
const rows = DINO_BODY.length;
console.log('  位图行数 ' + rows + '（必须 = 24：腿的基准、蹲下压扁、dinomap 都按它算）');
const wrong = DINO_BODY.filter(r => r.length !== 32);
console.log('  每行长度: ' + (wrong.length ? '✗ 有 ' + wrong.length + ' 行不是 32' : '✓ 全是 32'));
/* 腿是从 dinoDrawLegs(ctx, bodyX + 4*s, …) 画出来的，函数内部再偏移 9*s..17*s，
   所以落到位图上其实是列 13..21，不是 9..17。按 9..17 检查会永远通过 ——
   那样腿悬空了这个自检也不会响。 */
const last = DINO_BODY[rows - 1];
const legSolid = [];
for (let c = 13; c <= 20; c++) legSolid.push(last[c] === 'X' ? '#' : '.');
console.log('  最后一行 13..20 列（腿的落点）: [' + legSolid.join('') + ']' +
            (legSolid.indexOf('.') >= 0 ? ' ✗ 腿会挂在空气上' : ' ✓ 腿有实体可接'));
/* 眼睛：位图里挖的洞必须成行成列，否则 +0.6 的接缝把洞糊死 */
let eye = 0;
for (const r of DINO_BODY) if (r.indexOf('.') > 0 && r.lastIndexOf('X') > r.indexOf('.')) eye++;
console.log('  内部空洞行数: ' + eye + '（眼睛/嘴靠它，0 = 没有五官）');

/* ---- 参考比例 ----
   数字来自 Chrome offline 雪碧图（TREX 44×47，spriteDefinition x=848,y=2）。
   量的是三个比值，不是绝对像素 —— 因为原版 44×47，这里 32×24，只有比值可比：
     · 头宽 / 背宽      原版 20/28 = 0.71
     · 尾宽 / 背宽      原版  6/28 = 0.21
     · 头高 / 躯干高    原版 11/35 = 0.31
   "背宽"取下半部**没有内部空洞**的最宽行（有空洞的是尾巴/手臂接缝那几行，
   用整行最左最右会把手臂算进躯干，量出来就飘了）。 */
function span(r){
  const l = r.indexOf('X'), rt = r.lastIndexOf('X');
  if (l < 0) return null;
  const hole = r.indexOf('.') > l && r.indexOf('.') < rt;
  /* 第一段连续像素的宽度：像"尾巴 + 空隙 + 肩"这种一行两块的，
     整行跨度 23 会把空隙也算进去，量出来就成了 23 而不是尾巴的 6。 */
  const run = r.slice(l).match(/^X+/)[0].length;
  return { l: l, r: rt, w: rt - l + 1, run: run, hole: hole };
}
const spans = DINO_BODY.map(span);
const headSpans = spans.slice(0, Math.floor(rows / 3)).filter(Boolean);
const headW = Math.max(...headSpans.map(s => s.w));
const headRight = Math.max(...headSpans.map(s => s.r));
/* 头占的行数：从第 0 行往下，只要右缘还贴着头部右缘就算 */
let headRows = 0;
while (headRows < rows && spans[headRows] && spans[headRows].r >= headRight - 2) headRows++;
const bodyW = Math.max(0, ...spans.filter(s => s && !s.hole).map(s => s.w));
const minL = Math.min(...spans.filter(Boolean).map(s => s.l));
/* 尾巴 = 贴着最左缘、但明显窄于躯干的那几行。
   不能只用"最左缘"：躯干的背也从最左缘开始，会把整条背量成尾巴
   （原版同样如此：背从列 2 起，尾也从列 2 起）。 */
const tailW = Math.max(...spans.filter(s => s && s.l === minL && s.run < bodyW * 0.45)
                                      .map(s => s.run));

function band(label, v, lo, hi, ref){
  const ok = v >= lo && v <= hi;
  console.log('  ' + label + ' ' + v.toFixed(2) + '　区间 [' + lo + ', ' + hi +
              ']　原版 ' + ref + '　' + (ok ? '✓' : '✗'));
  return ok;
}
console.log('\n  参考比例（照原版 44×47 量的）:');
const ref = [
  band('头宽 / 背宽  ', headW / bodyW, 0.58, 0.82, '0.71'),
  band('尾宽 / 背宽  ', tailW / bodyW, 0.14, 0.34, '0.21'),
  band('头高 / 躯干高', headRows / rows, 0.26, 0.40, '0.31')
];
console.log('  ' + (ref.every(Boolean) && !wrong.length &&
            legSolid.indexOf('.') < 0 && eye >= 2
            ? '✓ 全部通过' : '✗ 有项目不达标') +
            '　（头 ' + headW + ' 宽 / 背 ' + bodyW + ' 宽 / 尾 ' + tailW +
            ' 宽 / 头 ' + headRows + ' 行）');
