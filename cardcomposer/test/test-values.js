#!/usr/bin/env node
/*
 * test-values.js -- 「满级数值」口径的单元测试（不碰包，纯计算）。
 *
 * 依据：游戏卡面/说明里的数字是按**满级**算的（实测用户那张卡：Lv1 的卡，说明写 {11}，
 * 游戏显示 14999 = p0 + p1×80/1000）。公式照抄服务端 battle_engine_math.go。
 */
'use strict';
const V = require('../lib/values');
let bad = 0;
const ok = (c, m, d) => { console.log((c ? '  [OK]   ' : '  [FAIL] ') + m + (d ? '  ' + d : '')); if (!c) bad++; };

// 用户那张卡的覚醒技攻击块：p0=9639 p1=67000 → 游戏说明显示 14999（Lv80）
const atkParams = { 0: '9639', 1: '67000', 2: '1000', 4: '4', 5: 'ATK', 7: 'FIRE_ICE', 8: 'PHYSICS' };
ok(V.valueAt('attack', atkParams, 80) === 14999, 'attack: 满级(80) = 14999（和游戏截图一致）', String(V.valueAt('attack', atkParams, 80)));
ok(V.valueAt('attack', atkParams, 1) === 9706, 'attack: Lv1 = 9706', String(V.valueAt('attack', atkParams, 1)));

const s1 = V.solveFromValues('attack', 9706, 14999, 80, atkParams);
ok(s1.params[0] === '9639' && s1.params[1] === '67000', 'attack 反解回原始参数', JSON.stringify([s1.params[0], s1.params[1]]));
ok(s1.ok, 'attack 反解自检通过', JSON.stringify(s1.achieved));

// 加攻块：p3=3246000 p4=19000 p2=1 → Lv1 3265 / Lv80 4766
const buffParams = { 0: '3', 1: 'ATK', 2: '1', 3: '3246000', 4: '19000', 5: '0' };
ok(V.valueAt('atkUp', buffParams, 1) === 3265, 'atkUp: Lv1 = 3265', String(V.valueAt('atkUp', buffParams, 1)));
ok(V.valueAt('atkUp', buffParams, 80) === 4766, 'atkUp: 满级(80) = 4766', String(V.valueAt('atkUp', buffParams, 80)));
const s2 = V.solveFromValues('atkUp', 3265, 4766, 80, buffParams);
ok(s2.params[3] === '3246000' && s2.params[4] === '19000', 'atkUp 反解回原始参数', JSON.stringify([s2.params[3], s2.params[4]]));
ok(s2.ok, 'atkUp 反解自检通过', JSON.stringify(s2.achieved));

// 换个目标值：想要 Lv1 3000 / 满级 9000
const s3 = V.solveFromValues('atkUp', 3000, 9000, 80, buffParams);
ok(s3.achieved.lv1 === 3000 && Math.abs(s3.achieved.lvmax - 9000) <= 1,
  '★ 目标 Lv1 3000 / 满级 9000 → 反解误差 ≤1', JSON.stringify(s3.achieved));
const s4 = V.solveFromValues('attack', 6000, 20000, 80, atkParams);
ok(s4.achieved.lv1 === 6000 && Math.abs(s4.achieved.lvmax - 20000) <= 1,
  '★ 目标 Lv1 6000 / 满级 20000 → 反解误差 ≤1', JSON.stringify(s4.achieved));

// 其它族
ok(V.valueAt('burn', { 1: '1200', 2: '34000' }, 80) === 1200 + Math.trunc(34000 * 80 / 1000), 'burn: p1 + p2×L/1000');
ok(V.valueAt('draw', { 0: '2' }, 80) === 2, 'draw: 抽牌数 = p0');
ok(V.valueAt('atkUpPct', { 5: '50' }, 80) === 50, 'atkUpPct: 百分比 = p5');
ok(V.shapeOf('enchant').kind === 'raw', 'enchant 归入 raw（没有单一数值，不乱显示）');
ok(V.describe('attack', atkParams, 80) === 'Lv1 9706 → 满级 14999', 'describe() 文案', V.describe('attack', atkParams, 80));

console.log('\n' + (bad === 0 ? '=== VALUES TEST PASSED ===' : '=== ' + bad + ' FAILURE(S) ==='));
process.exit(bad === 0 ? 0 : 1);
