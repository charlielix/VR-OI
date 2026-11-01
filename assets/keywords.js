'use strict';
/* =========================================================================
   keywords —— 判题用关键词表
   ---------------------------------------------------------------------
   所有题目共用一份。判题器会统计代码里命中多少个关键词（每个 +3，封顶 40），
   所以这张表要覆盖"认真想过的代码里一定会出现的东西"：类型、控制流、
   STL 容器与算法、输入输出、常见算法变量名。
   ========================================================================= */

const KEYWORDS_LIST = [
  /* 基本类型 */
  'int', 'long', 'char', 'float', 'double', 'bool', 'void', 'auto',
  'const', 'unsigned',

  /* 控制流 */
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break',
  'continue', 'return', 'throw',

  /* 定义 / 命名空间 */
  'class', 'struct', 'enum', 'template', 'typename',
  'public', 'private', 'namespace', 'using', 'typedef', 'operator',

  /* STL 容器 */
  'vector', 'map', 'set', 'queue', 'stack', 'deque',
  'pair', 'string', 'array', 'tuple',
  'unordered_map', 'unordered_set', 'priority_queue', 'bitset',

  /* STL 算法 / 操作 */
  'sort', 'reverse', 'unique', 'lower_bound', 'upper_bound',
  'push_back', 'emplace_back', 'pop_back', 'begin', 'end', 'size',
  'greater', 'accumulate', 'next_permutation', 'stable_sort',

  /* 输入输出 */
  'cin', 'cout', 'scanf', 'printf', 'endl', 'puts', 'putchar',
  'memset', 'sizeof', 'setprecision', 'fixed',

  /* 数学 */
  'gcd', 'lcm', 'abs', 'sqrt', 'pow', 'min', 'max', 'log', 'exp',
  'fabs', 'floor', 'ceil', 'round',

  /* 算法与变量名 */
  'dp', 'dfs', 'bfs', 'lca', 'dijkstra', 'kruskal', 'spfa', 'topo',
  'dist', 'dep', 'fa', 'pre', 'sum', 'ans', 'cnt', 'mod', 'INF',
  'mx', 'mn', 'res', 'tot', 'idx', 'vis', 'flag', 'nxt', 'head',
  'size_t', 'll', 'ull', 'sz', 'mem', 'tree', 'seg', 'f', 'g', 'h'
];
