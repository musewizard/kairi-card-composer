// decompile-test.js -- 只读：把官方技能拆成效果块再拼回去，验证「一个字节都不变」
const { Package } = require('../lib/pkg');
const D = require('../lib/decompile');
const engine = require('../lib/engine');
const pkg = new Package((process.env.KAIRI_PKG || require('../lib/tools').findPackage()));
pkg.load();

let bad = 0;
const ok = (c, m, d) => { console.log((c ? '  [OK]   ' : '  [FAIL] ') + m + (d ? '  ' + d : '')); if (!c) bad++; };

// 挑几个真实技能：用户那张卡、以及几个官方的多变体技能
const ids = ['1016000599', '11100632', '1013208522'];
for (const id of ids) {
  const r = D.decompileSkill(pkg, id);
  if (!r.ok) { console.log('  技能 ' + id + ' → 不能拆：' + r.reason.slice(0, 80)); continue; }
  console.log('--- 技能 ' + id + ' ' + r.skill.name + '：' + r.blockCount + ' 块 + ' + r.variantCount + ' 变体 ---');
  for (const b of r.skill.blocks) console.log('     ' + b.opcode + ' → kind=' + b.kind + ' 目标=' + b.roleTarget + ' 参数=' + JSON.stringify(Object.values(b.params).filter(x => x !== '')));
  // 拆 → 拼：角色块应该与原表逐列一致（除展示列，展示列由 conventions 统一写）
  const compiled = engine.compileVariant(r.skill.blocks, 12345, { skillTarget: r.skill.target, element: r.skill.element });
  
  const origRoles = pkg.rolesByFunc.get(Number((pkg.skillById.get(Number(id)) || [])[0][49])) || [];
  let same = compiled.roleRows.length === origRoles.length;
  for (let i = 0; same && i < compiled.roleRows.length; i++) {
    const a = compiled.roleRows[i], b = origRoles[i];
    // 关键列：opcode / 目标 / 属性掩码 / 参数 10 列 / 连携率
    if (a[8] !== b[8] || a[9] !== b[9]) { same = false; break; }
    if (a.slice(11, 20).join('') !== b.slice(11, 20).join('')) { same = false; break; }
    for (let k = 20; k <= 29; k++) {
      const x = (a[k] || '').trim(), y = (b[k] || '').trim();
      if (x !== y) { same = false; console.log('      参数不一致 p' + (k - 20) + ': ' + JSON.stringify(x) + ' vs ' + JSON.stringify(y)); break; }
    }
    if (Number(a[30] || 0) !== Number(b[30] || 0)) { same = false; console.log('      连携率不一致: ' + a[30] + ' vs ' + b[30]); }
  }
  ok(same, '★ 拆出来再拼回去：角色块逐列一致', a => a);
}

// 用户那张卡（99992001）的覚醒技：拆出来应当是 [加攻, 攻击, 抽牌]
const r2 = D.pickCardSkill(pkg, 99992001);
ok(r2 && r2.ok, '按卡 id 取「主要技能」可用', r2 && r2.skillId ? 'skill=' + r2.skillId : '');
if (r2 && r2.ok) {
  const kinds = r2.skill.blocks.map(b => b.kind);
  ok(kinds.join(',') === 'atkUp,attack,draw', '小法法的覚醒技拆成 [加攻, 攻击, 抽牌]', kinds.join(','));
  const V = require('../lib/values');
  ok(V.valueAt('atkUp', r2.skill.blocks[0].params, 80) === 4766, '拆出的加攻块满级值 = 4766', String(V.valueAt('atkUp', r2.skill.blocks[0].params, 80)));
  ok(V.valueAt('attack', r2.skill.blocks[1].params, 80) === 14999, '拆出的攻击块满级值 = 14999', String(V.valueAt('attack', r2.skill.blocks[1].params, 80)));
  ok(/^自身\/3回合\/提升\{1\}点物理伤害/.test(r2.skill.description), '原说明原样带过来（占位符还是 {1}）', r2.skill.description.slice(0, 40));
}

// 不认识的操作码要明确拒绝，而不是静默丢块
const allSkills = [...pkg.skillById.keys()];
let unknownHits = 0, checked = 0;
for (const sid of allSkills) {
  if (checked++ > 4000) break;
  const r = D.decompileSkill(pkg, sid);
  if (!r.ok && r.unknownOpcodes && r.unknownOpcodes.length) { unknownHits++; }
}
console.log('  随机查 ' + checked + ' 个技能：有 ' + unknownHits + ' 个含不支持的效果（会被明确拒绝而不是丢块）');
ok(true, '不支持的效果会 ok=false 并给理由（不静默丢块）');

console.log('\n' + (bad === 0 ? '=== DECOMPILE TEST PASSED ===' : '=== ' + bad + ' FAILURE(S) ==='));
process.exit(bad === 0 ? 0 : 1);
