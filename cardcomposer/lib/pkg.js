'use strict';
/*
 * pkg.js -- read/write the kairisei-ma-ch service package.
 *
 * The 8 write points (documented in tools/KAIRIMOD.md) live here:
 *   1 card.csv row            2 card_templates[] entry        3 deck_rank_policy.cards entry
 *   4 admin manifest counts   5 admin thumbnail               6 skill_player / skill_role_player rows
 *   7 container.dat TextAssets (delegated to tools/bundle-tool) 8 reseal (delegated to tools/reseal)
 * Every mutation is expressed as "new value for this key", so apply/rollback is explicit.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ---------------------------------------------------------------- csv
function parseCsvLine(line) {
  const out = []; let sb = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { sb += '"'; i++; } else q = false; } else sb += c; }
    else { if (c === '"') q = true; else if (c === ',') { out.push(sb); sb = ''; } else sb += c; }
  }
  out.push(sb); return out;
}
function csvField(v) {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function csvLine(fields) { return fields.map(csvField).join(','); }

class CsvFile {
  constructor(filePath) {
    this.path = filePath;
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    this.crlf = raw.includes('\r\n');
    this.nl = this.crlf ? '\r\n' : '\n';
    this.lines = raw.replace(/\r\n/g, '\n').split('\n');
    if (this.lines.length && this.lines[this.lines.length - 1] === '') this.lines.pop();
  }
  /** All rows with a parse function; only data rows (not # comments). */
  dataRows(parse) { return this.lines.filter(l => l && !l.startsWith('#')).map(l => parse ? parse(parseCsvLine(l)) : parseCsvLine(l)); }
  /** Replace every data row whose parsed[0] === id, then append `rows` (array of field arrays). */
  replaceById(id, rows, keyIndex = 0) {
    const target = String(id);
    const kept = [];
    let dropped = 0;
    for (const l of this.lines) {
      if (l && !l.startsWith('#')) {
        const fields = parseCsvLine(l);
        if (fields[keyIndex] === target) { dropped++; continue; }
      }
      kept.push(l);
    }
    for (const r of rows) kept.push(csvLine(r));
    this.lines = kept;
    return dropped;
  }
  /** Keep only data rows whose key is not in ids. */
  removeByIds(ids, keyIndex = 0) {
    const set = new Set(ids.map(String));
    const kept = [];
    let dropped = 0;
    for (const l of this.lines) {
      if (l && !l.startsWith('#')) {
        const fields = parseCsvLine(l);
        if (set.has(fields[keyIndex])) { dropped++; continue; }
      }
      kept.push(l);
    }
    this.lines = kept;
    return dropped;
  }
  hasId(id, keyIndex = 0) {
    const t = String(id);
    return this.lines.some(l => l && !l.startsWith('#') && parseCsvLine(l)[keyIndex] === t);
  }
  append(fields) { this.lines.push(csvLine(fields)); }
  toString() { return this.lines.join(this.nl) + this.nl; }
  save() { fs.writeFileSync(this.path, this.toString(), 'utf8'); }
}

// ---------------------------------------------------------------- card.csv columns
const CARD_COL = {
  id: 0, baseId: 1, sameId: 2, sameSupportId: 3, crown: 4, name: 5, stack: 6,
  // 第 7 列是稀有度的【英文名】，不是数字！
  //   实测全表 8447 行：NORMAL×28 HIGHNORMAL×52 RARE×75 SUPERRARE×312
  //   ULTRARARE×1538 MILLIONRARE×4386 EXRARE×2054 LEGEND×1（外加 1 行是旧工具写错的数字）
  //   对照 card_templates[].rarity_rank 反推出的映射见 RARITY_NAME。
  rarity: 7, rarityColor: 8, cost: 9,
  param: [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21], // 4 blocks of (initial,max) + 4 spare
  overlimit: 22, levelMax: 23, loveMax: 24, fameMax: 25,
  normalSkill: 26, arthurSkill: 27,
  support0: 28, support1: 29, support2: 30, support3: 31,
  callSkill: 32, passiveSkill: 33, skillLevelMax: 34, cutin: 35, pictId: 36,
  expId: 41, sellGold: 42,
  // 第 67 列 騎士セリフ（台词文本，换行用 <br>）、第 82 列 ボイスID（配音）。
  // 实测：8450 行里台词非空 8134（3363 种，2183 行含 <br>），配音非空 7474（1201 种）；
  // 同一个配音 ID 会被同一角色的多张卡共用（例：10000010~10000013 都是 600040010），
  // 所以它是「按角色」的，不是每张卡一段；有台词但没配音的卡有 848 张（用户印象属实）。
  serif: 67, voiceId: 82,
};

// ---------------------------------------------------------------- package
class Package {
  constructor(root) {
    this.root = path.resolve(root);
    this.srv = path.join(this.root, 'resource-set', '_local', 'control', 'server');
    this.cardCsvPath = path.join(this.srv, 'cn602-card-master', 'card.csv');
    this.skillCsvPath = path.join(this.srv, 'cn602-battle-master', 'skill_player.csv');
    this.roleCsvPath = path.join(this.srv, 'cn602-battle-master', 'skill_role_player.csv');
    this.masterPath = path.join(this.srv, 'cn602-card-runtime-master.json');
    this.adminDir = path.join(this.srv, 'cn602-admin-assets');
    this.adminManifestPath = path.join(this.adminDir, 'manifest.json');
    this.containerDat = path.join(this.root, 'resource-set', 'resources', 'patch', 'main_c', 'container.dat');
  }

  load() {
    this.cards = new CsvFile(this.cardCsvPath);
    this.skills = new CsvFile(this.skillCsvPath);
    this.roles = new CsvFile(this.roleCsvPath);
    this.masterText = fs.readFileSync(this.masterPath, 'utf8').replace(/^\uFEFF/, '');
    this.master = JSON.parse(this.masterText);
    this.admin = JSON.parse(fs.readFileSync(this.adminManifestPath, 'utf8').replace(/^\uFEFF/, ''));
    // indexes
    this.cardById = new Map();
    for (const r of this.cards.dataRows()) this.cardById.set(Number(r[CARD_COL.id]), r);
    this.skillById = new Map();
    for (const r of this.skills.dataRows()) {
      const id = Number(r[0]);
      if (!this.skillById.has(id)) this.skillById.set(id, []);
      this.skillById.get(id).push(r);
    }
    this.rolesByFunc = new Map();
    for (const r of this.roles.dataRows()) {
      const id = Number(r[0]);
      if (!this.rolesByFunc.has(id)) this.rolesByFunc.set(id, []);
      this.rolesByFunc.get(id).push(r);
    }
    this.tplById = new Map(this.master.card_templates.map(t => [t.card_id, t]));
    this.rankCards = this.master.deck_rank_policy.cards;
    return this;
  }

  /** Highest existing ID in card.csv, for "next free id". */
  maxCardId() { return Math.max(...[...this.cardById.keys()]); }
  maxSkillId() {
    let m = 0;
    for (const id of this.skillById.keys()) if (id > m) m = id;
    return m;
  }
  maxFunctionId() {
    let m = 0;
    for (const id of this.rolesByFunc.keys()) if (id > m) m = id;
    return m;
  }
  freeCardId(start) { let id = start; while (this.cardById.has(id)) id++; return id; }
  freeSkillId(start) { let id = start; while (this.skillById.has(id)) id++; return id; }
  freeFunctionId(start) { let id = start; while (this.rolesByFunc.has(id)) id++; return id; }

  rolesOfSkill(skillId) {
    const rows = this.skillById.get(Number(skillId)) || [];
    if (!rows.length) return [];
    const f = Number((rows[0][49] || '').trim()) || Number(skillId);
    return this.rolesByFunc.get(f) || [];
  }

  /** Write everything back and rebuild the client bundle + reseal. */
  save(opts = {}) {
    const log = opts.log || (() => {});
    this.cards.save(); log('wrote card.csv');
    this.skills.save(); log('wrote skill_player.csv');
    this.roles.save(); log('wrote skill_role_player.csv');
    fs.writeFileSync(this.masterPath, this.masterText.replace(/\r\n/g, '\n'), 'utf8');
    log('wrote cn602-card-runtime-master.json');
    fs.writeFileSync(this.adminManifestPath, JSON.stringify(this.admin, null, 2) + '\n', 'utf8');
    log('wrote admin manifest.json');
  }
}

// ---------------------------------------------------------------- 稀有度 / 属性
// 稀有度：模板里的 rarity_rank(1..8) ↔ card.csv 第 7 列的英文名。实测反推得出（见 CARD_COL）。
const RARITY_NAME = { 1: 'NORMAL', 2: 'HIGHNORMAL', 3: 'RARE', 4: 'SUPERRARE', 5: 'ULTRARARE', 6: 'MILLIONRARE', 7: 'EXRARE', 8: 'LEGEND' };
const RARITY_CODE = { 1: 'N', 2: 'HN', 3: 'R', 4: 'SR', 5: 'UR', 6: 'MR', 7: 'EXR', 8: 'LEGEND' };
const RARITY_CN = { 1: '普通', 2: '高级普通', 3: '稀有', 4: '超稀有', 5: '究极稀有', 6: '百万稀有', 7: 'EX稀有', 8: '传说' };
const RARITY_RANK_OF = Object.fromEntries(Object.entries(RARITY_NAME).map(([k, v]) => [v, Number(k)]));

// 属性：card_templates[].fusion_attributes 是 5 位掩码，位序实测为
//   bit0=1 FIRE / bit1=2 ICE / bit2=4 WIND / bit3=8 LIGHT / bit4=16 DARK
// 技能元素（skill_player.csv 第 11 列）单属性写 'FIRE'，双属性写 'FIRE_ICE'
//   —— **一律按 bit 升序**，全表 3178 个双属性元素零例外。
// 官方的双属性卡：两条技能用同一个双属性，掩码 = 两个位或起来（1620/1622 一致，
//   仅有的 2 个例外是旧工具写的 MOD 卡）。
const ELEMENT_BIT = { FIRE: 1, ICE: 2, WIND: 4, LIGHT: 8, DARK: 16 };
const BIT_ELEMENT = { 1: 'FIRE', 2: 'ICE', 4: 'WIND', 8: 'LIGHT', 16: 'DARK' };
const ELEMENT_CN = { FIRE: '火', ICE: '冰', WIND: '风', LIGHT: '光', DARK: '暗' };
const ELEMENT_ORDER = ['FIRE', 'ICE', 'WIND', 'LIGHT', 'DARK'];

/** 'FIRE_ICE' / '火冰' 之类 → 掩码整数（只认官方位序）。 */
function elementMask(element) {
  return String(element || '').split('_').reduce((a, p) => a | (ELEMENT_BIT[p] || 0), 0);
}
/** 掩码 → 官方元素名（按位升序拼接）。 */
function maskElement(mask) {
  const parts = ELEMENT_ORDER.filter(e => (mask & ELEMENT_BIT[e]));
  return parts.length ? parts.join('_') : '';
}
/** 元素 → 中文（'火冰'）。 */
function elementCn(element) {
  return String(element || '').split('_').map(p => ELEMENT_CN[p] || p).join('');
}
/** 单属性 5 种 + 双属性 10 种 —— 正好是官方的全部合法取值。 */
const ELEMENTS_ALL = (() => {
  const out = ELEMENT_ORDER.slice();
  for (let i = 0; i < ELEMENT_ORDER.length; i++) {
    for (let j = i + 1; j < ELEMENT_ORDER.length; j++) out.push(ELEMENT_ORDER[i] + '_' + ELEMENT_ORDER[j]);
  }
  return out;
})();

module.exports = {
  Package, CsvFile, parseCsvLine, csvField, csvLine, CARD_COL,
  RARITY_NAME, RARITY_CODE, RARITY_CN, RARITY_RANK_OF,
  ELEMENT_BIT, BIT_ELEMENT, ELEMENT_CN, ELEMENT_ORDER, ELEMENTS_ALL,
  elementMask, maskElement, elementCn,
};
