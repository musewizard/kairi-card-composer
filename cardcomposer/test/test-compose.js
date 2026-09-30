#!/usr/bin/env node
/*
 * test-compose.js -- end-to-end test of the composer without touching the real package.
 *
 * Builds a scratch package skeleton (only the files the injector reads) and runs a
 * DRY-RUN injection, then asserts the generated rows against the real tables:
 *   - the 覚醒技 really has the variant that turns 单体 into 全体 under 【3连携以上】
 *   - the draw block carries an all-ones attribute mask  (the bug that silently killed it)
 *   - {N} placeholders are rebased across blocks
 *   - the auto-generated 通常技 is weaker than the 覚醒技
 *   - the derived Lv1 values would satisfy the server's recomputation
 */
'use strict';
const WORK_ROOT = process.env.KAIRI_ROOT || require('../lib/tools').ROOT;
const fs = require('fs');
const path = require('path');
const { inject } = require('../lib/injector');
const engine = require('../lib/engine');

const REAL = (process.env.KAIRI_PKG || require('../lib/tools').findPackage());
const SCRATCH = (WORK_ROOT + '\\cardforge-sandbox\\pkg');

let bad = 0;
const ok = (c, m, d) => { console.log((c ? '  [OK]   ' : '  [FAIL] ') + m + (d ? '  ' + d : '')); if (!c) bad++; };

// ---------------------------------------------------------------- scratch package
function buildScratch() {
  const srv = path.join(SCRATCH, 'resource-set', '_local', 'control', 'server');
  fs.mkdirSync(path.join(srv, 'cn602-card-master'), { recursive: true });
  fs.mkdirSync(path.join(srv, 'cn602-battle-master'), { recursive: true });
  fs.mkdirSync(path.join(srv, 'cn602-admin-assets', 'card'), { recursive: true });
  fs.mkdirSync(path.join(SCRATCH, 'resource-set', 'resources', 'patch', 'main_c'), { recursive: true });
  const realSrv = path.join(REAL, 'resource-set', '_local', 'control', 'server');
  const copies = [
    ['cn602-card-master/card.csv', 'cn602-card-master/card.csv'],
    ['cn602-battle-master/skill_player.csv', 'cn602-battle-master/skill_player.csv'],
    ['cn602-battle-master/skill_role_player.csv', 'cn602-battle-master/skill_role_player.csv'],
    ['cn602-card-runtime-master.json', 'cn602-card-runtime-master.json'],
    ['cn602-admin-assets/manifest.json', 'cn602-admin-assets/manifest.json'],
  ];
  for (const [a, b] of copies) fs.copyFileSync(path.join(realSrv, a), path.join(srv, b));
  for (const id of [10274039, 10000182]) {
    const src = path.join(realSrv, 'cn602-admin-assets', 'card', id + '.webp');
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(srv, 'cn602-admin-assets', 'card', id + '.webp'));
  }
  fs.writeFileSync(path.join(SCRATCH, 'resource-set', 'resource_set_placeholder.txt'), 'scratch\n');
  return srv;
}
console.log('building scratch package at ' + SCRATCH);
buildScratch();

// ---------------------------------------------------------------- the draft
// A card that exercises every feature the user asked for:
//   - all attributes filled by hand (not cloned)
//   - 覚醒技 composed from blocks: 提升伤害 + 伤害 + 抽牌
//   - one conditional variant that changes the TARGET to 全体 (单体→AOE)
//   - the 通常技 auto-generated as a weakened copy
const NEW_ID = 99999001;   // 测试专用号段（避开用户自己造的 9999xxxx 卡）
const draft = {
  id: NEW_ID,
  clone: 10274039,
  crown: '【MOD】',
  name: '测试·效果拼接卡',
  rarityRank: 7,
  arthurType: 1,          // 佣兵
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
  normal: {
    mode: 'custom',
    skill: {
      name: '术冰／测试弱化', subName: 'test-weak', kind: 'SORCERY',
      element: 'ICE', job: 'THIEF', damageKind: 'MAGIC', cost: 2,
      target: 'ENEMY_ONE',
      blocks: engine.weaken([
        { kind: 'attack', params: { 0: '500', 1: '12000', 2: '1000', 4: '1', 5: 'INT', 6: '150', 7: 'ICE', 8: 'MAGIC' }, chainRate: 20 },
      ], 0.6),
    },
  },
  arthur: {
    mode: 'custom',
    skill: {
      name: '术援／测试觉醒', subName: 'test-awaken', kind: 'SORCERY',
      element: 'ICE', job: 'MERCENARY', damageKind: 'MAGIC', cost: 1,
      target: 'ENEMY_ONE',
      blocks: [
        { kind: 'atkUp', params: { 0: '3', 1: 'INT', 3: '2000', 4: '200' }, roleTarget: 'SELF', chainRate: 20 },
        { kind: 'attack', params: { 0: '1000', 1: '20000', 2: '1000', 4: '1', 5: 'INT', 6: '150', 7: 'ICE', 8: 'MAGIC' }, chainRate: 20 },
        { kind: 'draw', params: { 0: '2' }, roleTarget: 'SELF' },
      ],
      variants: [
        {
          skillTarget: 'ENEMY_ALL',
          condition: 'DECK_COMBO_COUNT',
          conditionValues: { min: 3, max: 0 },
          priority: 1,
          blocks: [
            { kind: 'attack', params: { 0: '1000', 1: '20000', 2: '1000', 4: '1', 5: 'INT', 6: '150', 7: 'ICE', 8: 'MAGIC' }, chainRate: 20 },
            { kind: 'draw', params: { 0: '2' }, roleTarget: 'SELF' },
          ],
        },
      ],
    },
  },
};

console.log('\n=== running dry-run injection ===');
const logs = [];
let result;
try {
  result = inject(draft, { packageRoot: SCRATCH, write: true, rebuildBundle: false, log: m => { logs.push(m); console.log('  | ' + m); } });
} catch (e) {
  console.log('  [FAIL] injection threw: ' + e.message);
  process.exit(1);
}

// ---------------------------------------------------------------- assertions
console.log('\n=== assertions ===');
const srv = path.join(SCRATCH, 'resource-set', '_local', 'control', 'server');
function readCsv(p) {
  return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n')
    .filter(l => l && !l.startsWith('#')).map(l => {
      const o = []; let sb = '', q = false;
      for (let i = 0; i < l.length; i++) { const c = l[i];
        if (q) { if (c === '"') { if (l[i + 1] === '"') { sb += '"'; i++; } else q = false; } else sb += c; }
        else { if (c === '"') q = true; else if (c === ',') { o.push(sb); sb = ''; } else sb += c; } }
      o.push(sb); return o;
    });
}
const cards = readCsv(path.join(srv, 'cn602-card-master', 'card.csv'));
const skills = readCsv(path.join(srv, 'cn602-battle-master', 'skill_player.csv'));
const roles = readCsv(path.join(srv, 'cn602-battle-master', 'skill_role_player.csv'));
const master = JSON.parse(fs.readFileSync(path.join(srv, 'cn602-card-runtime-master.json'), 'utf8'));
const admin = JSON.parse(fs.readFileSync(path.join(srv, 'cn602-admin-assets', 'manifest.json'), 'utf8'));

ok(cards.filter(r => r[0] === String(NEW_ID)).length === 1, 'card.csv has exactly one row for the new card');
const card = cards.find(r => r[0] === String(NEW_ID));
ok(!!card, 'card row found');
ok(card[4] === '【MOD】' && card[5] === '测试·效果拼接卡', 'crown + name', card[4] + card[5]);
ok(card[9] === '1', 'cost = 1', card[9]);
ok(card[10] === '2000' && card[13] === '700' && card[16] === '700' && card[19] === '350', 'hand-filled initial params', [card[10], card[13], card[16], card[19]].join('/'));
ok(card[11] === '6000' && card[14] === '2000', 'hand-filled maximum params', [card[11], card[14]].join('/'));

const normalId = Number(card[26]), arthurId = Number(card[27]);
ok(normalId > 0 && arthurId > 0 && normalId !== arthurId, 'distinct normal/arthur skill ids', normalId + '/' + arthurId);

const arthurRows = skills.filter(r => r[0] === String(arthurId));
console.log('  arthur skill rows: ' + arthurRows.length);
ok(arthurRows.length === 2, 'arthur skill has 2 variants (default + conditional)', String(arthurRows.length));
const defRow = arthurRows.find(r => !(r[36] || '').trim());
const varRow = arthurRows.find(r => (r[36] || '').trim() === 'DECK_COMBO_COUNT');
ok(!!defRow, 'default variant exists (no condition)');
ok(!!varRow, 'conditional variant exists');
if (defRow) ok(defRow[19] === 'ENEMY_ONE', 'default variant target = ENEMY_ONE', defRow[19]);
if (varRow) {
  ok(varRow[19] === 'ENEMY_ALL', '★ conditional variant switches target to ENEMY_ALL (单体→AOE)', varRow[19]);
  ok(varRow[37] === '3' && varRow[38] === '0', 'condition params = [3,0] (3连携以上)', JSON.stringify([varRow[37], varRow[38]]));
  ok((varRow[48] || '').trim() === '1', 'condition variant 優先度 = 1', varRow[48]);
  ok(!(varRow[3] || '').trim(), 'variant row carries no description (official convention)', JSON.stringify(varRow[3]));
}
if (defRow) {
  const desc = defRow[3] || '';
  ok(desc.includes('己方全体') || desc.includes('自身'), 'description mentions the player-side buff');
  // ★ 官方约定：说明里的 {N} 指向「块内第 1 个参数」p0（实测 18610/20918）。
  //   客户端把效果的数值挂在那里；指向 p3 会显示原始数字（ATK_UP_FIXED 的 p3 是 7 位数，
  //   卡面上会变成一串乱码数字）。所以增益必须引用 {1}。
  ok(/\{1\}/.test(desc), '★ 增益说明引用 {1}（= 块内第 1 个参数，官方写法）', JSON.stringify(desc.slice(0, 120)));
  ok(!/\{4\}/.test(desc), '增益说明不再引用 {4}（= p3 原始大数，客户端会显示乱码）');
  ok(/\{11\}/.test(desc), '第三个块的伤害说明 = {11}', '');
}

// role blocks of the default variant
const funcDef = Number(defRow[49]);
const funcVar = Number(varRow[49]);
const rDef = roles.filter(r => r[0] === String(funcDef));
const rVar = roles.filter(r => r[0] === String(funcVar));
ok(rDef.length === 3, 'default variant has 3 role blocks', String(rDef.length));
ok(rVar.length === 2, 'conditional variant has 2 role blocks', String(rVar.length));
for (const r of [...rDef, ...rVar]) {
  const mask = r.slice(11, 20).join('');
  ok(mask === '111111111', 'role ' + r[8] + ': attribute mask is all-ones (never blank)  mask=' + JSON.stringify(mask));
}
const drawDef = rDef.find(r => r[8] === 'DEAL_BONUS');
ok(!!drawDef, 'draw block present in the default variant');
if (drawDef) ok(drawDef[20] === '2', 'draw block p0 = 2', drawDef[20]);
const atkVar = rVar.find(r => r[8] === 'ATTACK_AA');
if (atkVar) ok(atkVar[9] === 'ENEMY_ALL', '★ conditional variant attack block role target = ENEMY_ALL', atkVar[9]);
const atkDef = rDef.find(r => r[8] === 'ATTACK_AA');
if (atkDef) {
  ok(atkDef[9] === 'SELECT', 'default attack block role target = SELECT', atkDef[9]);
  ok(atkDef[27] === 'ICE', 'attack block element = ICE', atkDef[27]);
  ok(atkDef[3] === 'pl_magic_ice_a', 'attack block 3D playlist matches ICE', atkDef[3]);
}

// ---------------------------------------------------------------- 官方写法（展示列）
// 这一组是 2026-09-23 那轮修的东西：早期版本把 HitPosition 写到了第 7 列、仇恨上限写死
// 1000000、技能行的展示列全空 —— 客户端会算不出来（卡面数字变乱码 / 卡组读不出）。
console.log('\n=== 官方写法（展示列）===');
{
  const buffDef = rDef.find(r => r[8] === 'ATK_UP_FIXED');
  if (atkDef) {
    ok(atkDef[5] === 'TARGET', '★ 攻击块第5列(HitPosition) = TARGET（官方写法）', JSON.stringify(atkDef[5]));
    ok(atkDef[7] === '', '★ 攻击块第7列 = 空（早期版本错把 TARGET 写在这里）', JSON.stringify(atkDef[7]));
    ok(atkDef[31] === '10000', '★ 攻击块第31列(仇恨上限) = 10000（官方）', JSON.stringify(atkDef[31]));
  }
  if (buffDef) {
    ok(['', 'TARGET', 'ROOT'].includes(buffDef[5] || ''), '增益块第5列 = 官方取值（按 opcode 统计出来的众数）', JSON.stringify(buffDef[5]));
    ok(buffDef[31] === '', '★ 增益块第31列(仇恨上限) = 空（官方；早期版本写 1000000）', JSON.stringify(buffDef[31]));
    ok(buffDef[4] === '' || /^ef_Btl_3D_/.test(buffDef[4] || ''), '增益块第4列 = 3D 特效名或空（官方取值）', JSON.stringify(buffDef[4]));
  }
  const sRow = skills.find(r => r[0] === String(arthurId));
  // ★ 第 5 列 DisplayRole = 卡面显示哪个块。测试卡的块序是 [增益, 攻击, 抽牌]，
  //   所以必须指向第 2 块（攻击）—— 指第 1 块会让卡面数字取到增益的原始大数（乱码）。
  ok(sRow[5] === '2', '★ 技能行第5列(DisplayRole) = 2（指向攻击块）', JSON.stringify(sRow[5]));
  ok(sRow[4] === '11', '★ 技能行第4列 = (DisplayRole-1)*10+1 = 11（官方写法）', JSON.stringify(sRow[4]));
  ok((sRow[7] || '') === 'ATTACK', '技能行第7列(效果分类) = ATTACK', JSON.stringify(sRow[7]));
  ok(/^RANK[1-5]$/.test(sRow[17] || ''), '★ 技能行第17列(RANK) 有值（稀有度7/覚醒 → RANK5）', JSON.stringify(sRow[17]));
  ok((sRow[17] || '') === 'RANK5', '  RANK = RANK5（EXR 覚醒技的官方规律）', sRow[17]);
  ok(/^\d+$/.test(sRow[15] || ''), '技能行第15列(效果码) 有值', JSON.stringify(sRow[15]));
  ok(sRow[18] === '100', '技能行第18列(HateRatio) = 100', JSON.stringify(sRow[18]));
  // 服务端 battle_engine_display_power.go:36 取 roles[DisplayRole-1]，取不到就是 0（卡面 0000000）
  const dr = Number(sRow[5]);
  const drRow = rDef[dr - 1];
  ok(!!drRow && drRow[8] === 'ATTACK_AA', '★ DisplayRole 指向的块是攻击块（服务端就是拿它算卡面数字）',
    drRow ? drRow[8] : '(越界)');
}

// normal skill must be weaker
const nRows = skills.filter(r => r[0] === String(normalId));
const nFunc = Number(nRows[0][49]);
const nAtk = roles.filter(r => r[0] === String(nFunc)).find(r => r[8] === 'ATTACK_AA');
const aAtk = rDef.find(r => r[8] === 'ATTACK_AA');
if (nAtk && aAtk) {
  ok(Number(nAtk[20]) < Number(aAtk[20]), '★ 通常技 is weaker than 覚醒技 (p0)', nAtk[20] + ' < ' + aAtk[20]);
  ok(Number(nAtk[21]) < Number(aAtk[21]), '通常技每级威力 also weaker (p1)', nAtk[21] + ' < ' + aAtk[21]);
  ok(nRows.length === 1, '通常技 has no conditional variants (auto-weakened)', String(nRows.length));
}

// ★ 2026-09-25 用户定的规则：不管覚醒技有几段，通常技**只取第 1 段**并弱化
{
  const three = [
    { kind: 'atkUp', params: { 0: '3', 1: 'INT', 3: '2000', 4: '200' }, roleTarget: 'SELF', chainRate: 20 },
    { kind: 'attack', params: { 0: '1000', 1: '20000' }, chainRate: 20 },
    { kind: 'draw', params: { 0: '2' }, roleTarget: 'SELF' },
  ];
  const w = engine.weaken(three, 0.6);
  ok(w.length === 1, '★ engine.weaken 只保留第 1 段（覚醒技几段都一样）', w.length + ' 段');
  ok(w[0].kind === 'atkUp', '保留的就是原来的第 1 段', w[0].kind);
  ok(w[0].params[3] === '1200' && w[0].params[4] === '120', '第 1 段数值按系数弱化（×0.6）', w[0].params[3] + ' / ' + w[0].params[4]);
  ok(three[0].params[3] === '2000', '不改原对象（覚醒技那段不变）', three[0].params[3]);
  const wa = engine.weakenAll(three, 0.6);
  ok(wa.length === 3, 'engine.weakenAll（老行为）仍然逐段弱化，保留给特殊场合', String(wa.length));
  ok(engine.weaken([], 0.6).length === 0, '空输入返回空（不崩）');
}

// master + admin
const tpl = master.card_templates.find(t => t.card_id === NEW_ID);
ok(!!tpl, 'card_templates entry added');
if (tpl) {
  ok(tpl.name === '【MOD】测试·效果拼接卡', 'template name', tpl.name);
  const policy = master.card_progression_policy;
  const bonus = tpl.premium_rarity ? policy.fame_premium : policy.fame_normal;
  const wantHp = tpl.parameter_initial.hp + Math.trunc(bonus.hp * tpl.fame / 100);
  ok(tpl.hp === wantHp, '★ derived Lv1 hp matches the server formula', tpl.hp + ' == ' + wantHp);
  ok(tpl.next_level_experience === master.card_experience_tables[String(tpl.experience_table_id)][0],
    'next_level_experience matches the experience table');
}
const rank = master.deck_rank_policy.cards[String(NEW_ID)];
ok(!!rank, 'deck_rank entry added');
if (rank) ok(rank.arthur_type === 1, 'arthur_type = 1 (佣兵)', String(rank.arthur_type));
ok(admin.catalog_image_coverage.card.entry_count === master.card_templates.length,
  'admin entry_count matches template count',
  admin.catalog_image_coverage.card.entry_count + ' vs ' + master.card_templates.length);
ok(JSON.parse(fs.readFileSync(path.join(srv, 'cn602-card-runtime-master.json'), 'utf8')).card_templates.length === master.card_templates.length,
  'master JSON is still valid after the splice');

// ---------------------------------------------------------------- 第 7 列必须是稀有度英文名
// 实测：官方 8447 行里第 7 列全是英文名（EXRARE…），只有早期版本的工具写了数字，那是错的。
const cardRow = cards.find(r => r[0] === String(NEW_ID));
if (cardRow) {
  ok(cardRow[7] === 'EXRARE', '★ card.csv 第7列 = 稀有度英文名（不是数字）', JSON.stringify(cardRow[7]));
  ok(cardRow[8] === '' || ['RED', 'PURPLE', 'WHITE'].includes(cardRow[8]),
    'card.csv 第8列 = 高稀有度颜色（非高级卡应为空）', JSON.stringify(cardRow[8]));
  ok(cardRow[26] === String(normalId) && cardRow[27] === String(arthurId), 'card.csv 两个技能列', cardRow[26] + '/' + cardRow[27]);
}

// ---------------------------------------------------------------- 双属性卡
// 官方约定（实测 1620/1622）：掩码 = 两条技能属性串的位或；两条技能写同一个双属性串；
// 伤害块 Parameters[7] 也写这个串；3D 演出换成 _multi_ 形式（没有 _a 版本）。
console.log('\n=== 双属性（FIRE_ICE）===');
const DUAL_ID = 99999002;
const dualDraft = JSON.parse(JSON.stringify(draft));
dualDraft.id = DUAL_ID;
dualDraft.name = '测试·双属性卡';
dualDraft.element = 'FIRE_ICE';
dualDraft.normal.skill.element = 'FIRE_ICE';
dualDraft.arthur.skill.element = 'FIRE_ICE';
for (const b of dualDraft.arthur.skill.blocks) if (b.kind === 'attack') b.params[7] = '';   // 故意留空，工具应自动补
let dualRes;
try {
  dualRes = inject(dualDraft, { packageRoot: SCRATCH, write: true, rebuildBundle: false, log: () => {} });
} catch (e) {
  console.log('  [FAIL] 双属性注入抛错: ' + e.message);
  bad++;
}
if (dualRes) {
  const dCards = readCsv(path.join(srv, 'cn602-card-master', 'card.csv'));
  const dSkills = readCsv(path.join(srv, 'cn602-battle-master', 'skill_player.csv'));
  const dRoles = readCsv(path.join(srv, 'cn602-battle-master', 'skill_role_player.csv'));
  const dMaster = JSON.parse(fs.readFileSync(path.join(srv, 'cn602-card-runtime-master.json'), 'utf8'));
  const dTpl = dMaster.card_templates.find(t => t.card_id === DUAL_ID);
  ok(!!dTpl, '双属性卡写进主表');
  if (dTpl) ok(dTpl.fusion_attributes === 3, '★ 双属性掩码 = 3 (FIRE|ICE)', String(dTpl.fusion_attributes));
  const dRow = dCards.find(r => r[0] === String(DUAL_ID));
  if (dRow) {
    ok(dRow[7] === 'EXRARE', '双属性卡第7列也是名字', JSON.stringify(dRow[7]));
    const dNormal = dSkills.filter(r => r[0] === String(dRow[26]));
    const dArth = dSkills.filter(r => r[0] === String(dRow[27]));
    ok(dNormal.length && dNormal[0][11] === 'FIRE_ICE', '★ 通常技元素 = FIRE_ICE', dNormal[0] && dNormal[0][11]);
    ok(dArth.length && dArth[0][11] === 'FIRE_ICE', '★ 覚醒技元素 = FIRE_ICE', dArth[0] && dArth[0][11]);
    const dFunc = Number(dArth[0][49] || dArth[0][0]);
    const dAtk = dRoles.filter(r => r[0] === String(dFunc)).find(r => r[8] === 'ATTACK_AA');
    ok(!!dAtk, '双属性卡的伤害块存在');
    if (dAtk) {
      ok(dAtk[27] === 'FIRE_ICE', '★ 伤害块 Parameters[7] 自动补成 FIRE_ICE', JSON.stringify(dAtk[27]));
      ok(dAtk[3] === 'pl_magic_multi_c', '★ 双属性 3D 演出 = pl_magic_multi_c', dAtk[3]);
      ok(dAtk.slice(11, 20).join('') === '111111111', '双属性卡属性掩码列仍是全 1');
    }
  }
}

console.log('\n' + (bad === 0 ? '=== COMPOSER TEST PASSED ===' : '=== ' + bad + ' FAILURE(S) ==='));
process.exit(bad === 0 ? 0 : 1);
