const { Package } = require('../lib/pkg');
const C = require('../lib/compose');
const t0 = Date.now();
const pkg = new Package((process.env.KAIRI_PKG || require('../lib/tools').findPackage())).load();
console.log('load ms:', Date.now() - t0);
const cards = C.listCards(pkg);
console.log('cards:', cards.length);
console.log('sample:', JSON.stringify(cards.find(c => c.id === 10000182)));
const src = C.cloneSource(pkg, 10000182);
console.log('clone src keys:', Object.keys(src).join(','));
console.log('  initial:', JSON.stringify(src.parameterInitial), ' max:', JSON.stringify(src.parameterMaximum));
console.log('  arthurType:', src.arthurType, 'premium:', src.premiumRarity, 'expTable:', src.experienceTableId);
console.log('  normalSkill:', src.normalSkill, 'arthurSkill:', src.arthurSkill, 'support:', JSON.stringify(src.support));
const pal = C.palette(pkg);
console.log('palette effects:', pal.length);
console.log('  attack targets:', JSON.stringify(pal.find(p => p.id === 'attack').allowedTargets));
console.log('  draw observed p0:', JSON.stringify(pal.find(p => p.id === 'draw').params['0'].observed.slice(0, 4)));
console.log('  cover params p1 observed:', JSON.stringify(pal.find(p => p.id === 'cover').params['1'].observed.slice(0, 4)));
const conds = C.conditions();
console.log('conditions:', conds.length);
console.log('  combo:', JSON.stringify(conds.find(c => c.code === 'DECK_COMBO_COUNT')));

// live preview of a composed draft
const draft = {
  id: 99992001, clone: 10000182, crown: '【MOD】', name: '预览测试',
  rarityRank: 7, arthurType: 1, cost: 1, levelMax: 80, fameMax: 100, loveMax: 10000,
  pictId: 10152034, premiumRarity: false, experienceTableId: 107,
  parameterInitial: { hp: 2000, attack: 700, magic: 700, mind: 350 },
  parameterMaximum: { hp: 6000, attack: 2000, magic: 2000, mind: 1000 },
  element: 'ICE',
  arthur: {
    mode: 'custom',
    skill: {
      name: '术援／预览', kind: 'SORCERY', element: 'ICE', damageKind: 'MAGIC', target: 'ENEMY_ONE', displayRole: 1,
      blocks: [
        { kind: 'atkUp', params: { 0: '3', 1: 'INT', 3: '2000', 4: '200' }, roleTarget: 'SELF' },
        { kind: 'attack', params: { 0: '1000', 1: '20000', 5: 'INT', 7: 'ICE', 8: 'MAGIC' } },
        { kind: 'draw', params: { 0: '2' }, roleTarget: 'SELF' },
      ],
      variants: [{ skillTarget: 'ENEMY_ALL', condition: 'DECK_COMBO_COUNT', conditionValues: { min: 3, max: 0 }, priority: 1, blocks: [{ kind: 'attack', params: { 0: '1000', 1: '20000', 5: 'INT', 7: 'ICE', 8: 'MAGIC' } }] }],
    },
  },
  normal: { mode: 'none' },
};
const r = C.resolveDraft(pkg, draft);
console.log('\n=== resolveDraft ===');
console.log('jobCn:', r.jobCn, 'rarityCn:', r.rarityCn, 'element:', r.element);
console.log('derivedLv1:', JSON.stringify(r.derivedLv1), 'nextExp:', r.nextLevelExperience);
console.log('arthur desc:', r.slots.arthur.description);
console.log('placeholderProblems:', JSON.stringify(r.slots.arthur.placeholderProblems));
for (const b of r.slots.arthur.blocks) {
  console.log('  block' + b.index + ' ' + b.name + '(' + b.opcode + ') roleTarget=' + b.roleTarget +
    ' display=' + b.displayValue + ' params=' + JSON.stringify(b.params.filter(x => x !== '')));
}
for (const v of r.slots.arthur.variants) {
  console.log('  variant target=' + v.skillTarget + ' ' + v.conditionText + ' prio=' + v.priority + ' blocks=' + v.blockCount);
}
