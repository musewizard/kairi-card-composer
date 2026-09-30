'use strict';
/*
 * engine.js -- compile a composed effect into real table rows.
 *
 * Two things this file must get right, both learned the hard way:
 *
 * 1. {N} PLACEHOLDER NUMBERING.  A description references parameters by a number
 *    that spans the WHOLE role-block list: block 1 contributes 1..10, block 2
 *    contributes 11..20, and so on (role=(N-1)/10+1, prm=(N-1)%10+1).  Each effect's
 *    desc() therefore emits LOCAL 1..10 numbers and this file rebases them.
 *
 * 2. THE ATTRIBUTE MASK.  combat_catalog.go:1250 hard-codes HasTargetAttributes=true
 *    and battle_engine_role_targets.go:6-26 rejects any target whose element bit is
 *    not set.  An all-zero mask (i.e. blank cells) silently drops the whole block.
 *    Every official player role row uses 111111111, so we always emit that.
 */
const { byId, artFor } = require('./effects');

const HATE_LIMIT_DEFAULT = '1000000';

/**
 * Which parameter of each effect is "the number the player sees" -- used to turn the
 * effect's {@v} marker into a real {N} placeholder. Grounded in the official data:
 * an attack's display value is p0 + p1 x level / 1000 (so p0), a fixed buff's is the
 * p3 + p4 x level pair (so p3), a self-param buff's is the percentage at p5, and a
 * draw's is simply how many cards.
 */
const DISPLAY_PARAM = {
  // ★ 官方实测：说明里的 {N} 有 18610/20918 指向每块的**第 1 个**参数（p0）——
  //   客户端把效果的数值挂在那儿。下面这些是「没有统计数据时的兜底」，
  //   正常的注入路径会用 lib/conventions.js 从当前包统计出来的众数。
  attack: 0, heal: 0,
  atkUp: 0, defUp: 0, atkDown: 0, defDown: 0, paramLimitBreak: 0,
  atkUpPct: 1, defUpPct: 1, atkDownPct: 1,
  draw: 0, drawPenalty: 0,
  critUp: 0, attrDefUp: 0, attrDefDown: 0,
  cover: 0, burn: 0, piercing: 0, drain: 0, damageUp: 0,
  buffRelease: 0, debuffRelease: 0, enchant: 0, tranceUp: 0,
};

/**
 * Pick the separator that goes between two effect fragments in the description.
 *
 * Grounded in the official data (both conventions exist, 1322 skills use <br> and 543
 * use ｜): when the FIRST block of the card is a damaging one (ATTACK_AA) the extra
 * effects are joined with <br>; when the first block is a non-damaging one (a buff, or
 * the draw itself) they are joined with ｜. e.g.
 *   11100812 [ATTACK_AA, DEAL_BONUS]      敌单体/物理/{1}点火属性伤害<br>提升连携威力<br>抽卡+1
 *   11400142 [ATK_UP_FIXED, DEAL_BONUS]   自身/1回合/提升<br>{1}点魔法伤害｜抽卡+1
 * This only affects the descriptive text, never the effect itself.
 */
function defaultSeparator(firstOpcode) {
  return firstOpcode === 'ATTACK_AA' ? '<br>' : '｜';
}

/** Turn a spec's params object into the 10-element Parameters array. */
function buildParams(effect, spec) {
  const out = new Array(10).fill('');
  for (let i = 0; i < 10; i++) {
    const schema = effect.params[i];
    if (!schema) { out[i] = ''; continue; }
    if (schema.kind === 'fixed') { out[i] = schema.value; continue; }
    if (schema.kind === 'blank') { out[i] = ''; continue; }
    const supplied = spec.params ? spec.params[i] : undefined;
    const v = (supplied === undefined || supplied === null || supplied === '') ? schema.default : supplied;
    out[i] = (v === undefined || v === null) ? '' : String(v);
  }
  // ★ 官方约定：伤害块的 Parameters[7]（第 28 列）就是技能属性，双属性写完整串
  //   （实测 1055 处一致 / 官方区间只有 2 处例外）。伤害块没填就自动跟卡属性走。
  if (effect.id === 'attack' && out[7] === '' && spec.__element) out[7] = String(spec.__element);
  return out;
}

/** Rebase local {1..10} placeholders onto the block's global numbering. */
function rebase(text, blockIndex) {
  return String(text).replace(/\{(\d+)\}/g, (whole, d) => {
    const local = Number(d);
    if (local < 1 || local > 10) return whole;
    return '{' + (blockIndex * 10 + local) + '}';
  });
}

/**
 * Replace {@v} with the global placeholder of THIS effect's display parameter.
 *
 * The client renders {N} as "the value produced by parameter N", numbered across the
 * whole block list (block 1 -> 1..10, block 2 -> 11..20, ...). Each effect declares
 * which of its own parameters is the one worth showing (attack: p0+p1 is the power,
 * so p0; a fixed buff: p3, the base amount; a draw: p0), and we translate that into
 * the global number here.
 */
function rebaseDisplay(text, blockIndex, displayParam) {
  return String(text).replace(/\{@v\}/g, '{' + (blockIndex * 10 + (displayParam | 0) + 1) + '}');
}

/**
 * Build one role row.
 * Row width is 33 (combat_catalog.go:1238 requires >= 32).
 */
function buildRoleRow(effect, spec, functionId, ctx) {
  const row = new Array(33).fill('');
  const element = ctx.element || 'FIRE';
  const params = buildParams(effect, Object.assign({}, spec, { __element: element }));
  // 伤害种类写在 Parameters[8]；它决定用 slash 还是 magic 那一族的演出名
  // （双属性：官方用 pl_slash_multi_c / pl_magic_multi_c，**没有 _a 版本**）。
  const art = artFor(element, effect.id === 'attack' ? (params[8] || 'MAGIC') : null);
  // 官方写法的展示列（从当前包统计出来的众数，见 lib/conventions.js）
  const pres = (ctx.conventions && ctx.conventions.role(effect.opcode)) || null;
  row[0] = String(functionId);
  // 演出动画：默认按属性/物理魔法选；从已有技能导入的块可以带着原技能的演出（spec.art2d/art3d）
  row[1] = spec.art2d || art.script2d;
  row[3] = spec.art3d || art.playlist;
  // ★ 第 4 列 = 打击特效（官方 ef_Btl_3D_*），第 5 列 = HitPosition（官方 'TARGET'/'ROOT'），
  //   第 7 列官方是空的（或电影名）。早期版本把 'TARGET' 写进了第 7 列 —— 那是错的。
  row[4] = (pres && pres.hitEffect) || '';
  row[5] = (pres && pres.hitPosition) || '';
  row[7] = (pres && pres.col7) || '';
  row[8] = effect.opcode;
  row[9] = spec.roleTarget || (effect.roleTargets[spec.skillTarget] || 'SELF');
  row[10] = spec.excludeSelf ? '1' : '';
  for (let i = 11; i <= 19; i++) row[i] = '1';          // ★ the mask -- never blank
  for (let i = 0; i < 10; i++) row[20 + i] = params[i];
  row[30] = (spec.chainRate === undefined || spec.chainRate === null)
    ? ((pres && pres.chainRate) !== undefined && (pres && pres.chainRate) !== ''
      ? pres.chainRate : String(effect.chainRateDefault || 0))
    : String(spec.chainRate);
  // ★ 第 31 列 HateLimit：官方攻击块 10000、增益块留空。早期版本一律写 1000000（拉满仇恨）。
  row[31] = (spec.hateLimit !== undefined && spec.hateLimit !== null)
    ? String(spec.hateLimit)
    : ((pres && pres.hateLimit) || '');
  return row;
}

/**
 * Compile the effect list of ONE variant into { roleRows, description }.
 * skillTarget drives the outer target of the skill row and the description prefix.
 */
function compileVariant(effectSpecs, functionId, ctx) {
  // ★ 空技能：以前这里会 `effectSpecs[0].kind` 直接炸成
  //   "Cannot read properties of undefined (reading 'kind')"（2026-09-23 用户实测踩到：
  //   条件变体里把效果块删光了 / 技能一个块都没有）。现在给人话错误。
  if (!Array.isArray(effectSpecs) || effectSpecs.length === 0) {
    const e = new Error('这个技能一个效果块都没有：至少要留一个效果块（条件变体也是）');
    e.friendly = true;
    throw e;
  }
  const roleRows = [];
  const fragments = [];
  effectSpecs.forEach((spec, index) => {
    const effect = byId.get(spec.kind);
    if (!effect) {
      const e = new Error('效果块没选效果（kind=' + JSON.stringify(spec && spec.kind) + '）—— 每个块都要选一个效果');
      e.friendly = true;
      throw e;
    }
    const withTarget = Object.assign({}, spec, { skillTarget: ctx.skillTarget });
    roleRows.push(buildRoleRow(effect, withTarget, functionId, ctx));
    const frag = effect.desc(Object.assign({}, withTarget, {
      params: buildParams(effect, withTarget),
      skillTarget: ctx.skillTarget,
      roleTarget: spec.roleTarget || (effect.roleTargets[ctx.skillTarget] || 'SELF'),
    }));
    // {@v} -> 这个效果「在说明里该引用块内第几个参数」。
    // ★ 实测官方 20918 个占位符里 18610 个引用 p0：客户端把效果的数值挂在每块的
    //   第一个参数上，引用别的列会显示成原始数字（例如 ATK_UP_FIXED 的 p3=3246000
    //   就是 7 位数，在卡面/说明里会变成一堆乱码数字）。所以优先用「从当前包统计出来的
    //   官方众数」，没有统计就退回 DISPLAY_PARAM。
    const displayParam = ctx.conventions
      ? ctx.conventions.displayParamOf(effect.opcode)
      : ((effect.displayParam !== undefined) ? effect.displayParam : (DISPLAY_PARAM[effect.id] || 0));
    const withDisplay = rebaseDisplay(frag, index, displayParam);
    fragments.push(rebase(withDisplay, index));
  });
  const firstOpcode = (() => {
    const first = byId.get(effectSpecs[0].kind);
    return first ? first.opcode : '';
  })();
  const sep = ctx.separator || defaultSeparator(firstOpcode);
  return { roleRows, description: fragments.join(sep) };
}

// ------------------------------------------------------------------ conditions
/** Range conditions take (min,max) where "0" means open-ended, matching branchConditionSatisfied(). */
const RANGE2 = new Set(['DECK_COMBO_COUNT', 'TURN', 'SELF_HP_PER', 'FRIEND_HP_PER', 'FRIEND_PLAY_NUM',
  'FRIEND_PLAY_COST_TOTAL', 'SELF_PLAY_COST_TOTAL', 'SELF_OTHER_PLAY_NUM']);
/** Conditions whose parameters are a single keyword (element / kind / rarity / buff code). */
const KEYWORD = new Set(['TARGET_ATTR', 'ENEMY_SIDE_DEBUFF', 'USER_SIDE_DEBUFF', 'TARGET_DEBUFF',
  'TARGET_BUFF', 'SELF_BUFF', 'SELF_OTHER_PLAY_ATTR', 'SELF_OTHER_PLAY_SKILL_KIND', 'SELF_OTHER_PLAY_RARITY',
  'SELF_MAIN_DECK_ATTR', 'SELF_MAIN_DECK_SKILL_KIND', 'SELF_BLESS', 'RANDOM', 'SELF_PLAY_MOST_LOW_COST']);

const CONDITION_META = {
  DECK_COMBO_COUNT: { label: '连携数达到', hint: '参数1=最低连携数，参数2=0 表示不设上限', params: ['min', 'max'], unit: '连携' },
  TURN: { label: '回合数', hint: '参数1..参数2 范围内才生效；0 表示不限', params: ['min', 'max'], unit: '回合' },
  SELF_HP_PER: { label: '自身血量百分比', hint: '参数1..参数2 范围内', params: ['min', 'max'], unit: '%' },
  FRIEND_HP_PER: { label: '任一队友血量百分比', hint: '', params: ['min', 'max'], unit: '%' },
  FRIEND_PLAY_NUM: { label: '队友出牌张数达到', hint: '', params: ['min', 'max'], unit: '张' },
  SELF_OTHER_PLAY_NUM: { label: '自己其他出牌张数达到', hint: '', params: ['min', 'max'], unit: '张' },
  SELF_PLAY_COST_TOTAL: { label: '本回合出牌总费用达到', hint: '', params: ['min', 'max'], unit: '费' },
  FRIEND_PLAY_COST_TOTAL: { label: '队友出牌总费用达到', hint: '', params: ['min', 'max'], unit: '费' },
  TARGET_ATTR: { label: '目标属性是', hint: '只对敌方目标有意义', params: ['element'], unit: '' },
  ENEMY_SIDE_DEBUFF: { label: '敌方处于某状态', hint: '如 POISON / BURN / FREEZE', params: ['status'], unit: '' },
  USER_SIDE_DEBUFF: { label: '我方处于某状态', hint: '如 CARD_SEAL / COST_BLOCK', params: ['status'], unit: '' },
  TARGET_DEBUFF: { label: '目标带有某弱化', hint: '如 POISON / WEAKNESS / FREEZE', params: ['status'], unit: '' },
  TARGET_BUFF: { label: '目标带有某强化', hint: '如 ATTACK_BARRIER / ENCHANT', params: ['status'], unit: '' },
  SELF_BUFF: { label: '自身带有某强化', hint: '最多见的是 ENCHANT', params: ['status'], unit: '' },
  SELF_OTHER_PLAY_ATTR: { label: '自己本回合出过某属性牌', hint: '参数1=属性，参数2=张数', params: ['element', 'count'], unit: '张' },
  SELF_OTHER_PLAY_SKILL_KIND: { label: '自己本回合出过某类型牌', hint: '参数1=类型，参数2=张数', params: ['kind', 'count'], unit: '张' },
  SELF_OTHER_PLAY_RARITY: { label: '自己本回合出过某稀有度牌', hint: '参数1=稀有度，参数2=张数', params: ['rarity', 'count'], unit: '张' },
  SELF_MAIN_DECK_ATTR: { label: '主卡组某属性张数', hint: '参数1=属性，参数3=张数', params: ['element', 'middot', 'count'], unit: '张' },
  SELF_MAIN_DECK_SKILL_KIND: { label: '主卡组某类型张数', hint: '参数1=类型，参数3=张数', params: ['kind', 'middot', 'count'], unit: '张' },
  SELF_BLESS: { label: '祝福对象张数', hint: '参数1=属性或 NULL，参数2=张数', params: ['element', 'count'], unit: '张' },
  RANDOM: { label: '随机概率(%)', hint: '官方有 50/18/15 等取值', params: ['percent'], unit: '%' },
  SELF_PLAY_MOST_LOW_COST: { label: '场上最低费用牌张数', hint: '', params: ['min', 'max'], unit: '张' },
};

/** Turn condition params into the 5 CSV cells. */
function conditionCells(code, values) {
  const cells = ['', '', '', '', ''];
  if (!code) return cells;
  const meta = CONDITION_META[code];
  if (!meta) throw new Error('no metadata for condition ' + code);
  const v = values || {};
  if (meta.params[0] === 'min') {
    cells[0] = v.min === undefined || v.min === null || v.min === '' ? '0' : String(v.min);
    cells[1] = v.max === undefined || v.max === null || v.max === '' ? '0' : String(v.max);
  } else if (meta.params[0] === 'percent') {
    cells[0] = String(v.percent === undefined ? 50 : v.percent);
  } else if (meta.params[0] === 'element' && meta.params.length === 1) {
    cells[0] = String(v.element || 'FIRE');
  } else if (meta.params[0] === 'status') {
    cells[0] = String(v.status || 'POISON');
  } else if (meta.params[1] === 'count') {
    cells[0] = String(v.element || v.kind || v.rarity || 'FIRE');
    cells[1] = String(v.count === undefined ? 2 : v.count);
  } else if (meta.params[1] === 'middot') {
    cells[0] = String(v.element || v.kind || 'FIRE');
    cells[1] = 'NULL';
    cells[2] = String(v.count === undefined ? 2 : v.count);
  } else {
    cells[0] = String(v.min === undefined ? 0 : v.min);
    cells[1] = String(v.max === undefined ? 0 : v.max);
  }
  return cells;
}

/** Human-readable 【...】 prefix for a condition, matching official bracket wording. */
function conditionText(code, values) {
  const v = values || {};
  switch (code) {
    case 'DECK_COMBO_COUNT': {
      const min = Number(v.min || 0), max = Number(v.max || 0);
      if (max > 0 && max !== min) return '【' + min + '-' + max + '连携】';
      return '【' + min + '连携以上】';
    }
    case 'TURN': {
      const min = Number(v.min || 0), max = Number(v.max || 0);
      if (min > 0 && max > 0) return '【' + min + '-' + max + '回合】';
      if (min > 0) return '【' + min + '回合以上】';
      if (max > 0) return '【' + max + '回合以下】';
      return '【任意回合】';
    }
    case 'SELF_HP_PER': {
      const min = Number(v.min || 0), max = Number(v.max || 0);
      if (min > 0 && max > 0) return '【自身/血量' + min + '%~' + max + '%】';
      if (min > 0) return '【自身/血量' + min + '%以上】';
      if (max > 0) return '【自身/血量' + max + '%以下】';
      return '【自身血量条件】';
    }
    case 'FRIEND_HP_PER': return '【队友/血量' + (v.max || v.min || 50) + '%以下】';
    case 'TARGET_ATTR': return '【敌' + (v.element || '') + '属性】';
    case 'ENEMY_SIDE_DEBUFF': return '【敌方处于' + (v.status || '') + '状态】';
    case 'USER_SIDE_DEBUFF': return '【我方处于' + (v.status || '') + '状态】';
    case 'TARGET_DEBUFF': return '【目标带有' + (v.status || '') + '】';
    case 'TARGET_BUFF': return '【目标带有' + (v.status || '') + '】';
    case 'SELF_BUFF': return '【自身带有' + (v.status || '') + '】';
    case 'SELF_OTHER_PLAY_ATTR': return '【自身/' + (v.element || '') + '/' + (v.count || 1) + '枚以上】';
    case 'SELF_OTHER_PLAY_SKILL_KIND': return '【自身/' + (v.kind || '') + '/' + (v.count || 1) + '枚以上】';
    case 'SELF_OTHER_PLAY_RARITY': return '【自身/' + (v.rarity || '') + '/' + (v.count || 1) + '枚以上】';
    case 'SELF_MAIN_DECK_ATTR': return '【自身/主卡组/' + (v.element || '') + '/' + (v.count || 2) + '枚以上】';
    case 'SELF_MAIN_DECK_SKILL_KIND': return '【自身/主卡组/' + (v.kind || '') + '/' + (v.count || 2) + '枚以上】';
    case 'SELF_BLESS': return '【祝福对象/' + (v.count || 2) + '枚以上】';
    case 'RANDOM': return '【' + (v.percent || 50) + '%概率】';
    case 'SELF_PLAY_MOST_LOW_COST': return '【自身/最低费用' + (v.min || 1) + '枚以上】';
    case 'FRIEND_PLAY_NUM': return '【己方/' + (v.min || 1) + '枚以上】';
    case 'SELF_OTHER_PLAY_NUM': return '【自身/' + (v.min || 1) + '枚以上】';
    case 'SELF_PLAY_COST_TOTAL': return '【自身/合计费用' + (v.min || 1) + '以上】';
    case 'FRIEND_PLAY_COST_TOTAL': return '【己方/合计费用' + (v.min || 1) + '以上】';
    default: return '【' + code + '】';
  }
}

// ------------------------------------------------------------------ weakening
/**
 * Produce a weaker 通常技 from an 覚醒技 spec.
 *
 * ★ 2026-09-25 用户定的规则：**不管覚醒技有几段效果，通常技默认只取第 1 段**，
 *   按系数把它的数值缩小。理由：通常技是「其他三个职业看到的普通技能」，
 *   官方那些通常技基本就是一条简单效果；把覚醒技所有段都缩一遍会有"小号覚醒技"的感觉，
 *   不像普通技。
 *   · weaken(specs, scale)    → 只取 specs[0]（弱化后返回 1 条）★ 默认行为
 *   · weakenAll(specs, scale) → 老行为：每一段都缩（保留给需要"整段弱化"的场合/测试）
 * 弱化的参数：p0/p1（伤害/回复的基数与升级值）、p3/p4（固定值增益）、p0（抽牌）等。
 */
const VALUE_PARAMS = {
  attack: [0, 1], heal: [0, 1], atkUp: [3, 4], defUp: [3, 4], atkDown: [3, 4], defDown: [3, 4],
  atkUpPct: [3], defUpPct: [3], atkDownPct: [3],
  paramLimitBreak: [3, 4], enchant: [1, 4], burn: [3, 4],
};
/** 把一段效果块的数值按 scale 缩小（不改原对象） */
function weakenOne(spec, s) {
  const idx = VALUE_PARAMS[spec.kind];
  if (!idx || !idx.length) return JSON.parse(JSON.stringify(spec));
  const params = Object.assign({}, spec.params);
  for (const i of idx) {
    const raw = params[i];
    if (raw === undefined || raw === null || raw === '') continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    params[i] = String(Math.max(0, Math.round(n * s)));
  }
  return Object.assign({}, spec, { params });
}
/** ★ 通常技默认规则：只拿第 1 段效果块并弱化（几段都只取第 1 段） */
function weaken(effectSpecs, scale) {
  const s = scale === undefined ? 0.6 : scale;
  const list = Array.isArray(effectSpecs) ? effectSpecs : [];
  if (!list.length) return [];
  return [weakenOne(list[0], s)];
}
/** 老行为：每一段都弱化（通常技默认不用它，见上面的说明） */
function weakenAll(effectSpecs, scale) {
  const s = scale === undefined ? 0.6 : scale;
  const list = Array.isArray(effectSpecs) ? effectSpecs : [];
  return list.map((spec) => weakenOne(spec, s));
}

/**
 * Validate a compiled description: every {N} must resolve to a real block + parameter,
 * and that parameter must not be blank (a blank one renders as an empty value in game).
 * This is the check that would have caught the {N} mistake immediately.
 */
function validatePlaceholders(description, roleRows) {
  const problems = [];
  const seen = new Set();
  for (const m of String(description).matchAll(/\{(\d+)\}/g)) {
    const n = Number(m[1]);
    if (seen.has(n)) continue;
    seen.add(n);
    const block = Math.floor((n - 1) / 10);
    const prm = (n - 1) % 10;
    if (block >= roleRows.length) {
      problems.push('{' + n + '} 指向第 ' + (block + 1) + ' 个角色块，但只有 ' + roleRows.length + ' 个');
      continue;
    }
    const v = roleRows[block][20 + prm];
    if (v === undefined || String(v).trim() === '') {
      problems.push('{' + n + '} 指向 ' + roleRows[block][8] + ' 的参数' + (prm + 1) + '，但那里是空的');
    }
  }
  return problems;
}

module.exports = {
  buildParams, buildRoleRow, compileVariant, rebase, rebaseDisplay,
  conditionCells, conditionText, CONDITION_META, RANGE2, KEYWORD,
  weaken, weakenAll, weakenOne, VALUE_PARAMS, HATE_LIMIT_DEFAULT, DISPLAY_PARAM, validatePlaceholders,
};
