'use strict';
/*
 * decompile.js -- 把「已有的技能」拆回界面上的效果块。
 *
 * 用途（用户要的）：克隆一张卡的技能 → 数值直接填进拼接模块 → 拿老卡改数值。
 * 这样比从头拼块更省事，也少踩坑（块序、目标、连携率、条件变体都是现成的）。
 *
 * 拆出来的东西是**逐列照搬**的：效果块按角色块顺序、参数 10 列原样、角色块目标原样、
 * 连携倍率原样；条件变体连「条件参数 5 个格子」也原样带着（conditionValuesRaw），
 * 注入时优先用原始格子，保证数值/条件一个字节都不变。
 *
 * 唯一「不允许」的情况：角色块里出现工具不认识的操作码（比如全是敌人专用的效果）。
 * 这时**不静默丢掉**，而是 ok=false + 说明，让用户改用「沿用克隆源」。
 */

const { EFFECTS } = require('./effects');

const opcodeToKind = new Map();
for (const e of EFFECTS) if (!opcodeToKind.has(e.opcode)) opcodeToKind.set(e.opcode, e.id);

/** 5 个条件格子 → 界面用的对象（拿不准的就不填，注入时用 Raw 原样写）。 */
function conditionValuesFromCells(code, cells) {
  const c = (i) => (cells && cells[i] !== undefined ? String(cells[i]) : '');
  const n = (i) => { const v = parseInt(c(i), 10); return Number.isFinite(v) ? v : undefined; };
  switch (code) {
    case 'DECK_COMBO_COUNT': case 'TURN': case 'SELF_HP_PER': case 'FRIEND_HP_PER':
    case 'FRIEND_PLAY_NUM': case 'FRIEND_PLAY_COST_TOTAL': case 'SELF_PLAY_COST_TOTAL':
    case 'SELF_OTHER_PLAY_NUM': case 'SELF_PLAY_MOST_LOW_COST':
      return { min: n(0), max: n(1) };
    case 'RANDOM': return { percent: n(0) };
    case 'TARGET_ATTR': case 'ENEMY_SIDE_DEBUFF': case 'USER_SIDE_DEBUFF':
      return { element: c(0) };
    case 'SELF_OTHER_PLAY_ATTR': case 'SELF_MAIN_DECK_ATTR': case 'SELF_BLESS':
      return { element: c(0), count: n(1) };
    case 'SELF_OTHER_PLAY_SKILL_KIND': case 'SELF_MAIN_DECK_SKILL_KIND':
      return { kind: c(0), count: n(1) };
    case 'SELF_OTHER_PLAY_RARITY': return { rarity: c(0), count: n(1) };
    default: return {};
  }
}

/**
 * @returns {{ok:boolean, reason?:string, skill?:object, unknownOpcodes:string[], blockCount:number, variantCount:number}}
 */
function decompileSkill(pkg, skillId, opts) {
  const rows = pkg.skillById.get(Number(skillId)) || [];
  if (!rows.length) return { ok: false, reason: '找不到技能 ' + skillId, unknownOpcodes: [], blockCount: 0, variantCount: 0 };
  const head = rows[0];
  const conv = opts && opts.conventions ? opts.conventions : null;
  const unknown = [];

  const blocksOf = (funcId) => {
    // 注意：pkg.rolesByFunc 的 key 是 Number（见 pkg.js load()）
    const key = Number(String(funcId || '').trim());
    const roles = pkg.rolesByFunc.get(key) || pkg.rolesByFunc.get(String(key)) || [];
    return roles.map(r => {
      const kind = opcodeToKind.get(r[8]);
      if (!kind) unknown.push(r[8]);
      return {
        kind: kind || r[8],
        opcode: r[8],
        params: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i, (r[20 + i] || '').trim()])),
        roleTarget: r[9] || 'SELF',
        // 空的连携率原样保留空（'0' 与空在语义上都是不吃连携，但照抄更保真）
        chainRate: (r[30] === undefined || r[30] === '') ? '' : Number(r[30]),
        // 原技能的演出动画（可选带过去：界面上有「保留原演出」开关）
        art2d: r[1] || '',
        art3d: r[3] || '',
      };
    });
  };

  const defaultBlocks = blocksOf(head[49] || head[0]);
  const variants = [];
  for (const v of rows.slice(1)) {
    if (!v[36] && !v[42]) continue;                       // 没有条件的「额外行」不算变体
    const c1 = v.slice(37, 42), c2 = v.slice(43, 48);
    variants.push({
      skillTarget: v[19] || head[19],
      condition: v[36] || '',
      conditionValues: conditionValuesFromCells(v[36], c1),
      conditionValuesRaw: c1,
      condition2: v[42] || '',
      conditionValues2: conditionValuesFromCells(v[42], c2),
      conditionValues2Raw: c2,
      priority: v[48] === '' ? undefined : Number(v[48]),
      blocks: blocksOf(v[49] || v[0]),
    });
  }

  if (unknown.length) {
    const uniq = [...new Set(unknown)];
    return {
      ok: false,
      reason: '这个技能里有工具还不支持的效果：' + uniq.join('、') +
        '。改这种技能请用「沿用克隆源」（技能原样不动），不要用导入效果块。',
      unknownOpcodes: uniq, blockCount: defaultBlocks.length, variantCount: variants.length,
    };
  }

  const skill = {
    name: head[1] || '',
    subName: head[2] || '',
    kind: head[10] || 'SORCERY',
    element: head[11] || 'FIRE',
    job: head[12] || 'MERCENARY',
    damageKind: head[13] || 'MAGIC',
    cost: Number(head[14]) || 0,
    target: head[19] || 'ENEMY_ONE',
    // ★ 原说明原样带过来（里面是 {N} 占位符，客户端会按新数值自己算），
    //   这样"只改数值"时游戏里显示的说明跟官方一模一样
    description: head[3] || '',
    blocks: defaultBlocks,
    variants,
  };
  return {
    ok: true, skill, unknownOpcodes: [], blockCount: defaultBlocks.length, variantCount: variants.length,
    source: { skillId: Number(skillId), name: head[1] || '', description: head[3] || '', cost: Number(head[14]) || 0 },
  };
}

/** 一张卡的「主要技能」：优先 覚醒技，没有就用通常技。 */
function pickCardSkill(pkg, cardId, opts) {
  const row = pkg.cardById.get(Number(cardId));
  if (!row) return null;
  const arthur = Number(row[27]) || 0;
  const normal = Number(row[26]) || 0;
  const id = arthur || normal;
  if (!id) return null;
  return Object.assign({ cardId: Number(cardId), isArthur: !!arthur, skillId: id }, decompileSkill(pkg, id, opts));
}

module.exports = { decompileSkill, pickCardSkill, conditionValuesFromCells, opcodeToKind };
