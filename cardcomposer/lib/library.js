'use strict';
/*
 * library.js -- 「卡牌方案库」：记住写过的每一张卡，能导出成文件分享给别人、也能导入别人的文件。
 *
 * 为什么放这里：用户 2026-09-24 提的第三个需求 —— 「每次写完一张卡再退出就要重头来，
 * 我要能批量记住写过的卡，最好还能生成文件导入导出分享」。
 *
 * 数据就是一个 JSON 文件：`tools/cardcomposer/library/cards.json`
 *   { format:'kairisei-card-preset', version:1, savedAt, presets:[ preset, ... ] }
 * **一条 preset 就是一张卡的完整配方**（页面 collectDraft() 的全部字段 + 卡面取景状态），
 * 所以「加载」= 把表单恢复成当时的样子；「导出」= 把这些配方打成一个文件；
 * 「导入」= 合并进本机的库（sid 撞了就换一个新 sid，绝不覆盖别人的东西）。
 *
 * 导出文件里带 `art.source.dataUrl`（用户导入的那张原图）+ 取景参数，
 * 别人导入后只要素材一样，就能复现同一张卡面。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// 数据目录：默认 tools/cardcomposer/library/；测试用 KAIRI_LIBRARY_DIR 指到临时目录
const DIR = process.env.KAIRI_LIBRARY_DIR || path.join(__dirname, '..', 'library');
const FILE = path.join(DIR, 'cards.json');
const FORMAT = 'kairisei-card-preset';
const VERSION = 1;
const MAX_PRESETS = 2000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;      // 单条上限（含内嵌图片 base64）

function filePath() { return FILE; }

function readAll() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(j.presets) ? j.presets : [];
  } catch { return []; }
}
function writeAll(list) {
  fs.mkdirSync(DIR, { recursive: true });
  const doc = { format: FORMAT, version: VERSION, savedAt: new Date().toISOString(), presets: list };
  fs.writeFileSync(FILE, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  return doc;
}
function newSid() { return 'p' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'); }

/** 内容指纹：用来识别「同一个方案被导入了两次」，免得库里堆一堆一模一样的。 */
function contentHash(p) {
  const h = crypto.createHash('sha256');
  h.update(JSON.stringify(p.draft || {}));
  // 标题统一按 summarize() 的口径算，不然「导入时没写 title」和「存进去时补了 title」会被当成两份
  h.update('|' + String(p.title || summarize(p).title || ''));
  const src = p.art && p.art.source && p.art.source.dataUrl;
  if (src) h.update('|' + crypto.createHash('sha256').update(src).digest('hex'));
  return h.digest('hex');
}

/** 列表用的摘要（不带内嵌图片，免得列表接口太大）。 */
function summarize(p) {
  const art = p.art || {};
  return {
    sid: p.sid,
    title: p.title || (p.draft ? String((p.draft.crown || '') + (p.draft.name || '')) : '') || '(没名字)',
    cardId: Number(p.cardId || (p.draft && p.draft.id) || 0),
    clone: Number(p.clone || (p.draft && p.draft.clone) || 0),
    pictId: Number((p.draft && p.draft.pictId) || art.pictId || 0),
    voiceId: String((p.draft && p.draft.voiceId) || ''),
    hasSerif: !!((p.draft && p.draft.serif) || '').trim(),
    hasImage: !!(art.source && art.source.dataUrl),
    notes: p.notes || '',
    savedAt: p.savedAt || '',
    updatedAt: p.updatedAt || p.savedAt || '',
  };
}
function list() {
  return readAll().map(summarize)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

/** 存档（同一个 sid 覆盖，否则新增）。preset 由页面给，服务端只补时间戳/sid。 */
function save(preset) {
  if (!preset || typeof preset !== 'object') return { error: '没有方案内容' };
  if (!preset.draft || typeof preset.draft !== 'object') return { error: '方案里没有 draft（表单内容）' };
  const size = Buffer.byteLength(JSON.stringify(preset), 'utf8');
  if (size > MAX_FILE_BYTES) return { error: '这一条太大了（' + (size / 1048576).toFixed(1) + ' MB），图片请压缩后再存' };
  const all = readAll();
  const now = new Date().toISOString();
  const sid = String(preset.sid || '') || newSid();
  const row = Object.assign({}, preset, { sid, savedAt: preset.savedAt || now, updatedAt: now });
  if (!row.title) row.title = String((row.draft.crown || '') + (row.draft.name || '')).trim();
  row.cardId = Number(row.cardId || row.draft.id || 0);
  row.clone = Number(row.clone || row.draft.clone || 0);
  const i = all.findIndex((p) => p.sid === sid);
  let action;
  if (i >= 0) { all[i] = row; action = 'updated'; } else { all.push(row); action = 'added'; }
  if (all.length > MAX_PRESETS) return { error:'库里方案太多了（>' + MAX_PRESETS + '），先删一些' };
  writeAll(all);
  return { ok: true, sid, action, total: all.length, file: FILE };
}

function remove(sid) {
  const all = readAll();
  const kept = all.filter((p) => p.sid !== String(sid));
  if (kept.length === all.length) return { error: '库里没有这个方案（' + sid + '）', total: all.length };
  writeAll(kept);
  return { ok: true, removed: all.length - kept.length, total: kept.length, file: FILE };
}

/** 导出一个包（给别人分享）：sids 为空 = 全部。 */
function exportPack(sids) {
  const all = readAll();
  const want = Array.isArray(sids) && sids.length ? new Set(sids.map(String)) : null;
  const presets = want ? all.filter((p) => want.has(p.sid)) : all;
  return {
    format: FORMAT, version: VERSION, exportedAt: new Date().toISOString(),
    app: { name: 'kairisei cardcomposer', note: '导入：卡牌库 → 导入文件' },
    count: presets.length,
    presets,
  };
}

/** 导入一个包：合并进本机库。sid 撞了就换新 sid（不覆盖本机已有方案）。 */
function importPack(pack, opts) {
  const o = opts || {};
  if (!pack || typeof pack !== 'object') return { error: '这个文件不是卡牌方案包' };
  if (pack.format !== FORMAT) return { error: '文件格式不对（format=' + JSON.stringify(pack.format) + '，应该是 ' + FORMAT + '）' };
  if (Number(pack.version) > VERSION) return { error: '这个包是更新版本的工具导出的（version=' + pack.version + '），先升级工具' };
  const incoming = Array.isArray(pack.presets) ? pack.presets : [];
  if (!incoming.length) return { error: '包里没有任何方案' };
  const all = readAll();
  const have = new Set(all.map((p) => p.sid));
  const haveHash = new Map(all.map((p) => [contentHash(p), p.sid]));
  const added = [], renamed = [], skipped = [], duplicates = [];
  const now = new Date().toISOString();
  const allHashes = new Set(haveHash.keys());
  for (const p of incoming) {
    if (!p || typeof p !== 'object' || !p.draft || typeof p.draft !== 'object') { skipped.push({ sid: p && p.sid, why: '内容不完整' }); continue; }
    const hash = contentHash(p);
    if (o.dedupe !== false && allHashes.has(hash)) { duplicates.push({ sid: p.sid, title: summarize(p).title }); continue; }
    let sid = String(p.sid || '');
    if (!sid || have.has(sid)) { const old = sid; sid = newSid(); renamed.push({ from: old, to: sid, title: summarize(p).title }); }
    have.add(sid);
    allHashes.add(hash);
    const row = Object.assign({}, p, {
      sid,
      importedAt: now,
      updatedAt: p.updatedAt || now,
      savedAt: p.savedAt || now,
    });
    if (!row.title) row.title = summarize(row).title;
    all.push(row);
    added.push({ sid, title: summarize(row).title, cardId: Number(row.cardId || 0) });
  }
  if (!o.write) return { ok: true, dryRun: true, added, renamed, skipped, duplicates, total: all.length };
  writeAll(all);
  return { ok: true, added: added.length, renamed, skipped, duplicates, total: all.length, addedList: added, file: FILE, importedAt: now };
}

function get(sid) {
  return readAll().find((p) => p.sid === String(sid)) || null;
}

module.exports = { list, save, remove, exportPack, importPack, get, summarize, filePath, FORMAT, VERSION, DIR, FILE };
