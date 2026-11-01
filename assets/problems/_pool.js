'use strict';
/* =========================================================================
   题库注册表
   ---------------------------------------------------------------------
   加载顺序：本文件 → assets/problems/<题目 id>.js → assets/problems/problems.js
   加题只需两步：在 assets/problems/ 里新建 P<数字>.js（内容为
   PROBLEM_DATA.push({...})），然后在 index.html 的静态数据区加一行 <script>。
   ========================================================================= */

var PROBLEM_DATA = [];

/* 所有题目共用的起始代码模板 —— C++14 + g++ -O2 的赛场常见写法 */
const STARTER_TEMPLATE = [
  '#include <bits/stdc++.h>',
  'using namespace std;',
  '',
  'int main() {',
  '    ios::sync_with_stdio(false);',
  '    cin.tie(0);',
  '',
  '    // 在此编写代码',
  '',
  '    return 0;',
  '}',
  ''
].join('\n');
