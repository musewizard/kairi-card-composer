#!/usr/bin/env node
'use strict';
const WORK_ROOT = process.env.KAIRI_ROOT || require('../lib/tools').ROOT;
/*
 * fix-rarity-column.js -- 一次性维护脚本：修 card.csv 第 7 列被写成数字的行。
 *
 * 背景（实测）：card.csv 第 7 列是稀有度的【英文名】（NORMAL/HIGHNORMAL/RARE/SUPERRARE/
 * ULTRARARE/MILLIONRARE/EXRARE/LEGEND），官方 8447 行全是名字。早期版本的拼接器
 * 写的是 rarity_rank 数字（例如 "7"），全表只有这种行是脏数据。
 *
 * 用法：
 *   node maintenance/fix-rarity-column.js                 # 只看，不写（默认）
 *   node maintenance/fix-rarity-column.js --write         # 真的改：写 card.csv + 重建 bundle + 重签
 *   node maintenance/fix-rarity-column.js --package <路径>
 *
 * 改哪个值：以主表 card_templates[].rarity_rank 为准（它是服务端权威），
 * 把数字换成 RARITY_NAME[rank]。主表本身不动。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { Package, CARD_COL, RARITY_NAME, RARITY_CODE } = require('../lib/pkg');
const { BUNDLE_TOOL, RESEAL } = require('../lib/injector');

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const pi = args.indexOf('--package');
const PKG = pi >= 0 ? args[pi + 1] : (process.env.KAIRI_PKG || require('../lib/tools').findPackage());

const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

console.log('包：' + PKG);
console.log('模式：' + (WRITE ? '真的改（会重签）' : '只检查，不写盘'));
const pkg = new Package(PKG);
pkg.load();

// ---- 找出所有「第 7 列是纯数字」的行
const bad = [];
for (const cells of pkg.cards.dataRows()) {
  const v = (cells[CARD_COL.rarity] || '').trim();
  if (/^\d+$/.test(v)) {
    const id = String(Number(cells[CARD_COL.id]));
    const tpl = pkg.tplById.get(Number(id));
    const rank = tpl ? Number(tpl.rarity_rank) : Number(v);
    bad.push({ cells, old: v, rank, want: RARITY_NAME[rank] || '' });
  }
}
if (!bad.length) {
  console.log('没有需要修的卡：第 7 列全是英文名 ✓');
  process.exit(0);
}
console.log('发现 ' + bad.length + ' 张卡的第 7 列是数字：');
for (const b of bad) {
  console.log('  ' + b.cells[CARD_COL.id] + '  ' + (b.cells[CARD_COL.crown] || '') + (b.cells[CARD_COL.name] || '') +
    '  第7列=' + JSON.stringify(b.old) + '  主表 rarity_rank=' + b.rank + '  → 应写 ' + JSON.stringify(b.want) +
    (RARITY_CODE[b.rank] ? '（' + RARITY_CODE[b.rank] + '）' : ''));
  if (!b.want) console.log('    ⚠ 主表里没有 rarity_rank，跳过');
}

if (!WRITE) {
  console.log('\n（只检查。要真的改就加 --write）');
  process.exit(0);
}

// ---- 备份
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
const backup = path.join((WORK_ROOT + '\\card-backups'), stamp + '-fix-rarity-column');
fs.mkdirSync(backup, { recursive: true });
for (const [src, name] of [
  [pkg.cardCsvPath, 'card.csv'],
  [pkg.masterPath, 'cn602-card-runtime-master.json'],
  [pkg.adminManifestPath, 'admin-manifest.json'],
  [pkg.containerDat, 'container.dat'],
  [path.join(pkg.root, 'release-manifest.json'), 'release-manifest.json'],
]) {
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(backup, name));
}
console.log('备份到 ' + backup);

// ---- 改行（按 id 整行替换，保留其它列）
let fixed = 0;
for (const b of bad) {
  if (!b.want) continue;
  const fields = b.cells.slice();
  fields[CARD_COL.rarity] = b.want;
  pkg.cards.replaceById(fields[CARD_COL.id], [fields]);
  fixed++;
}
pkg.cards.save();
console.log('card.csv：修好 ' + fixed + ' 行');

// ---- 7. 重建 container.dat
console.log('重建 container.dat …');
const tmp = require('../lib/tmp').file('fixrarity', '.dat');
try {
  const r = execFileSync(BUNDLE_TOOL, ['replace-many', pkg.containerDat, tmp,
    'card.csv=' + pkg.cardCsvPath,
  ], { encoding: 'utf8' });
  console.log('  ' + r.trim().split('\n').join('\n  '));
  fs.copyFileSync(tmp, pkg.containerDat);
} finally { try { fs.unlinkSync(tmp); } catch { } }

// ---- 8. 重签
console.log('重签 container …');
console.log('  ' + execFileSync(RESEAL, [pkg.root, '--changed', 'resource-set/resources/patch/main_c/container.dat'], { encoding: 'utf8' }).trim());

const admin = JSON.parse(fs.readFileSync(pkg.adminManifestPath, 'utf8'));
if (admin.source) {
  admin.source.card_source_sha256 = sha256(pkg.cardCsvPath);
  admin.source.card_master_sha256 = sha256(pkg.masterPath);
  fs.writeFileSync(pkg.adminManifestPath, JSON.stringify(admin, null, 2) + '\n', 'utf8');
  console.log('重签 admin manifest …');
  console.log('  ' + execFileSync(RESEAL, [pkg.root, '--changed', 'resource-set/_local/control/server/cn602-admin-assets/manifest.json'], { encoding: 'utf8' }).trim());
}
console.log('完成 ✓  现在应该跑一次 Start-Server.ps1 -ValidationOnly 看到 server ready');
