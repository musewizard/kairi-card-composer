'use strict';
/*
 * compose.js -- the pure, side-effect-free half of the tool.
 *
 * Given a package + a draft, work out everything the card WILL be: the merged shell
 * attributes, the compiled 覚醒技 / 通常技 (rows + Chinese description), and the
 * numbers the server will derive. The web UI calls this for live preview; the injector
 * calls inject() which does the actual writing.
 */
const { Package, CARD_COL, RARITY_NAME, RARITY_CODE, RARITY_CN: RARITY_CN_FULL, ELEMENTS_ALL, ELEMENT_CN, elementCn, elementMask: elementMaskOf } = require('./pkg');
const engine = require('./engine');
const conventions = require('./conventions');
const values = require('./values');
const T = require('./translate');
const { byId, EFFECTS, ATTR_CN, TARGET_CN } = require('./effects');

const JOB_CN = { 1: '佣兵', 2: '富豪', 3: '盗贼', 4: '歌姬', 0: '通用' };
const JOB_NAME = { 1: 'MERCENARY', 2: 'MILLIONAIRE', 3: 'THIEF', 4: 'SINGER' };
const RARITY_CN = RARITY_CODE;   // rank -> 官方缩写（N/HN/R/SR/UR/MR/EXR/LEGEND）
/** 稀有度下拉用的中文标签：'7 EXR EX稀有'。 */
function rarityLabel(rank) {
  const r = Number(rank);
  return r + ' ' + (RARITY_CODE[r] || '?') + ' ' + (RARITY_CN_FULL[r] || '');
}
/** 属性下拉用的中文标签：'火' / '火冰（双属性）'。 */
function elementLabel(el) {
  return elementCn(el) + (String(el).includes('_') ? '（双属性）' : '');
}

/** The list of cards that can be used as a clone source (compact, for the picker). */
function listCards(pkg) {
  const out = [];
  for (const [id, row] of pkg.cardById) {
    const tpl = pkg.tplById.get(id);
    const rank = pkg.rankCards[String(id)];
    out.push({
      id,
      crown: T.cardName(row[CARD_COL.crown] || ''),
      name: T.cardName(row[CARD_COL.name] || ''),
      rarity: tpl ? (RARITY_CN[tpl.rarity_rank] || tpl.rarity_rank) : '',
      job: rank ? (JOB_CN[rank.arthur_type] || rank.arthur_type) : '',
      jobCode: rank ? rank.arthur_type : null,
      cost: row[CARD_COL.cost] || '',
      normalSkill: Number(row[CARD_COL.normalSkill]) || 0,
      arthurSkill: Number(row[CARD_COL.arthurSkill]) || 0,
      pictId: row[CARD_COL.pictId] || '',
      hasTemplate: !!tpl,
    });
  }
  out.sort((a, b) => a.id - b.id);
  return out;
}

/**
 * 「整套卡面都能改」的 PictID 候选：附带「现在有哪张卡在用它」。
 * 换 PictID = 把那张卡的图换掉，所以必须先让用户看见会动到谁（别闷声改别人的卡）。
 */
function pictCandidates(pkg, base, liveSet) {
  const use = new Map();
  for (const [cid, row] of pkg.cardById) {
    const p = String(row[CARD_COL.pictId] || '').trim();
    if (!p) continue;
    if (!use.has(p)) use.set(p, []);
    use.get(p).push(cid);
  }
  const out = [];
  for (const b of (base || [])) {
    const ids = use.get(String(b.pictId)) || [];
    const named = ids.slice(0, 4).map((id) => {
      const row = pkg.cardById.get(id);
      return { id, name: T.cardName(((row && row[CARD_COL.crown]) || '') + ((row && row[CARD_COL.name]) || '')) };
    });
    const liveIds = liveSet ? ids.filter((id) => liveSet.has(id)) : [];
    out.push({
      pictId: b.pictId,
      chr51: b.chr51 || null,
      userCount: ids.length,
      cards: named,
      // 用这个 PictID 的卡里有几张是 Live2D 动态卡面（静态图会被动态模型盖住）
      live2dCount: liveIds.length,
      live2dCards: liveIds.slice(0, 4).map((id) => {
        const row = pkg.cardById.get(id);
        return { id, name: T.cardName(((row && row[CARD_COL.crown]) || '') + ((row && row[CARD_COL.name]) || '')) };
      }),
    });
  }
  // 优先「没有 Live2D 的卡」→ 再按影响几张卡排序（静态图一定能看到的最好排前面）
  out.sort((a, b) => (a.live2dCount - b.live2dCount) || (a.userCount - b.userCount) || (a.pictId - b.pictId));
  return out;
}

/** Everything we can pre-fill from a clone source. */
function cloneSource(pkg, cloneId) {
  const row = pkg.cardById.get(Number(cloneId));
  if (!row) return null;
  const tpl = pkg.tplById.get(Number(cloneId)) || {};
  const rank = pkg.rankCards[String(cloneId)] || {};
  return {
    id: Number(cloneId),
    // 克隆源的名字也过一遍翻译：日服原文（感謝型 盗賊アーサー2020）会变成中文
    crown: T.cardName(row[CARD_COL.crown] || ''),
    name: T.cardName(row[CARD_COL.name] || ''),
    rawName: (row[CARD_COL.crown] || '') + (row[CARD_COL.name] || ''),
    rarityRank: tpl.rarity_rank,
    arthurType: rank.arthur_type,
    cost: Number(row[CARD_COL.cost]) || 0,
    levelMax: Number(row[CARD_COL.levelMax]) || 1,
    loveMax: Number(row[CARD_COL.loveMax]) || 0,
    fameMax: Number(row[CARD_COL.fameMax]) || 1,
    pictId: Number(row[CARD_COL.pictId]) || 0,
    voiceId: row[CARD_COL.voiceId] || '',
    serif: row[CARD_COL.serif] || '',
    premiumRarity: !!tpl.premium_rarity,
    experienceTableId: tpl.experience_table_id,
    parameterInitial: tpl.parameter_initial,
    parameterMaximum: tpl.parameter_maximum,
    parameterLoveMaximumBonus: tpl.parameter_love_maximum_bonus,
    fusionAttributes: tpl.fusion_attributes,
    skillLevelMax: Number(row[CARD_COL.skillLevelMax]) || 1,
    support: [row[CARD_COL.support0], row[CARD_COL.support1], row[CARD_COL.support2], row[CARD_COL.support3]]
      .map(v => Number(v) || 0),
    callSkill: Number(row[CARD_COL.callSkill]) || 0,
    passiveSkill: Number(row[CARD_COL.passiveSkill]) || 0,
    normalSkill: Number(row[CARD_COL.normalSkill]) || 0,
    arthurSkill: Number(row[CARD_COL.arthurSkill]) || 0,
  };
}

/** Describe one existing skill for the "clone this skill" option. */
function describeSkill(pkg, skillId) {
  const rows = pkg.skillById.get(Number(skillId)) || [];
  if (!rows.length) return null;
  const r = rows[0];
  const roles = pkg.rolesOfSkill(skillId);
  return {
    id: Number(skillId),
    // ★ 官方 CN 包里还留着日服原文（导入卡）：显示时转成汉语，避免看不懂
    name: T.cardName(r[1] || ''), subName: T.cardName(r[2] || ''),
    description: T.toChineseMarked(r[3] || ''),
    descriptionRaw: r[3] || '',
    translated: T.hasJapanese(r[1] || '') || T.hasJapanese(r[3] || ''),
    kind: r[10] || '', element: r[11] || '', job: r[12] || '', cost: Number(r[14]) || 0,
    target: r[19] || '', variants: rows.length,
    blocks: roles.map(x => ({ opcode: x[8], target: x[9], p0: (x[20] || '').trim() })),
  };
}

/** Merge a draft over its clone source, then compute the display-side numbers. */
function resolveDraft(pkg, draft) {
  const src = cloneSource(pkg, draft.clone);
  if (!src) throw new Error('克隆源卡 ' + draft.clone + ' 不存在');
  const pick = (k, dflt) => (draft[k] === undefined || draft[k] === null || draft[k] === '') ? (src[k] === undefined ? dflt : src[k]) : draft[k];
  const merged = {
    id: draft.id,
    clone: draft.clone,
    crown: pick('crown', ''),
    name: pick('name', ''),
    rarityRank: Number(pick('rarityRank', 1)),
    arthurType: Number(pick('arthurType', 1)),
    cost: Number(pick('cost', 0)),
    levelMax: Number(pick('levelMax', 1)),
    loveMax: Number(pick('loveMax', 0)),
    fameMax: Number(pick('fameMax', 1)),
    pictId: Number(pick('pictId', 0)),
    // 台词/配音要能**显式清空**（官方也有没配音的卡），所以不用 pick 的「空=沿用克隆源」规则
    voiceId: draft.voiceId !== undefined ? String(draft.voiceId) : (src.voiceId || ''),
    serif: draft.serif !== undefined ? String(draft.serif) : (src.serif || ''),
    premiumRarity: !!pick('premiumRarity', false),
    experienceTableId: Number(pick('experienceTableId', 0)),
    parameterInitial: Object.assign({}, src.parameterInitial, draft.parameterInitial || {}),
    parameterMaximum: Object.assign({}, src.parameterMaximum, draft.parameterMaximum || {}),
    parameterLoveMaximumBonus: src.parameterLoveMaximumBonus,
    element: draft.element || src.element || (draft.arthur && draft.arthur.skill && draft.arthur.skill.element) || 'FIRE',
  };
  merged.jobName = JOB_NAME[merged.arthurType] || 'MERCENARY';
  merged.jobCn = JOB_CN[merged.arthurType] || '?';
  merged.rarityCn = rarityLabel(merged.rarityRank);
  merged.elementCn = elementLabel(merged.element);
  merged.fusionAttributes = elementMaskOf(merged.element);

  // derived Lv1 numbers, by the server's formula
  const policy = pkg.master.card_progression_policy;
  const bonus = merged.premiumRarity ? policy.fame_premium : policy.fame_normal;
  merged.derivedLv1 = {};
  for (const k of ['hp', 'attack', 'magic', 'mind']) {
    merged.derivedLv1[k] = Number(merged.parameterInitial[k] || 0) + Math.trunc(Number(bonus[k]) * 1 / 100);
  }
  const table = (pkg.master.card_experience_tables || {})[String(merged.experienceTableId)];
  merged.nextLevelExperience = (Array.isArray(table) && table.length)
    ? (merged.levelMax > 1 ? Number(table[0]) : 0) : 0;

  // compile the two skill slots (preview only -- ids are allocated at inject time)
  merged.slots = {};
  for (const slotKey of ['normal', 'arthur']) {
    const slot = draft[slotKey];
    if (!slot || slot.mode === 'none') { merged.slots[slotKey] = { mode: 'none' }; continue; }
    if (slot.mode === 'clone') {
      const id = slotKey === 'arthur' ? src.arthurSkill : src.normalSkill;
      merged.slots[slotKey] = { mode: 'clone', skillId: id, info: describeSkill(pkg, id) };
      continue;
    }
    if (slot.mode === 'existing') {
      merged.slots[slotKey] = { mode: 'existing', skillId: slot.skillId, info: describeSkill(pkg, slot.skillId) };
      continue;
    }
    // custom
    if (!Array.isArray(slot.skill && slot.skill.blocks) || slot.skill.blocks.length === 0) {
      const e = new Error('「' + (slotKey === 'arthur' ? '覚醒技' : '通常技') +
        '」一个效果块都没有：至少要留一个效果块（想不用这个技能就把模式改成「不使用」）');
      e.friendly = true;
      throw e;
    }
    const skill = Object.assign({}, slot.skill, {
      job: (slot.skill && slot.skill.job) || merged.jobName,
      cost: (slot.skill && slot.skill.cost !== undefined) ? slot.skill.cost : merged.cost,
      element: (slot.skill && slot.skill.element) || merged.element,
    });
    // 预览必须和真正注入时用同一套官方写法，否则「干跑看到的说明」和写进去的不一样
    const conv = conventions.forPackage(pkg);
    const base = { skillTarget: skill.target || 'ENEMY_ONE', element: skill.element, conventions: conv };
    const compiled = engine.compileVariant(skill.blocks || [], 0, base);
    const phProblems = engine.validatePlaceholders(compiled.description, compiled.roleRows);
    // 空的条件变体（块被删光了）直接丢掉 + 记一笔，不要因为它整个预览/干跑都失败
    const skippedVariants = [];
    const variants = (skill.variants || []).filter(v => {
      const n = (v && Array.isArray(v.blocks)) ? v.blocks.length : 0;
      if (n === 0) { skippedVariants.push(v); return false; }
      return true;
    }).map(v => {
      const vc = engine.compileVariant(v.blocks, 0, { skillTarget: v.skillTarget || skill.target, element: skill.element, conventions: conv });
      return {
        skillTarget: v.skillTarget || skill.target,
        condition: v.condition, conditionValues: v.conditionValues,
        condition2: v.condition2, conditionValues2: v.conditionValues2,
        priority: v.priority,
        conditionText: v.condition ? engine.conditionText(v.condition, v.conditionValues) : '',
        blockCount: (v.blocks || []).length,
        blocks: (v.blocks || []).map(b => ({ kind: b.kind, name: (byId.get(b.kind) || {}).name || b.kind })),
      };
    });
    merged.slots[slotKey] = {
      mode: 'custom',
      skill: {
        name: skill.name, subName: skill.subName, kind: skill.kind, element: skill.element,
        job: skill.job, damageKind: skill.damageKind, cost: skill.cost, target: skill.target,
        // DisplayRole（卡面显示哪个块）由注入时按「第一个攻击块」自动决定，
        // 见 lib/conventions.js displayRoleOf()。这里只把结果报给界面看。
        displayRole: conv.displayRoleOf(compiled.roleRows),
        valueSlot: conv.col4ForDisplayRole(conv.displayRoleOf(compiled.roleRows)),
      },
      description: compiled.description,
      placeholderProblems: phProblems,
      // 被丢掉的空变体（块被删光了），界面上提示一下
      skippedVariants: skippedVariants.length,
      blocks: (skill.blocks || []).map((b, i) => {
        const eff = byId.get(b.kind) || {};
        const row = compiled.roleRows[i] || [];
        const p = Object.fromEntries(row.slice(20, 30).map((v, k) => [k, (v || '').trim()]));
        const lmax = Math.max(1, Number(merged.levelMax) || 1);
        return {
          index: i + 1,
          kind: b.kind,
          name: eff.name || b.kind,
          opcode: eff.opcode || '',
          roleTarget: row[9] || '',
          params: row.slice(20, 30).map(x => (x || '').trim()),
          chainRate: row[30], hateLimit: row[31],
          // ★ 游戏说明里显示的是**满级**数值（实测），所以这里同时给出 Lv1 与满级两个数
          valueKind: values.shapeOf(b.kind).kind,
          valueLv1: values.valueAt(b.kind, p, 1),
          valueLvMax: values.valueAt(b.kind, p, lmax),
          valueText: values.describe(b.kind, p, lmax),
          displayValue: values.valueAt(b.kind, p, lmax),
        };
      }),
      variants,
    };
  }
  return merged;
}

/**
 * 这个块当前等级下的数值。★ 现在直接走 lib/values.js（和注入器/服务端同一套公式），
 * 以前这里是一份「大概对」的手写表，跟服务端口径对不上，2026-09-23 换掉。
 */
function displayOf(effect, row, level) {
  const p = Object.fromEntries((row || []).slice(20, 30).map((v, k) => [k, (v || '').trim()]));
  const v = values.valueAt(effect && effect.id, p, level === undefined ? 1 : level);
  return v === null ? 0 : v;
}

/** 界面里显示的参数取值也要中文：ATK / INT / MAGIC / FIRE… 这些官方枚举值给人话标签。 */
const VALUE_CN = {
  FIRE: '火', ICE: '冰', WIND: '风', LIGHT: '光', DARK: '暗',
  ATK: '物理攻击', INT: '魔法攻击', MND: '精神', MAX_HP: '最大生命', HP: '当前生命',
  DEF: '物理防御', MDEF: '魔法防御', MAGIC: '魔法', PHYSICS: '物理',
  NULL: '无', NONE: '无',
};
function valueCn(v) {
  const s = String(v);
  if (!s) return '';
  if (Object.prototype.hasOwnProperty.call(VALUE_CN, s)) return VALUE_CN[s];
  if (s.includes('_') && s.split('_').every(p => ELEMENT_CN[p])) return elementCn(s);   // FIRE_ICE -> 火冰
  return '';
}

/** The effect palette the UI renders, with real observed values for each slot. */
function palette(pkg) {
  // collect real values per opcode+slot from the live tables
  const observed = new Map();
  for (const [, rows] of pkg.rolesByFunc) {
    for (const r of rows) {
      const op = r[8];
      if (!observed.has(op)) observed.set(op, Array.from({ length: 10 }, () => new Map()));
      const per = observed.get(op);
      for (let i = 0; i < 10; i++) {
        const v = (r[20 + i] || '').trim();
        if (v === '') continue;
        per[i].set(v, (per[i].get(v) || 0) + 1);
      }
    }
  }
  const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([v, c]) => ({ value: v, count: c, cn: valueCn(v) }));
  return EFFECTS.map(e => ({
    id: e.id, opcode: e.opcode, name: e.name, note: e.note || '',
    side: e.side, family: e.family,
    allowedTargets: e.allowedTargets.map(t => ({ value: t, label: TARGET_CN[t] || t })),
    roleTargets: e.roleTargets,
    params: Object.fromEntries(Object.entries(e.params).map(([i, s]) => [i, Object.assign({}, s,
      i in e.params && observed.has(e.opcode) ? { observed: top(observed.get(e.opcode)[Number(i)], 24) } : {})])),
    chainRateDefault: e.chainRateDefault,
    displayParam: engine.DISPLAY_PARAM[e.id],
  }));
}

/** Conditions the server's startup gate allows, with metadata for the UI. */
function conditions() {
  const branch = ['', 'NONE', 'DECK_COMBO_COUNT', 'TARGET_ATTR', 'TARGET_DEBUFF', 'RANDOM',
    'SELF_OTHER_PLAY_ATTR', 'SELF_OTHER_PLAY_SKILL_KIND', 'SELF_OTHER_PLAY_RARITY', 'SELF_HP_PER',
    'TURN', 'FRIEND_PLAY_NUM', 'FRIEND_PLAY_MOST_LOW_COST', 'USER_SIDE_DEBUFF', 'ENEMY_SIDE_DEBUFF',
    'FRIEND_PLAY_TAG', 'SELF_MAIN_DECK_ATTR', 'SELF_MAIN_DECK_SKILL_KIND', 'SELF_BUFF', 'TARGET_BUFF',
    'FRIEND_HP_PER', 'SELF_BLESS'];
  return branch.map(code => ({
    code,
    label: code === '' ? '（无条件 / 默认变体）' : (code === 'NONE' ? '无条件(NONE)' : (engine.CONDITION_META[code] ? engine.CONDITION_META[code].label : code)),
    meta: engine.CONDITION_META[code] || null,
    exampleText: code && code !== 'NONE' ? engine.conditionText(code, code === 'DECK_COMBO_COUNT' ? { min: 3, max: 0 } : { min: 0, max: 50 }) : '',
  }));
}

/** 界面用的「属性」「稀有度」「职业」下拉数据 —— 全部带中文标签，界面里不再出现裸英文。 */
function choices() {
  return {
    elements: ELEMENTS_ALL.map(el => ({
      value: el,
      cn: elementCn(el),
      label: elementLabel(el),
      mask: elementMaskOf(el),
      dual: el.includes('_'),
      example: `技能属性写 ${el}，卡掩码 ${elementMaskOf(el)}`,
    })),
    rarities: [1, 2, 3, 4, 5, 6, 7, 8].map(r => ({
      rank: r, code: RARITY_CODE[r], cn: RARITY_CN_FULL[r],
      name: RARITY_NAME[r], label: rarityLabel(r),
    })),
    jobs: [1, 2, 3, 4, 0].map(code => ({ code, label: JOB_CN[code] + (code ? '' : '(0)'), name: JOB_NAME[code] || '' })),
    kinds: [
      { value: 'SORCERY', label: '魔法攻击' }, { value: 'ATTACK', label: '物理攻击' },
      { value: 'SUPPORT', label: '支援' }, { value: 'DEFENSE', label: '防御' },
      { value: 'RECOVERY', label: '治疗' }, { value: 'JAMMING', label: '干扰' },
    ],
    damageKinds: [{ value: 'MAGIC', label: '魔法' }, { value: 'PHYSICS', label: '物理' }],
    targets: Object.entries(TARGET_CN).map(([value, label]) => ({ value, label })),
    // 角色块用的目标码 → 中文（界面上原来直接显示 SELECT / ENEMY_ALL）
    roleTargets: { SELF: '自身', FRIEND_ALL: '己方全体', SELECT: '敌方单体', ENEMY_ALL: '敌方全体' },
    elementCn: ELEMENT_CN,
  };
}

module.exports = {
  listCards, cloneSource, describeSkill, resolveDraft, palette, conditions, displayOf, choices,
  rarityLabel, elementLabel, JOB_CN, RARITY_CN, pictCandidates,
};
