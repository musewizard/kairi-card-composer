#!/usr/bin/env node
'use strict';
const WORK_ROOT = process.env.KAIRI_ROOT || require('../lib/tools').ROOT;
/*
 * conform-card-rows.js -- 把「早期版本的工具造出来的卡」的展示列改成官方写法。
 *
 * 为什么：早期版本的拼接器把技能的展示列留空、并把角色块的 HitPosition 写错列（第 7 列
 * 而不是第 5 列）、仇恨上限写死 1000000。客户端读这些列，表现就是卡面数字变乱码、
 * 战斗里卡组/手牌出问题。详见 lib/conventions.js 顶部注释与 HOW-TO 第十二节。
 *
 * 识别方式：**角色块第 7 列 = 'TARGET'** —— 官方数据里这一列是空的（或电影名），
 * 只有早期版本的工具会这么写，所以它正好是「工具造的技能」的指纹。
 *
 * 用法：
 *   node maintenance/conform-card-rows.js                     # 只报告（默认）
 *   node maintenance/conform-card-rows.js --write             # 真的改 + 重建 bundle + 重签
 *   node maintenance/conform-card-rows.js --card 99992000 --card 99992001
 *   node maintenance/conform-card-rows.js --package <路径>
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { Package, CARD_COL } = require('../lib/pkg');
const conventions = require('../lib/conventions');
const { BUNDLE_TOOL, RESEAL } = require('../lib/injector');

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const explicit = [];
for (let i = 0; i < args.length; i++) if (args[i] === '--card') explicit.push(String(args[i + 1]));
const pi = args.indexOf('--package');
const PKG = pi >= 0 ? args[pi + 1] : (process.env.KAIRI_PKG || require('../lib/tools').findPackage());
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const pkg = new Package(PKG);
pkg.load();
const conv = conventions.forPackage(pkg);
console.log('包：' + PKG);
console.log('模式：' + (WRITE ? '真的改（会重建 bundle + 重签）' : '只报告，不写盘'));

// ---- 找指纹：第 7 列 = TARGET 的角色块
const offenderFuncs = new Set();
for (const r of pkg.roles.dataRows()) if ((r[7] || '') === 'TARGET') offenderFuncs.add(String(r[0]));
console.log('早期写法（角色块 col7=TARGET）的 FunctionID 共 ' + offenderFuncs.size + ' 个');

// FunctionID → 技能 id（skill_player 第 49 列）
const funcToSkill = new Map();
for (const s of pkg.skills.dataRows()) funcToSkill.set(String(s[49] || s[0]), String(s[0]));
const offenderSkills = new Set();
for (const f of offenderFuncs) if (funcToSkill.has(f)) offenderSkills.add(funcToSkill.get(f));
console.log('涉及技能 id ' + offenderSkills.size + ' 个：' + [...offenderSkills].slice(0, 12).join(',') + (offenderSkills.size > 12 ? ' …' : ''));

// 涉及哪些卡
const cards = pkg.cards.dataRows();
const affected = [];
for (const c of cards) {
  const ids = [String(c[26] || ''), String(c[27] || '')].filter(Boolean);
  if (ids.some(id => offenderSkills.has(id))) affected.push(c);
  else if (explicit.includes(String(c[0]))) affected.push(c);
}
const want = explicit.length ? cards.filter(c => explicit.includes(String(c[0]))) : affected;
console.log('要处理的卡 ' + want.length + ' 张：');
for (const c of want) {
  const tpl = pkg.tplById.get(Number(c[0]));
  console.log('  ' + c[0] + '  ' + (c[CARD_COL.crown] || '') + (c[CARD_COL.name] || '') +
    '  稀有度 rank=' + (tpl ? tpl.rarity_rank : '?') + '  技能 ' + c[26] + '/' + c[27]);
}
if (!want.length) {
  console.log('没有需要处理的卡 ✓');
  if (!WRITE) process.exit(0);
  // --write 且没东西要改时，仍然把 bundle 重建 + 重签跑一遍（幂等），
  // 这样「上次因为管道被截断而没跑完重签」的情况可以补跑。
  console.log('（--write：仍然重建 bundle + 重签，保证包是自洽的）');
}

const plan = [];              // {kind:'skill'|'role', id, rows, notes}
const notes = [];
/** 只填空列：已经有权值的列（例如从官方行抄来的）绝不动。 */
const fillIfEmpty = (row, idx, value) => { if (!String(row[idx] || '').trim() && String(value || '').trim()) row[idx] = value; };

for (const c of want) {
  const tpl = pkg.tplById.get(Number(c[0]));
  const rarity = tpl ? tpl.rarity_rank : 1;
  for (const [col, slot, label] of [[26, 'normal', '通常技'], [27, 'arthur', '覚醒技']]) {
    const sid = String(c[col] || '').trim();
    if (!sid) continue;
    const rows = pkg.skills.dataRows().filter(s => s[0] === sid);
    if (!rows.length) { notes.push('卡 ' + c[0] + ' 的' + label + ' ' + sid + ' 在 skill_player 里找不到'); continue; }
    const kind = rows[0][10] || '';
    const rank = conv.rank(rarity, slot);
    const code = conv.skillCode(kind, rank);
    // ★ 第 5 列 DisplayRole = 卡面显示哪个块。早期版本一律写 1（第一个块），
    //   于是「先增益后攻击」的卡会拿增益块的原始大数当卡面数字 → 0000000 乱码。
    //   官方规律：有伤害块就指向第一个 ATTACK_AA。
    const func0 = String(rows[0][49] || rows[0][0]);
    const roleRows0 = pkg.roles.dataRows().filter(x => x[0] === func0);
    const dr = conv.displayRoleOf(roleRows0);
    const fixed = rows.map(r => {
      const o = r.slice();
      o[5] = String(dr);
      o[4] = conv.col4ForDisplayRole(dr);
      fillIfEmpty(o, 7, conv.skillCat(kind));
      fillIfEmpty(o, 9, conv.skillPres.col9);
      fillIfEmpty(o, 15, code.col15);
      fillIfEmpty(o, 16, code.col16);
      fillIfEmpty(o, 17, rank);
      fillIfEmpty(o, 18, conv.skillPres.col18);
      return o;
    });
    const touched = fixed.some((o, i) => o.join(',') !== rows[i].join(','));
    if (touched) plan.push({
      kind: 'skill', id: sid, rows: fixed,
      label: label + ' ' + sid + ' (kind=' + kind + ' → ' + rank + ', 效果码 ' + code.col15 +
        ', DisplayRole=' + dr + ' col4=' + conv.col4ForDisplayRole(dr) + ')',
    });
    // 角色块：按 FunctionID 改展示列
    for (const r of rows) {
      const func = String(r[49] || sid);
      const rr = pkg.roles.dataRows().filter(x => x[0] === func);
      const fixedRoles = rr.map(x => {
        const o = x.slice();
        const pres = conv.role(x[8]);
        // ★ 早期版本把 'TARGET' 写进了第 7 列（官方第 7 列是空的）
        if ((o[7] || '') === 'TARGET') o[7] = '';
        fillIfEmpty(o, 5, pres.hitPosition || 'TARGET');
        fillIfEmpty(o, 4, pres.hitEffect);
        fillIfEmpty(o, 7, pres.col7);
        // ★ 仇恨上限：早期版本一律 1000000
        if ((o[31] || '') === '1000000') o[31] = pres.hateLimit;
        else fillIfEmpty(o, 31, pres.hateLimit);
        return o;
      });
      const rTouched = fixedRoles.some((o, i) => o.join(',') !== rr[i].join(','));
      if (rTouched) plan.push({ kind: 'role', id: func, rows: fixedRoles, label: label + ' functionId=' + func });
      // 说明里的占位符：指向「大数原始参数」的改成官方显示参数
      for (const s of rows) {
        let desc = String(s[3] || '');
        if (!desc) continue;
        let changed = false;
        desc = desc.replace(/\{(\d+)\}/g, (whole, d) => {
          const n = Number(d);
          const bi = Math.floor((n - 1) / 10);
          const prm = (n - 1) % 10;
          const row = rr[bi];
          if (!row) return whole;
          const want2 = conv.displayParamOf(row[8]);
          if (prm === want2) return whole;
          const val = (row[20 + prm] || '').trim();
          if (!/^\d{6,}$/.test(val)) return whole;      // 只修「原始大数」那种（会造成乱码）
          changed = true;
          return '{' + (bi * 10 + want2 + 1) + '}';
        });
        if (changed) {
          const all = pkg.skills.dataRows().filter(x => x[0] === s[0]).map(x => x.slice());
          for (const x of all) if (String(x[49]) === String(s[49])) x[3] = desc;
          plan.push({ kind: 'desc', id: s[0], rows: all, label: label + ' 说明占位符' });
          notes.push('  ' + c[0] + ' ' + label + ' 说明: ' + s[3]);
          notes.push('        → ' + desc);
        }
      }
    }
  }
}

console.log('\n改动计划：');
for (const p of plan) console.log('  [' + p.kind + '] ' + p.label);
for (const n of notes) console.log(n);

if (!WRITE) { console.log('\n（只报告。要真的改就加 --write）'); process.exit(0); }

// ---- 备份
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
const backup = path.join((WORK_ROOT + '\\card-backups'), stamp + '-conform-card-rows');
fs.mkdirSync(backup, { recursive: true });
for (const [src, name] of [
  [pkg.cardCsvPath, 'card.csv'], [pkg.skillCsvPath, 'skill_player.csv'], [pkg.roleCsvPath, 'skill_role_player.csv'],
  [pkg.masterPath, 'cn602-card-runtime-master.json'], [pkg.adminManifestPath, 'admin-manifest.json'],
  [pkg.containerDat, 'container.dat'], [path.join(pkg.root, 'release-manifest.json'), 'release-manifest.json'],
]) if (fs.existsSync(src)) fs.copyFileSync(src, path.join(backup, name));
console.log('备份到 ' + backup);

// ---- 应用
for (const p of plan) {
  if (p.kind === 'skill' || p.kind === 'desc') pkg.skills.replaceById(p.id, p.rows);
  if (p.kind === 'role') pkg.roles.replaceById(p.id, p.rows);
}
pkg.skills.save();
pkg.roles.save();
console.log('已写入 skill_player.csv / skill_role_player.csv');

// ---- 重建 bundle + 重签
const tmp = require('../lib/tmp').file('conform', '.dat');
try {
  const r = execFileSync(BUNDLE_TOOL, ['replace-many', pkg.containerDat, tmp,
    'skill_player.csv=' + pkg.skillCsvPath,
    'skill_role_player.csv=' + pkg.roleCsvPath,
  ], { encoding: 'utf8' });
  console.log('  ' + r.trim().split('\n').join('\n  '));
  fs.copyFileSync(tmp, pkg.containerDat);
} finally { try { fs.unlinkSync(tmp); } catch { } }
console.log('  ' + execFileSync(RESEAL, [pkg.root, '--changed', 'resource-set/resources/patch/main_c/container.dat'], { encoding: 'utf8' }).trim());

const admin = JSON.parse(fs.readFileSync(pkg.adminManifestPath, 'utf8'));
if (admin.source) {
  admin.source.card_source_sha256 = sha256(pkg.cardCsvPath);
  admin.source.card_master_sha256 = sha256(pkg.masterPath);
  fs.writeFileSync(pkg.adminManifestPath, JSON.stringify(admin, null, 2) + '\n', 'utf8');
  console.log('  ' + execFileSync(RESEAL, [pkg.root, '--changed', 'resource-set/_local/control/server/cn602-admin-assets/manifest.json'], { encoding: 'utf8' }).trim());
}
console.log('完成 ✓  记得跑 Start-Server.ps1 -ValidationOnly 看到 server ready');
