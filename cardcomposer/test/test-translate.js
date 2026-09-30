#!/usr/bin/env node
/*
 * test-translate.js -- 日服原文转中文的自检（不碰包）。
 *
 * 背景：官方 CN 包里还留着日服原文（导入卡）—— 卡名 2430 行、技能说明 3256 行。
 * 用户要求参考日服卡效果时全部转成汉语。这里既检查「该翻的翻对」，也检查
 * 「本来就是中文的一个字都不许改」。
 */
'use strict';
const PKG_ROOT = process.env.KAIRI_PKG || require('../lib/tools').findPackage();
const fs = require('fs');
const path = require('path');
const T = require('../lib/translate');
let bad = 0;
const ok = (c, m, d) => { console.log((c ? '  [OK]   ' : '  [FAIL] ') + m + (d ? '  ' + d : '')); if (!c) bad++; };

const cases = [
  ['敵単体/物理/{1}の火ダメージ', '敌单体/物理/{1}点火属性伤害'],
  ['味方全員/3T/最大HPを{11}アップ', null],                       // 只要求「没有假名残留」
  ['【自分/火/3枚以上】', '【自身/火/3张以上】'],
  ['感謝型 盗賊アーサー2020', '感谢型 盗贼亚瑟2020'],
  ['魔法剣/{1}の氷ダメージ', '魔法剑/{1}点冰属性伤害'],
  ['チェイン数に応じて威力アップ', '威力随连携数提升'],
  ['ｸﾘﾃｨｶﾙ率を{5}アップ', null],
];
for (const [src, want] of cases) {
  const out = T.toChinese(src);
  if (want !== null) ok(out === want, '翻译 ' + JSON.stringify(src), JSON.stringify(out));
  else ok(!T.hasJapanese(out), '翻完没有假名残留 ' + JSON.stringify(src), JSON.stringify(out));
}
// 中文/英文不许被改动
for (const s of ['自身/3回合/提升{1}点物理伤害', '敌全体/魔法/{1}点光属性伤害<br>物理攻击力100%的4次攻击', '【己方/封印・能量封印状态/敌方行动后发动】', 'MOD测试型小法法']) {
  ok(T.toChinese(s) === s, '本来就是中文 → 一个字都不改 ' + JSON.stringify(s.slice(0, 24)));
}
// 半角片假名表：曾经用「序号+偏移」算错，把 ﾁｪｲﾝ 变成 チオゲポ
ok(T.normalizeKana('ﾁｪｲﾝ') === 'チェイン', '半角→全角（小写假名/ン 不能算错）', T.normalizeKana('ﾁｪｲﾝ'));
ok(T.normalizeKana('ｶｰﾄﾞ') === 'カード', '半角→全角（长音符 + 浊音点）', T.normalizeKana('ｶｰﾄﾞ'));
ok(T.toChinese('使用ｶｰﾄﾞｺｽﾄ合計') === '使用卡牌费用合计', '半角词表', T.toChinese('使用ｶｰﾄﾞｺｽﾄ合計'));

// 拿真实数据测覆盖率（只读）
const SRV = (PKG_ROOT + '\\resource-set\\_local\\control\\server');
function rows(f) {
  return fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n')
    .filter(l => l && !l.startsWith('#')).map(l => l.split(','));
}
const skills = rows(path.join(SRV, 'cn602-battle-master', 'skill_player.csv'));
const jp = skills.filter(r => T.hasJapanese(r[3]));
let cleared = 0;
for (const r of jp) if (!T.hasJapanese(T.toChinese(r[3]))) cleared++;
const rate = jp.length ? cleared * 100 / jp.length : 100;
console.log('  说明里的日文行 = ' + jp.length + '，完全转中文 ' + cleared + '（' + rate.toFixed(1) + '%）');
ok(rate >= 90, '★ 说明翻译覆盖率 ≥90%（剩下的多是专有名词/画师名，保留原文）', rate.toFixed(1) + '%');

console.log('\n' + (bad === 0 ? '=== TRANSLATE TEST PASSED ===' : '=== ' + bad + ' FAILURE(S) ==='));
process.exit(bad === 0 ? 0 : 1);
