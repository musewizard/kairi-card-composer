'use strict';
/*
 * injector.js -- write one composed card into the package (the 8 write points).
 *
 * Ported from tools/kairimod/Injector.cs (verified implementation) with two additions
 * the composer needs:
 *   - every variant may override its OWN skill target (so 【3连携以上】 can turn a
 *     单体 attack into an 全体 one), whereas KairiMod shared one target across all rows
 *   - a card can be rewritten in place (-InPlace), needed while iterating
 *
 * The critical safety gate is verifyTemplateDerived(): the server recomputes these
 * fields at startup (card_master.go:182 normalizeCard + reflect.DeepEqual) and refuses
 * to boot if they differ, so we recompute them independently BEFORE writing and throw
 * rather than emit a package that cannot start.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { Package, CsvFile, parseCsvLine, csvLine, CARD_COL, RARITY_NAME, RARITY_CN, elementMask, maskElement, elementCn,
        ELEMENT_BIT, ELEMENT_ORDER } = require('./pkg');
const JOB_CN = { 0: '通用', 1: '佣兵', 2: '富豪', 3: '盗贼', 4: '歌姬' };
const engine = require('./engine');
const conventions = require('./conventions');
const getConventions = conventions.forPackage;
const { byId } = require('./effects');

const TOOLS = require('./tools').toolsRoot();
const BUNDLE_TOOL = path.join(TOOLS, 'bundle-tool', 'bin', 'Release', 'net8.0', 'BundleTool.exe');
const RESEAL = path.join(TOOLS, 'reseal', 'bin', 'Release', 'net8.0', 'Reseal.exe');

const SKILL_COLS = 51;
const ROLE_COLS = 33;

function sha256(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }
function intOf(v, dflt) { const n = Number(v); return Number.isFinite(n) ? n : (dflt === undefined ? 0 : dflt); }

/**
 * Find the `{ ... }` span of the object that contains `needle`, searching from `from`.
 * Used to splice one template out of the 15 MB master without re-serializing the rest.
 */
function spanOfObjectContaining(text, from, needle) {
  const at = text.indexOf(needle, from);
  if (at < 0) return null;
  // walk backwards to the '{' that opens this object (depth-aware, string-aware)
  let i = at, depth = 0, inStr = false;
  for (; i >= from; i--) {
    const c = text[i];
    if (inStr) { if (c === '"' && text[i - 1] !== '\\') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '}') depth++;
    else if (c === '{') { if (depth === 0) break; depth--; }
  }
  if (i < from) return null;
  const start = i;
  depth = 0; inStr = false;
  for (let j = start; j < text.length; j++) {
    const c = text[j];
    if (inStr) { if (c === '\\') j++; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return { start, end: j }; }
  }
  return null;
}

/* ------------------------------------------------------------------ draft model
 * A CardDraft is plain JSON:
 * {
 *   id, clone, crown, name,
 *   rarityRank, arthurType, cost, levelMax, loveMax, fameMax, pictId, voiceId,
 *   premiumRarity, experienceTableId,
 *   parameterInitial: {hp,attack,magic,mind},      // Lv1 基础值
 *   parameterMaximum: {hp,attack,magic,mind},      // 满级上限
 *   normal: { mode:'clone'|'custom'|'weaken', ... },
 *   arthur: { mode:'clone'|'custom', ... },
 *   support:[{mode}], call:{mode}, passive:{mode}
 * }
 * A custom skill is:
 * { name, subName, kind, element, job, damageKind, cost, target, displayRole,
 *   condition, conditionParameters[5],
 *   blocks: [ {kind, params{}, roleTarget?, chainRate?, hateLimit?} ],
 *   variants: [ {skillTarget?, condition, conditionValues{}, condition2?, conditionValues2?,
 *                priority, blocks:[...] } ] }
 */

/** Compile a custom skill into the CSV rows it needs (skill_player + skill_role_player). */
function compileSkill(skill, ids, ctx, log) {
  const skillRows = [];
  const roleRows = [];
  if (!skill.blocks || !skill.blocks.length) throw new Error('技能「' + (skill.name || '?') + '」没有效果块');

  // 官方写法的展示列（见 lib/conventions.js）。slot 决定 RANK：通常技 / 覚醒技。
  const conv = ctx.conventions || null;
  const slot = ids.slot || 'arthur';
  const rarity = ctx.rarityRank;
  const rank = conv && rarity !== undefined ? conv.rank(rarity, slot) : '';
  const kind = skill.kind || 'SORCERY';
  const code = conv ? conv.skillCode(kind, rank) : { col15: '', col16: '' };

  const base = {
    skillTarget: skill.target || 'ENEMY_ONE',
    element: skill.element || 'FIRE',
    conventions: conv,
  };
  // ---- default variant (must exist: all 13237 official skills have one)
  const compiled = engine.compileVariant(skill.blocks, ids.functionId, base);
  roleRows.push(...compiled.roleRows);
  // A {N} that points at a missing/blank parameter renders as an empty value in game,
  // so refuse to produce the skill at all.
  const phProblems = engine.validatePlaceholders(compiled.description, compiled.roleRows);
  if (phProblems.length) {
    throw new Error('技能「' + (skill.name || '?') + '」的说明占位符有问题：\n  - ' + phProblems.join('\n  - '));
  }
  /**
   * 官方技能行的展示列。★ 第 5 列 DisplayRole 决定「卡面上显示哪个块的数值」：
   * 服务端 battle_engine_display_power.go:36 取 roles[DisplayRole-1]，取不到就是 0，
   * 客户端显示 0000000。官方规律 = 有伤害块就指向第一个 ATTACK_AA，否则第 1 块。
   * 第 4 列 = (DisplayRole-1)*10+1。
   */
  const applySkillPres = (r, roleRows) => {
    if (!conv) return;
    const dr = skill.displayRole !== undefined ? Number(skill.displayRole) : conv.displayRoleOf(roleRows);
    r[5] = String(dr);
    r[4] = skill.valueSlot !== undefined ? String(skill.valueSlot) : conv.col4ForDisplayRole(dr);
    r[7] = conv.skillCat(kind);
    if (conv.skillPres.col9) r[9] = conv.skillPres.col9;
    r[15] = code.col15;
    r[16] = code.col16;
    r[17] = rank;
    r[18] = skill.hateRatio !== undefined ? String(skill.hateRatio) : conv.skillPres.col18;
  };

  const row = new Array(SKILL_COLS).fill('');
  row[0] = String(ids.skillId);
  row[1] = skill.name || '';
  row[2] = skill.subName || '';
  row[3] = skill.description || compiled.description;
  row[5] = String(skill.displayRole || 1);
  row[10] = skill.kind || 'SORCERY';
  row[11] = skill.element || 'FIRE';
  row[12] = skill.job || 'MERCENARY';
  row[13] = skill.damageKind || 'MAGIC';
  row[14] = String(skill.cost === undefined ? 1 : skill.cost);
  row[19] = skill.target || 'ENEMY_ONE';
  row[30] = skill.condition || '';
  for (let p = 0; p < 5; p++) row[31 + p] = (skill.conditionParameters || [])[p] || '';
  row[49] = String(ids.functionId);
  applySkillPres(row, compiled.roleRows);
  skillRows.push(row);

  // ---- extra conditional variants: same #ID, own FunctionID, own target, own 優先度
  let n = 0;
  for (const v of (skill.variants || [])) {
    if (!v.blocks || !v.blocks.length) continue;
    if (v.blocks.length > 5) throw new Error('变体角色块超过 5 个上限');
    const fid = ids.nextFunctionId();
    const vTarget = v.skillTarget || skill.target || 'ENEMY_ONE';
    const vc = engine.compileVariant(v.blocks, fid, { skillTarget: vTarget, element: skill.element || 'FIRE', conventions: conv });
    roleRows.push(...vc.roleRows);

    const vr = new Array(SKILL_COLS).fill('');
    vr[0] = String(ids.skillId);
    vr[10] = kind;
    vr[11] = skill.element || 'FIRE';
    vr[12] = skill.job || 'MERCENARY';
    vr[13] = skill.damageKind || 'MAGIC';
    vr[14] = String(skill.cost === undefined ? 1 : skill.cost);
    vr[19] = vTarget;
    vr[36] = v.condition || '';
    // ★ 从已有技能导入的变体带着**原始的 5 个条件格子**（conditionValuesRaw）：
    //   原样写回，保证条件参数一个字节都不变（界面上的 min/max 只是给人看的）
    const c1 = v.conditionValuesRaw && v.conditionValuesRaw.length
      ? v.conditionValuesRaw
      : engine.conditionCells(v.condition, v.conditionValues);
    for (let p = 0; p < 5; p++) vr[37 + p] = c1[p] || '';
    vr[42] = v.condition2 || '';
    const c2 = v.conditionValues2Raw && v.conditionValues2Raw.length
      ? v.conditionValues2Raw
      : engine.conditionCells(v.condition2, v.conditionValues2);
    for (let p = 0; p < 5; p++) vr[43 + p] = c2[p] || '';
    vr[48] = String(v.priority === undefined ? (n + 1) : v.priority);
    vr[49] = String(fid);
    applySkillPres(vr, vc.roleRows);
    skillRows.push(vr);
    n++;
    log('    变体#' + n + ' functionId=' + fid + ' target=' + vTarget +
      ' 条件=' + (v.condition || '-') + ' 優先度=' + vr[48] + ' 角色块=' + v.blocks.length);
  }
  return { skillRows, roleRows, description: skill.description || compiled.description };
}

/** Build the full card row from a draft (cloning every column we do not manage). */
function buildCardRow(pkg, draft, skillIds) {
  const clone = pkg.cardById.get(Number(draft.clone));
  if (!clone) throw new Error('card.csv 里找不到克隆源 ' + draft.clone);
  const row = clone.slice();
  const id = String(draft.id);
  row[CARD_COL.id] = id;
  row[CARD_COL.baseId] = id;
  row[CARD_COL.sameId] = id;
  row[CARD_COL.sameSupportId] = id;
  row[CARD_COL.crown] = draft.crown || '';
  row[CARD_COL.name] = draft.name || '';
  if (draft.rarityRank !== undefined) {
    // ★ 第 7 列必须是英文名（EXRARE…），不是数字 —— 早期版本写的是数字，实测是错的
    const rank = Number(draft.rarityRank);
    row[CARD_COL.rarity] = RARITY_NAME[rank] || String(draft.rarityRank);
    // 第 8 列是「高稀有度卡的颜色」：实测 premium_rarity=false 的卡全表为空，
    // premium=true 的写 RED/PURPLE/WHITE。克隆源带来的颜色只有在 premium 时才保留。
    const cloneColor = (clone[CARD_COL.rarityColor] || '').trim();
    if (draft.premiumRarity === undefined) {
      row[CARD_COL.rarityColor] = cloneColor;
    } else {
      row[CARD_COL.rarityColor] = draft.premiumRarity ? (cloneColor || 'RED') : '';
    }
  }
  if (draft.cost !== undefined) row[CARD_COL.cost] = String(draft.cost);
  if (draft.levelMax !== undefined) row[CARD_COL.levelMax] = String(draft.levelMax);
  if (draft.loveMax !== undefined) row[CARD_COL.loveMax] = String(draft.loveMax);
  if (draft.fameMax !== undefined) row[CARD_COL.fameMax] = String(draft.fameMax);
  if (draft.pictId !== undefined) row[CARD_COL.pictId] = String(draft.pictId);
  if (draft.voiceId !== undefined) row[CARD_COL.voiceId] = String(draft.voiceId);
  if (draft.serif !== undefined) row[CARD_COL.serif] = String(draft.serif);
  // parameters: accept either explicit 4 pairs or the {hp,attack,magic,mind} objects
  const pi = draft.parameterInitial, pm = draft.parameterMaximum;
  if (pi) {
    row[10] = String(pi.hp); row[13] = String(pi.attack); row[16] = String(pi.magic); row[19] = String(pi.mind);
  }
  if (pm) {
    row[11] = String(pm.hp); row[14] = String(pm.attack); row[17] = String(pm.magic); row[20] = String(pm.mind);
  }
  if (skillIds.normal !== undefined) row[CARD_COL.normalSkill] = String(skillIds.normal || '');
  if (skillIds.arthur !== undefined) row[CARD_COL.arthurSkill] = String(skillIds.arthur || '');
  for (let i = 0; i < 4; i++) {
    const s = draft.support && draft.support[i];
    if (s !== undefined) row[CARD_COL.support0 + i] = String(s || '');
  }
  if (draft.callSkill !== undefined) row[CARD_COL.callSkill] = String(draft.callSkill || '');
  if (draft.passiveSkill !== undefined) row[CARD_COL.passiveSkill] = String(draft.passiveSkill || '');
  return row;
}

/**
 * Recompute hp/attack/magic/mind the way the SERVER will (gamestate/card_progression.go:86,
 * level=1 love=0): value = parameter_initial.X + fameBonus.X * fame / 100.
 * Written as a plain formula on purpose -- do not refactor to share code with the setter,
 * otherwise the check becomes a tautology.
 */
function verifyTemplateDerived(tpl, master, log) {
  const bad = [];
  const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
  if (n(tpl.unique_id) !== 0) bad.push('unique_id 必须为 0');
  if (n(tpl.level) !== 1) bad.push('level 必须为 1（实际 ' + n(tpl.level) + '）');
  if (n(tpl.experience) !== 0) bad.push('experience 必须为 0');
  if (n(tpl.now_level_experience) !== 0) bad.push('now_level_experience 必须为 0');
  if (n(tpl.love) !== 0) bad.push('love 必须为 0');
  if (n(tpl.fame) !== 1) bad.push('fame 必须为 1（实际 ' + n(tpl.fame) + '）');
  if (!Array.isArray(tpl.skill_levels) || tpl.skill_levels.length !== 1 || n(tpl.skill_levels[0]) !== 1) {
    bad.push('skill_levels 必须恰好是 [1]');
  }
  if (!(n(tpl.rarity_rank) >= 1 && n(tpl.rarity_rank) <= 8)) bad.push('rarity_rank 必须在 1..8');
  if (!(n(tpl.add_experience) > 0)) bad.push('add_experience 必须 > 0');
  if (!(n(tpl.base_add_price) > 0)) bad.push('base_add_price 必须 > 0');
  if (n(tpl.fusion_attributes) > 31) bad.push('fusion_attributes 必须 <= 31');
  if (!tpl.name) bad.push('name 不能为空');

  const tables = master.card_experience_tables || {};
  const table = tables[String(tpl.experience_table_id)];
  if (Array.isArray(table) && table.length) {
    const expect = n(tpl.level_max) > 1 ? n(table[0]) : 0;
    if (expect !== n(tpl.next_level_experience)) {
      bad.push('next_level_experience 应为 ' + expect + '（level_max=' + n(tpl.level_max) + '），实际 ' + n(tpl.next_level_experience));
    }
  }
  const init = tpl.parameter_initial;
  if (init) {
    const fame = n(tpl.fame);
    const policy = master.card_progression_policy || {};
    const bonus = tpl.premium_rarity ? policy.fame_premium : policy.fame_normal;
    if (!bonus) bad.push('主表缺 fame_normal / fame_premium，无法验证 Lv1 数值');
    else {
      for (const k of ['hp', 'attack', 'magic', 'mind']) {
        const want = n(init[k]) + Math.trunc(n(bonus[k]) * fame / 100);
        if (want !== n(tpl[k])) {
          bad.push(k + ' 应为 初始 ' + n(init[k]) + ' + 名声加成 = ' + want + '，实际 ' + n(tpl[k]));
        }
      }
    }
  }
  if (bad.length) {
    throw new Error('注入前自检失败：生成的卡不满足服务端的派生字段要求，服务端会拒绝启动。\n  - ' + bad.join('\n  - '));
  }
  if (log) log('  派生字段自检通过（Lv1 数值 / 经验表 / 定值字段）');
}

/* ------------------------------------------------------------------ inject */
function inject(draft, opts = {}) {
  const log = opts.log || (() => {});
  const pkg = new Package(opts.packageRoot).load();
  const master = pkg.master;
  const inPlace = !!opts.inPlace;

  if (!draft.id || draft.id <= 0) throw new Error('卡牌 ID 必须大于 0');
  if (!draft.clone || draft.clone <= 0) throw new Error('必须选择一个克隆源卡');

  const existing = pkg.cardById.has(Number(draft.id));
  if (existing && !inPlace) throw new Error('卡牌 ID ' + draft.id + ' 已存在（要覆盖请用 -InPlace）');

  // ---- 台词 / 配音（card.csv 第 67 / 82 列）
  // 台词：真换行必须换成 <br>（card.csv 是按行读的，塞真换行会把整张表读坏）；长度给个上限。
  if (draft.serif !== undefined && draft.serif !== null) {
    const s = String(draft.serif);
    if (/[\r\n]/.test(s)) draft = Object.assign({}, draft, { serif: s.replace(/\r\n?|\n/g, '<br>') });
    if (String(draft.serif).length > 500) throw new Error('台词太长（' + String(draft.serif).length + ' 字），卡表里官方最长也就 200 字左右，截短一点');
  }
  // 配音：必须是数字 ID（官方表里有个别错数据：把台词文本填进了这一列）
  if (draft.voiceId !== undefined && String(draft.voiceId).trim() !== '' && !/^[0-9]+$/.test(String(draft.voiceId).trim())) {
    throw new Error('配音 ID 必须是一串数字（现在是「' + String(draft.voiceId).slice(0, 20) +
      '」）。官方表里有 16 张卡把台词误填进了配音列，别照抄；不想配就留空。');
  }

  // ---- allocate ids (avoid colliding with anything already in the tables)
  const ids = {
    skillId: 0, functionId: 0,
    nextSkill: pkg.freeSkillId(Math.max(pkg.maxCardId() + 1, pkg.maxSkillId() + 1)),
    nextFunction: pkg.freeFunctionId(Math.max(pkg.maxCardId() + 1, pkg.maxFunctionId() + 1)),
  };
  function allocSkill() { while (pkg.skillById.has(ids.nextSkill) || ids.nextSkill === ids.skillId) ids.nextSkill++; return ids.nextSkill++; }
  function allocFunction() { while (pkg.rolesByFunc.has(ids.nextFunction) || ids.nextFunction === ids.functionId) ids.nextFunction++; return ids.nextFunction++; }

  const skillRowsAll = [];
  const roleRowsAll = [];
  const slotIds = { normal: 0, arthur: 0 };

  function resolveSlot(slotKey, slot, job, cost, element) {
    if (!slot || slot.mode === 'none') return 0;
    if (slot.mode === 'clone') {
      const cloneRow = pkg.cardById.get(Number(draft.clone));
      const col = slotKey === 'arthur' ? CARD_COL.arthurSkill : CARD_COL.normalSkill;
      const id = Number(cloneRow[col]) || 0;
      log('  [' + slotKey + '] 沿用克隆源技能 ' + id);
      return id;
    }
    if (slot.mode === 'existing') {
      if (!pkg.skillById.has(Number(slot.skillId))) throw new Error('[' + slotKey + '] 指定的技能 ' + slot.skillId + ' 不存在');
      log('  [' + slotKey + '] 沿用现有技能 ' + slot.skillId);
      return Number(slot.skillId);
    }
    if (slot.mode !== 'custom') throw new Error('[' + slotKey + '] 未知模式 ' + slot.mode);

    // custom: allocate a fresh id + function id
    const skillId = allocSkill();
    const functionId = allocFunction();
    ids.skillId = skillId; ids.functionId = functionId;
    const skill = Object.assign({}, slot.skill, {
      job: slot.skill.job || job,
      cost: slot.skill.cost === undefined ? cost : slot.skill.cost,
      element: slot.skill.element || element,
    });
    const c = compileSkill(skill, {
      skillId, functionId,
      nextFunctionId: allocFunction,
      slot: slotKey === 'normal' ? 'normal' : 'arthur',
    }, { conventions: getConventions(pkg), rarityRank: draft.rarityRank, slot: slotKey }, log);
    skillRowsAll.push(...c.skillRows);
    roleRowsAll.push(...c.roleRows);
    log('  [' + slotKey + '] 新技能 id=' + skillId + ' functionId=' + functionId +
      ' 角色块=' + (skill.blocks || []).length + ' 变体=' + (skill.variants || []).length + ' 「' + (skill.name || '') + '」');
    log('        说明: ' + c.description);
    return skillId;
  }

  const jobCode = draft.arthurType === undefined ? 1 : Number(draft.arthurType);
  const jobName = { 1: 'MERCENARY', 2: 'MILLIONAIRE', 3: 'THIEF', 4: 'SINGER' }[jobCode] || 'MERCENARY';
  const element = draft.element || 'FIRE';
  const cost = draft.cost === undefined ? 1 : Number(draft.cost);

  // ★ 官方不变式（实测 1620/1622 双属性卡一致，例外的 2 张是旧工具写的坏数据）：
  //   卡属性掩码 == 该卡「通常技 + 覚醒技」元素位或。所以一个「属性」选择同时决定两边。
  const wantMask = elementMask(element);
  if (draft.fusionAttributes !== undefined && Number(draft.fusionAttributes) !== wantMask) {
    log('  ⚠ 卡属性掩码 ' + draft.fusionAttributes + ' 与所选属性「' + elementCn(element) + '」(' + wantMask +
      ') 不一致 —— 官方数据里这两者总是一致，已按属性选择覆盖。');
  }
  log('== 属性 ==');
  log('  ' + elementCn(element) + '（' + element + '）→ 掩码 ' + wantMask +
    ' = ' + (wantMask ? ELEMENT_ORDER.filter(e => wantMask & ELEMENT_BIT[e]).map(e => e).join('+') : '0') +
    (wantMask && String(element).includes('_') ? '  【双属性】' : ''));

  log('== 编译技能 ==');
  slotIds.normal = resolveSlot('normal', draft.normal, jobName, cost, element);
  slotIds.arthur = resolveSlot('arthur', draft.arthur, jobName, cost, element);

  // The server does NOT reject a card with missing skill ids: parseCombatCard just reads
  // the columns and CardSkill() only fails when a battle actually runs the card. But
  // official data has a 通常技 on 8441/8441 cards, so an empty one is always a mistake
  // (the other three jobs read it) -- catch it here instead of in battle.
  if (!slotIds.normal) {
    throw new Error('通常技不能为空：其他三个职业用这张卡时读的就是它。'
      + '请把「通常技」设为「自动生成弱化版 / 沿用克隆源 / 用现有技能」中的任意一个。');
  }
  if (!slotIds.arthur) {
    throw new Error('覚醒技不能为空：你自己的职业用这张卡时读的是它（本职业实际效果）。');
  }

  // ---- card row
  const newCardRow = buildCardRow(pkg, draft, slotIds);
  const cardCols = pkg.cards.lines.find(l => l && !l.startsWith('#')) ? parseCsvLine(pkg.cards.lines.find(l => l && !l.startsWith('#'))).length : 100;
  while (newCardRow.length < cardCols) newCardRow.push('');
  log('== 卡牌行 ==');
  log('  ' + newCardRow[CARD_COL.crown] + newCardRow[CARD_COL.name] +
    '  id=' + draft.id + ' 稀有度=' + newCardRow[CARD_COL.rarity] +
    (RARITY_CN[Number(draft.rarityRank)] ? '（' + RARITY_CN[Number(draft.rarityRank)] + ' rank=' + draft.rarityRank + '）' : '') +
    ' 职业=' + jobCode + '（' + JOB_CN[jobCode] + '）' +
    ' 费用=' + newCardRow[CARD_COL.cost] +
    ' 通常技=' + (slotIds.normal || '-') + ' 覚醒技=' + (slotIds.arthur || '-'));

  // ---- runtime master template
  const cloneTpl = pkg.tplById.get(Number(draft.clone));
  if (!cloneTpl) throw new Error('主表 card_templates[] 里找不到克隆源 ' + draft.clone);
  const cloneRank = pkg.rankCards[String(draft.clone)];
  if (!cloneRank) throw new Error('主表 deck_rank_policy.cards 里找不到克隆源 ' + draft.clone);

  const tpl = JSON.parse(JSON.stringify(cloneTpl));
  tpl.card_id = Number(draft.id);
  tpl.unique_id = 0;
  tpl.name = (draft.crown || '') + (draft.name || '');
  tpl.same_card_id = Number(draft.id);
  tpl.same_support_card_id = Number(draft.id);
  if (draft.rarityRank !== undefined) tpl.rarity_rank = Number(draft.rarityRank);
  if (draft.levelMax !== undefined) tpl.level_max = Number(draft.levelMax);
  if (draft.fameMax !== undefined) tpl.fame_max = Number(draft.fameMax);
  if (draft.loveMax !== undefined) tpl.love_max = Number(draft.loveMax);
  if (draft.premiumRarity !== undefined) tpl.premium_rarity = !!draft.premiumRarity;
  if (draft.experienceTableId !== undefined) tpl.experience_table_id = Number(draft.experienceTableId);
  if (draft.parameterInitial) tpl.parameter_initial = Object.assign({}, tpl.parameter_initial, draft.parameterInitial);
  if (draft.parameterMaximum) tpl.parameter_maximum = Object.assign({}, tpl.parameter_maximum, draft.parameterMaximum);
  if (draft.fusionAttributes !== undefined) tpl.fusion_attributes = Number(draft.fusionAttributes);
  else if (draft.element) {
    // 属性掩码 = 所选属性的位或（双属性就是两个位）。位序实测：1火 2冰 4风 8光 16暗。
    const mask = elementMask(draft.element);
    if (mask) tpl.fusion_attributes = mask;
  }
  // ★ Lv1 displayed values are DERIVED -- never write the maximum here.
  {
    const policy = master.card_progression_policy || {};
    const bonus = tpl.premium_rarity ? policy.fame_premium : policy.fame_normal;
    const fame = Number(tpl.fame) || 1;
    for (const k of ['hp', 'attack', 'magic', 'mind']) {
      tpl[k] = Number(tpl.parameter_initial[k]) + Math.trunc(Number(bonus[k]) * fame / 100);
    }
    const table = (master.card_experience_tables || {})[String(tpl.experience_table_id)];
    if (Array.isArray(table) && table.length) {
      tpl.next_level_experience = Number(tpl.level_max) > 1 ? Number(table[0]) : 0;
    }
  }
  verifyTemplateDerived(tpl, master, log);

  const rank = JSON.parse(JSON.stringify(cloneRank));
  rank.arthur_type = jobCode;
  if (draft.parameterMaximum) {
    rank.maximum_parameters = [rank.maximum_parameters[0], rank.maximum_parameters[1], rank.maximum_parameters[2], rank.maximum_parameters[3]];
  }

  const job = {
    pkg, log, draft, slotIds, newCardRow, tpl, rank,
    skillRows: skillRowsAll, roleRows: roleRowsAll,
    inPlace, element,
  };
  // Run the write phase immediately.
  //
  // NOTE ON `dryRun`: it still WRITES the three CSVs and the master JSON -- it only
  // skips rebuilding container.dat and re-sealing. That made "dry-run" a bad name and
  // it silently polluted the package once. Use one of the two explicit options instead:
  //   write: false          -> build + run every pre-write check, touch nothing (safe)
  //   rebuildBundle: false  -> write the server-side tables, leave the client bundle alone
  return applyInjection(job, {
    write: opts.write !== false,
    rebuildBundle: opts.rebuildBundle !== false,
    dryRun: !!opts.dryRun,
    log,
  });
}

/* ------------------------------------------------------------------ write out */
function applyInjection(job, opts = {}) {
  const log = job.log;
  const { pkg } = job;
  const id = Number(job.draft.id);

  // ---- 1/6. skills + role blocks
  if (job.skillRows.length) {
    const dup = job.skillRows.map(r => r[0]);
    log('== 写 skill_player.csv ==');
    const dropped = pkg.skills.removeByIds(dup, 0);
    if (dropped) log('  先删除同 ID 旧行 ' + dropped + ' 行');
    for (const r of job.skillRows) pkg.skills.append(r);
    log('  追加 ' + job.skillRows.length + ' 行（' + new Set(dup).size + ' 个技能 ID）');
  }
  if (job.roleRows.length) {
    const funcs = new Set(job.roleRows.map(r => r[0]));
    log('== 写 skill_role_player.csv ==');
    const dropped = pkg.roles.removeByIds([...funcs], 0);
    if (dropped) log('  先删除同 FunctionID 旧行 ' + dropped + ' 行');
    for (const r of job.roleRows) pkg.roles.append(r);
    log('  追加 ' + job.roleRows.length + ' 行 / ' + funcs.size + ' 组角色块');
  }

  // ---- 2. card.csv row
  log('== 写 card.csv ==');
  const droppedCard = pkg.cards.removeByIds([id], 0);
  if (droppedCard) log('  先删除旧行 ' + droppedCard + ' 行');
  pkg.cards.append(job.newCardRow);
  log('  追加 1 行');

  // ---- 3/4. master: templates + deck_rank (surgical text edit to keep formatting)
  log('== 写 cn602-card-runtime-master.json ==');
  const text = pkg.masterText;
  const parsed = JSON.parse(text);
  const tplIdx = parsed.card_templates.findIndex(t => t.card_id === id);
  let out = text;
  if (tplIdx >= 0) {
    // Replace the existing template object by splicing its exact text span, so the
    // untouched parts of the 15 MB document keep their byte-for-byte formatting.
    const arrKey = out.indexOf('"card_templates":');
    const open = out.indexOf('[', arrKey);
    const bounds = spanOfObjectContaining(out, open, '"card_id": ' + id);
    if (!bounds) throw new Error('无法定位已有模板 ' + id + ' 的文本范围');
    const rendered = JSON.stringify(job.tpl, null, 2).split('\n').map(l => '    ' + l).join('\n');
    out = out.slice(0, bounds.start) + rendered + out.slice(bounds.end + 1);
    log('  替换已有模板 (card_id=' + id + ')');
  } else {
    const arrKey = out.indexOf('"card_templates":');
    const open = out.indexOf('[', arrKey);
    let depth = 0, inStr = false, close = -1;
    for (let i = open; i < out.length; i++) {
      const c = out[i];
      if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
      if (c === '"') { inStr = true; continue; }
      if (c === '[') depth++; else if (c === ']') { depth--; if (depth === 0) { close = i; break; } }
    }
    const before = out.slice(0, close).replace(/\s+$/, '');
    const prev = before.slice(-1);
    const sep = (prev === '[' || prev === ',') ? '' : ',';
    const rendered = JSON.stringify(job.tpl, null, 2).split('\n').map(l => '    ' + l).join('\n');
    out = before + sep + '\n' + rendered + '\n  ' + out.slice(close);
    log('  追加模板 card_id=' + id);
  }

  // deck_rank entry
  const hasRank = Object.prototype.hasOwnProperty.call(parsed.deck_rank_policy.cards, String(id));
  {
    const rk = out.indexOf('"deck_rank_policy": {');
    const ck = out.indexOf('"cards": {', rk);
    const copen = out.indexOf('{', ck);
    let depth = 0, inStr = false, cclose = -1;
    for (let i = copen; i < out.length; i++) {
      const c = out[i];
      if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
      if (c === '"') { inStr = true; continue; }
      if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) { cclose = i; break; } }
    }
    const rankRendered = JSON.stringify(job.rank, null, 2).split('\n').map(l => '      ' + l).join('\n');
    if (hasRank) {
      const token = '"' + id + '": {';
      const at = out.indexOf(token, copen);
      if (at < 0 || at > cclose) throw new Error('定位不到已有 deck_rank 条目 ' + id);
      let s = at, d = 0, ins = false, e = -1;
      const brace = out.indexOf('{', at);
      for (let i = brace; i < out.length; i++) {
        const c = out[i];
        if (ins) { if (c === '\\') i++; else if (c === '"') ins = false; continue; }
        if (c === '"') { ins = true; continue; }
        if (c === '{') d++; else if (c === '}') { d--; if (d === 0) { e = i; break; } }
      }
      out = out.slice(0, s) + '"' + id + '": ' + rankRendered.replace(/^\s+/, '') + out.slice(e + 1);
      log('  替换 deck_rank 条目 ' + id + ' (arthur_type=' + job.rank.arthur_type + ')');
    } else {
      const inner = out.slice(copen + 1, cclose);
      const last = inner.lastIndexOf('}');
      const after = inner.slice(last + 1).replace(/\s/g, '');
      const at = copen + 1 + last + 1;
      out = out.slice(0, at) + (after === '' ? ',' : '') + '\n' + '      "' + id + '": ' +
        rankRendered.replace(/^\s+/, '') + out.slice(at);
      log('  追加 deck_rank 条目 ' + id + ' (arthur_type=' + job.rank.arthur_type + ')');
    }
  }
  // validate the edited document before writing
  JSON.parse(out);
  pkg.masterText = out;

  // ---- 5. admin assets
  log('== 写后台资产 ==');
  const admin = pkg.admin;
  const cc = admin.catalog_image_coverage.card;
  const tplCount = JSON.parse(pkg.masterText).card_templates.length;
  const thumbSrc = path.join(pkg.adminDir, 'card', String(job.draft.clone) + '.webp');
  const thumbDst = path.join(pkg.adminDir, 'card', String(id) + '.webp');
  // `artCardId`: copy the thumbnail from THIS card instead of the clone source, so the
  // new card can wear any existing card's art without inventing a new resource.
  const artFrom = job.draft.artCardId ? String(job.draft.artCardId) : String(job.draft.clone);
  const artSrc = path.join(pkg.adminDir, 'card', artFrom + '.webp');
  // NOTE: copying the thumbnail is a real file write, so it must live INSIDE the
  // write guard -- doing it earlier leaked a stray .webp into the package on a
  // no-write run.
  let copiedThumb = false;
  let thumbNote = '';
  let thumbWrote = false;
  if (opts.write && fs.existsSync(thumbDst)) {
    // 卡面工具如果在「自定义卡面」里单独取过景，缩略图已经写好了 —— 不动它（那张是按脸裁的）
    thumbNote = '缩略图已存在（自定义卡面里取过景），保留';
  } else if (opts.write) {
    // ★ 首选：**从这张卡实际的 chr10 卡面大图直接生成**（2026-09-24 改）
    //   以前只会「复制别的卡的 webp」，所以换过卡面的新卡缩略图是错的（用户报「缩略图没生效」）。
    //   明文包能读就生成；读不了（CN 加密包）才回退到老办法复制。
    let generated = null;
    try {
      const T = require('./thumb');
      const px = T.thumbFromPictId(pkg.root, job.draft.pictId, 160);
      if (px) {
        const t = T.writeThumbnail(pkg.root, id, px.rgba, px.width, px.height, { write: true, reseal: false, log });
        if (!t.error) { generated = t; thumbWrote = true; thumbNote = '缩略图由卡面大图 chr10 生成（' + (t.bytes / 1024).toFixed(1) + ' KB）'; }
      }
    } catch (e) {
      log('  [警告] 从卡面生成缩略图失败: ' + e.message);
    }
    if (!generated) {
      if (fs.existsSync(artSrc)) {
        fs.copyFileSync(artSrc, thumbDst);
        copiedThumb = true;
        thumbWrote = true;
        thumbNote = '缩略图复制自卡 ' + artFrom + '（卡面在加密包里，没法直接生成）';
      } else if (fs.existsSync(thumbSrc)) {
        fs.copyFileSync(thumbSrc, thumbDst);
        copiedThumb = true;
        thumbWrote = true;
        thumbNote = '缩略图复制自克隆源卡 ' + job.draft.clone;
      }
    }
  } else if (!fs.existsSync(thumbDst)) {
    log('  （未写盘：缩略图 ' + path.basename(thumbDst) + ' 也没有生成/复制）');
  }
  if (cc.entry_count !== tplCount) {
    log('  entry_count ' + cc.entry_count + ' -> ' + tplCount);
    cc.entry_count = tplCount;
    cc.resolved_source_count = tplCount - cc.source_gap_count;
    if (admin.exported) admin.exported.card = tplCount;
  }
  if (thumbNote) log('  ' + thumbNote);

  // ---- commit (skipped entirely when write:false, so the package is untouched)
  if (!opts.write) {
    log('（未写盘：所有校验都跑过了，包一个字节都没改）');
    return { ok: true, written: false, job };
  }
  pkg.cards.save();
  pkg.skills.save();
  pkg.roles.save();
  fs.writeFileSync(pkg.masterPath, pkg.masterText, 'utf8');
  if (admin.source) {
    admin.source.card_source_sha256 = sha256(pkg.cardCsvPath);
    admin.source.card_master_sha256 = sha256(pkg.masterPath);
  }
  fs.writeFileSync(pkg.adminManifestPath, JSON.stringify(admin, null, 2) + '\n', 'utf8');
  log('  已写入磁盘');

  if (opts.dryRun || !opts.rebuildBundle) {
    log('（已写服务端表，但跳过 bundle 重建与重签 —— 客户端此时还看不到这张卡）');
    return { ok: true, written: true, rebuilt: false, job };
  }

  // ---- 7. container.dat
  log('== 重建 container.dat ==');
  const before = fs.statSync(pkg.containerDat).size;
  const tmp = require('./tmp').file('cardforge', '.dat');
  try {
    const r = execFileSync(BUNDLE_TOOL, ['replace-many', pkg.containerDat, tmp,
      'card.csv=' + pkg.cardCsvPath,
      'skill_player.csv=' + pkg.skillCsvPath,
      'skill_role_player.csv=' + pkg.roleCsvPath,
    ], { encoding: 'utf8' });
    log(r.trim());
    fs.copyFileSync(tmp, pkg.containerDat);
  } finally { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
  log('  container.dat ' + before + ' -> ' + fs.statSync(pkg.containerDat).size + ' 字节');

  // ---- 8. reseal
  log('== 重签 ==');
  // ★ 放大立绘清单：有任何一张 chr51 PNG 没登记（老版本工具留下的），先补齐再一起重签 ——
  //   服务端只提供清单里列出的图片，漏登记 = 客户端观赏大图全白（见 imagemap.js）
  let imagemapWritten = false;
  try {
    const IM = require('./imagemap');
    const pend = IM.pendingChr51(pkg.root);
    if (pend.length) {
      const im = IM.syncImageManifest(pkg.root, {
        write: true, log,
        force: pend.map(p => Number(p.pictId)).filter(Boolean),
      });
      imagemapWritten = !!im.wrote;
      log('  图片清单同步：' + pend.length + ' 处不一致 → 共 ' + im.total + ' 张' +
        (im.added.length ? '（新登记 ' + im.added.length + '）' : ''));
    }
  } catch (e) {
    log('  [警告] 同步放大立绘清单失败: ' + e.message);
  }
  const resealArgs = [pkg.root, '--changed', 'resource-set/resources/patch/main_c/container.dat'];
  if (imagemapWritten) resealArgs.push('--changed', 'resource-set/resources/image/manifest.json');
  // 新写的卡面缩略图也在资源集里，必须一起进 --changed，否则清单会漏掉这个文件
  if (thumbWrote) resealArgs.push('--changed', 'resource-set/_local/control/server/cn602-admin-assets/card/' + id + '.webp');
  const rr = execFileSync(RESEAL, resealArgs, { encoding: 'utf8' });
  log(rr.trim());
  // reseal rewrites the master; keep the admin manifest hashes in sync
  if (admin.source) {
    admin.source.card_source_sha256 = sha256(pkg.cardCsvPath);
    admin.source.card_master_sha256 = sha256(pkg.masterPath);
    fs.writeFileSync(pkg.adminManifestPath, JSON.stringify(admin, null, 2) + '\n', 'utf8');
    execFileSync(RESEAL, [pkg.root, '--changed', 'resource-set/_local/control/server/cn602-admin-assets/manifest.json'], { encoding: 'utf8' });
  }
  log('注入完成 ✓');
  return { ok: true, job };
}

module.exports = { inject, compileSkill, buildCardRow, verifyTemplateDerived, BUNDLE_TOOL, RESEAL, SKILL_COLS, ROLE_COLS };
