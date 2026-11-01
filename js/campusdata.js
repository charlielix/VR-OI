'use strict';
/* =========================================================================
   campusdata —— 校园场景的静态数据
   ---------------------------------------------------------------------
   跟 world.js 保持同一个原则：数字与文案集中在这里，装配逻辑（campus.js）
   只负责把它们变成几何体。改门牌号、改楼层指引不用翻建造代码。
   ========================================================================= */

/* ---------------------------- 场所标识 ----------------------------
   考场号 39 在 404 教室，位于第三教学楼。
   这些数字会被同时用在：楼体大字、门牌、志愿者的台词、安检点的告示。
   只在这里写一次，四处引用 —— 否则改一处就会出现"志愿者说的和墙上写的不一样"。 */
const EXAM_ROOM_NO   = '39';                 /* 考场号 */
const EXAM_CLASSROOM = '404';                /* 教室号 */
const EXAM_BUILDING  = '第三教学楼';           /* 楼名 */
const EXAM_BUILDING_TAG = 'B 栋';             /* 楼的简称，志愿者口语里用这个 */
const SCHOOL_NAME    = '第 114 中学';

/* ---------------------------- 尺寸（世界单位 = 米） ---------------------------- */
const CP = { x: 0, z: 500 };                 /* 校园坐标原点偏移：整体挪到 +Z 远处，与考场房间互不干扰 */

const CAMPUS_W = 26;                         /* 校园横向（x）总宽 */
const CAMPUS_GATE_Z = 8;                     /* 校门 z（玩家出生点在它外侧一点） */
const CAMPUS_BUILD_Z = -24;                  /* 教学楼正面 z */
const CAMPUS_FAR_Z = -30;                    /* 校园最远端（楼体中心一带） */
const CAMPUS_MIN_Z = -30, CAMPUS_MAX_Z = 16; /* 可活动范围 */
const CAMPUS_HALF_W = CAMPUS_W / 2;

const CAMPUS_PORTAL_X = 5.2;                 /* 传送圈位置（门口旁边） */
const CAMPUS_PORTAL_Z = 5.0;
const CAMPUS_AUDIT_X = 0;                    /* 安检点（就在教学楼门口） */
const CAMPUS_AUDIT_Z = -21.2;

/* 到达点：传送圈与"走到门口"都落到这里，正对安检口与楼门 */
const CAMPUS_DOOR_STAND = { x: 0, z: -18.6 };

/* ---------------------------- 自动售货机 ----------------------------
   放在校门里侧的左手边：出生后走两步就能看见，不用专程绕路。
   价格与库存都写在这里，campus.js 只负责把它画出来、把购买逻辑接上。
   开局饭卡 12 元，全部商品买齐要 20 元 —— 逼玩家做取舍，而不是无脑补满。 */
const VENDING_POS = { x: -6.0, z: 2.4 };
const VENDING_START_BALANCE = 12;
const VENDING_GOODS = [
  { id: 'water', price: 2, stock: 3 },
  { id: 'spicy', price: 3, stock: 2 },
  { id: 'stink', price: 4, stock: 2 }
];

/* ---------------------------- 入场预留 ----------------------------
   开考后的前 30 分钟是入场预留时间，不算考试时间：
     · 在这段时间内进考场 → 考试时钟从 4:00:00 重新开始；
     · 超过 30 分钟才进考场 → 按迟到时长扣除（例如 40 分钟进场，剩 3:50:00）；
     · 超过 30 分钟 + 4 小时仍未进场 → 本场缺考。 */
const EXAM_ENTRY_LIMIT = 30 * 60;
/* 压线：入场预留时间剩不到这么多时进考场，解锁「压线进场」 */
const EXAM_RUSH_MARGIN = 3 * 60;

/* 玩家出生点：校门外，面朝校园（-Z 方向即 yaw = 0） */
/* 出生点：站在校门外侧一点，面朝校园（+Z 是校门，所以 yaw=0 面向 -Z）。
   这里有个容易踩的坑：z 必须 <= AREA_BOUNDS.campus.zMax（=15.2），
   否则第一步移动就把玩家钳到边界上，看起来就是"开局被往后弹了一下"。
   11.5 落在 [CAMPUS_MIN_Z, CAMPUS_MAX_Z] 之内，也在边界之内。 */
const CAMPUS_SPAWN = { x: -1.2, z: 11.5, yaw: 0 };

/* "跑路了兄弟" 被抓回来之后站的位置：校门里侧 1.5m，面朝校园。
   放在 CAMPUS_SPAWN 之后是有意的 —— 它引用 CAMPUS_SPAWN.x，
   而 const 不提升，写在前面对加载期来说就是 TDZ 错误。 */
const CAMPUS_GATE_STAND = { x: CAMPUS_SPAWN.x, z: CAMPUS_GATE_Z - 1.5, yaw: 0 };

/* ---------------------------- 志愿者站位与台词 ---------------------------- */
const VOLUNTEERS = [
  {
    x: -3.4, z: 5.6, color: 0xd94f4f, rotY: 0.5,
    name: '志愿者 · 小林',
    lines: [
      '同学你也是考 CSP-S 的吧？考场在 ' + EXAM_BUILDING_TAG + '，就那栋。',
      '墙上有指引，跟着走就行 —— 别走错楼，走错了没人管你。',
      '门口要过安检，进楼之前把手机掏出来放篮子里。'
    ]
  },
  {
    x: 3.0, z: -9.5, color: 0xd94f4f, rotY: 2.6,
    name: '志愿者 · 阿舟',
    lines: [
      '别站那儿发呆啊，' + EXAM_BUILDING_TAG + '往里走。',
      '考场号 ' + EXAM_ROOM_NO + ' 在 ' + EXAM_CLASSROOM + ' 教室，进去之后对号入座。',
      '别人基本都过完安检上去了，你是最后一个了吧？'
    ]
  }
];

/* ---------------------------- 墙上指引牌的内容 ----------------------------
   这块牌子的存在意义是"即使不跟志愿者说话也能自己找到路"。
   所以它必须比志愿者的台词更完整：楼名 + 考场号 + 教室 + 楼层。 */
const CAMPUS_SIGN_ROWS = [
  { text: '考 场 指 引',                                     color: '#12325e', size: 46 },
  { text: '考场号 ' + EXAM_ROOM_NO + '　' + EXAM_BUILDING + ' ' + EXAM_BUILDING_TAG, color: '#9fd3ff', size: 34 },
  { text: '教 室 ' + EXAM_CLASSROOM + '　　四 楼 东 侧',        color: '#ffe9a8', size: 34 },
  { text: '入口：正门 → 安检 → 四楼',                          color: '#c8d6ea', size: 24 }
];

/* ---------------------------- 安检口告示 ---------------------------- */
const CAMPUS_AUDIT_NOTICE = [
  { text: '安 检 通 道',    color: '#c0392b', size: 40 },
  { text: '出示准考证 · 手机静音', color: '#1a2740', size: 24 },
  { text: '已签到 47 / 47 人',    color: '#1a2740', size: 24 },
  { text: '你是最后一个',          color: '#b03a2e', size: 22 }
];

/* ---------------------------- 楼门牌 ---------------------------- */
const CAMPUS_DOOR_PLATE = [
  { text: EXAM_CLASSROOM,        color: '#12325e', size: 90 },
  { text: '考场 ' + EXAM_ROOM_NO, color: '#c0392b', size: 34 }
];
