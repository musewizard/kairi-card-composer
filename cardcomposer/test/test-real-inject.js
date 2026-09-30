// Real (non-dry-run) injection into the actual package, via the running server API.
//
// ★★ 危险：这是**手动**冒烟测试，会真的往用户包里塞一张新卡（并在游戏里出现）。★★
// 2026-09-24 事故：把它当成普通测试跑了一遍（for-each test\test-*.js），用户的包里就多了
// 一张「【MOD】效果拼接器·联调验证卡」（99992004）。所以现在必须显式给环境变量才跑：
//     $env:DSH_ALLOW_REAL_INJECT='1'; node test\test-real-inject.js
// 撤掉它用 inspect\remove-card.js <cardId> --write（会连技能/角色行、模板、缩略图一起清干净）。
const BASE = 'http://127.0.0.1:8788';
if (process.env.DSH_ALLOW_REAL_INJECT !== '1') {
  console.log('（跳过）这是真注入测试，会往用户包里加一张卡。');
  console.log('确实要跑就设 DSH_ALLOW_REAL_INJECT=1；撤卡用 inspect\\remove-card.js <cardId> --write');
  process.exit(0);
}
(async () => {
  const st = await (await fetch(BASE + '/api/state')).json();
  console.log('package:', st.package);
  console.log('before: templates', st.templateCount, ' cards', st.cardCount);

  const draft = {
    id: st.nextCardId,
    clone: 10000182,
    crown: '【MOD】',
    name: '效果拼接器·联调验证卡',
    rarityRank: 7,
    arthurType: 1,
    cost: 1,
    levelMax: 80,
    loveMax: 10000,
    fameMax: 100,
    pictId: 10152034,
    premiumRarity: false,
    experienceTableId: 107,
    parameterInitial: { hp: 2000, attack: 700, magic: 700, mind: 350 },
    parameterMaximum: { hp: 6000, attack: 2000, magic: 2000, mind: 1000 },
    element: 'ICE',
    arthur: {
      mode: 'custom',
      skill: {
        name: '术援／拼接验证', subName: 'composer-smoke', kind: 'SORCERY',
        element: 'ICE', job: 'MERCENARY', damageKind: 'MAGIC', cost: 1,
        target: 'ENEMY_ONE', displayRole: 1,
        blocks: [
          { kind: 'atkUp', params: { 0: '3', 1: 'INT', 3: '2000', 4: '200' }, roleTarget: 'SELF', chainRate: 20 },
          { kind: 'attack', params: { 0: '1000', 1: '20000', 2: '1000', 4: '1', 5: 'INT', 6: '150', 7: 'ICE', 8: 'MAGIC' }, roleTarget: 'SELECT', chainRate: 20 },
          { kind: 'draw', params: { 0: '2' }, roleTarget: 'SELF', chainRate: 0 },
        ],
        variants: [{
          skillTarget: 'ENEMY_ALL',
          condition: 'DECK_COMBO_COUNT',
          conditionValues: { min: 3, max: 0 },
          priority: 1,
          blocks: [
            { kind: 'attack', params: { 0: '1000', 1: '20000', 2: '1000', 4: '1', 5: 'INT', 6: '150', 7: 'ICE', 8: 'MAGIC' }, roleTarget: 'ENEMY_ALL', chainRate: 20 },
            { kind: 'draw', params: { 0: '2' }, roleTarget: 'SELF', chainRate: 0 },
          ],
        }],
      },
    },
    normal: {
      mode: 'custom',
      skill: {
        name: '术冰／拼接验证·弱', subName: '', kind: 'SORCERY', element: 'ICE', job: 'THIEF',
        damageKind: 'MAGIC', cost: 1, target: 'ENEMY_ONE', displayRole: 1,
        blocks: [{ kind: 'attack', params: { 0: '600', 1: '12000', 2: '1000', 4: '1', 5: 'INT', 6: '150', 7: 'ICE', 8: 'MAGIC' }, roleTarget: 'SELECT', chainRate: 20 }],
        variants: [],
      },
    },
  };

  console.log('\nrunning REAL injection ...');
  const r = await fetch(BASE + '/api/inject', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ draft, dryRun: false }),
  });
  const j = await r.json();
  if (!r.ok) { console.log('FAILED: ' + j.error); process.exit(1); }
  console.log(j.logs.map(l => '  | ' + l).join('\n'));
})().catch(e => { console.error('FATAL', e); process.exit(1); });
