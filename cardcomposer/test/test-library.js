#!/usr/bin/env node
/*
 * test-library.js -- 「卡牌方案库」单元测试（用临时目录，绝不碰真的 library/cards.json）
 *
 * 覆盖：存/覆盖/列出/删除、摘要字段（玩法相关：卡号/克隆源/台词/配音/有没有带图）、
 *       导出包的结构、导入的合并规则（sid 撞了要换新 sid、不覆盖本机已有的）、
 *       坏文件的友好报错。用户要的是「批量记住 + 生成文件分享 + 导入别人的」，这几条是核心。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = require('../lib/tmp').dir('kairi-lib');
process.env.KAIRI_LIBRARY_DIR = TMP;                 // 必须在 require 之前设
const L = require('../lib/library');

let bad = 0;
const ok = (c, m, d) => { console.log((c ? '  [OK]   ' : '  [FAIL] ') + m + (d ? '  ' + d : '')); if (!c) bad++; };
const mk = (id, name, extra) => Object.assign({
  cardId: id, clone: 10000182,
  draft: {
    id, clone: 10000182, crown: '【MOD】', name, pictId: 10152034, serif: '台词' + id, voiceId: '600740010',
    rarityRank: 7, arthurType: 1, cost: 1, levelMax: 80, fameMax: 100, loveMax: 10000,
    parameterInitial: { hp: 1000, attack: 500, magic: 500, mind: 250 },
    parameterMaximum: { hp: 5000, attack: 2000, magic: 2000, mind: 900 },
    element: 'ICE',
    arthur: { mode: 'custom', skill: { name: '技', kind: 'SORCERY', blocks: [{ kind: 'attack', params: { 0: '100' } }], variants: [] } },
    normal: { mode: 'weaken' },
  },
}, extra || {});

console.log('=== 存档 / 覆盖 / 列表 ===');
ok(L.filePath().startsWith(TMP), '测试用的是临时库文件', L.filePath());
const r1 = L.save(mk(99993001, '测试卡甲'));
ok(r1.ok && r1.action === 'added' && r1.total === 1, '存第一条（新增）', JSON.stringify(r1));
const r2 = L.save(Object.assign(mk(99993002, '测试卡乙'), { sid: r1.sid }));
ok(r2.ok && r2.action === 'updated' && r2.total === 1, '同一个 sid 再存 = 覆盖，不新增', JSON.stringify(r2));
const r3 = L.save(mk(99993003, '测试卡丙', { art: { source: { name: 'a.png', dataUrl: 'data:image/png;base64,AAA' }, view: { s: 1, ox: 0, oy: 0 } } }));
ok(r3.ok && r3.total === 2, '存第二条（新增，带图）', JSON.stringify(r3));
const list = L.list();
ok(list.length === 2, '列表 2 条', String(list.length));
const a = list.find((p) => p.cardId === 99993002);
ok(a && a.title === '【MOD】测试卡乙', '列表带标题（含称号）', a && a.title);
ok(a && a.hasSerif === true && a.voiceId === '600740010', '列表带「有没有台词 / 配音 ID」', a && (a.hasSerif + '/' + a.voiceId));
ok(list.find((p) => p.cardId === 99993003).hasImage === true, '带图的方案在列表里标出来（hasImage）');
ok(!JSON.stringify(list).includes('data:image'), '列表接口不带内嵌图片（不然列表会很大）');
ok(list[0].updatedAt >= list[1].updatedAt, '按更新时间倒序');

console.log('\n=== 导出 ===');
const pack = L.exportPack(null);
ok(pack.format === L.FORMAT && pack.version === L.VERSION, '导出包带 format/version', pack.format + ' v' + pack.version);
ok(pack.count === 2 && pack.presets.length === 2, '导出全部 2 条', String(pack.count));
ok(!!pack.exportedAt, '导出包带时间戳', pack.exportedAt);
const one = L.exportPack([r1.sid]);
ok(one.count === 1 && one.presets[0].cardId === 99993002, '只导出勾选的那一条', String(one.count));

console.log('\n=== 导入（别人发来的文件）===');
const other = { format: L.FORMAT, version: 1, exportedAt: new Date().toISOString(), presets: [
  Object.assign(mk(99994001, '别人的卡'), { sid: 'other-1' }),
  Object.assign(mk(99994002, '别人的卡2'), { sid: r1.sid }),          // sid 故意撞本机已有的
  { sid: 'broken', nope: true },                                       // 坏条目
] };
const dry = L.importPack(other, { write: false });
ok(dry.ok && dry.dryRun && dry.added.length === 2, '干跑：算出会新增 2 条（坏条目跳过）', JSON.stringify(dry.added.map((x) => x.title)));
ok(dry.renamed.length === 1 && dry.renamed[0].from === r1.sid, 'sid 撞了的那条会被改名（不覆盖本机方案）', JSON.stringify(dry.renamed));
ok(dry.skipped.length === 1, '内容不完整的条目被跳过', JSON.stringify(dry.skipped));
ok(L.list().length === 2, '干跑没有真的写进去');
const wet = L.importPack(other, { write: true });
ok(wet.ok && wet.added === 2 && wet.total === 4, '真导入：2 条进来，共 4 条', JSON.stringify({ added: wet.added, total: wet.total }));
const after = L.list();
ok(after.find((p) => p.cardId === 99994001) && after.find((p) => p.cardId === 99994002), '两条都在库里');
ok(after.find((p) => p.cardId === 99993002).sid === r1.sid, '本机原来那条的 sid 没被顶掉', r1.sid);

console.log('\n=== 导入同一个包两次（内容一样的自动认出来，不重复堆）===');
const again = L.importPack(other, { write: true });
ok(again.ok && again.added === 0 && again.duplicates.length === 2 && again.total === 4,
  '第二次导入：两条内容和库里已有的一模一样 → 认作重复，不重复堆', JSON.stringify({ added: again.added, dup: again.duplicates.length, total: again.total }));
const dupOff = L.importPack(other, { write: true, dedupe: false });
ok(dupOff.ok && dupOff.added === 2 && dupOff.total === 6, '关掉去重就照存（用户想留两份也可以）', JSON.stringify({ added: dupOff.added, total: dupOff.total }));

console.log('\n=== 坏文件 / 边界 ===');
ok(L.importPack(null).error, 'null → 报错');
ok(L.importPack({ format: 'something-else', presets: [] }).error, 'format 不对 → 报错', L.importPack({ format: 'x' }).error);
ok(L.importPack({ format: L.FORMAT, version: 99, presets: [mk(1, 'x')] }).error, '版本比工具新 → 报错', L.importPack({ format: L.FORMAT, version: 99, presets: [] }).error);
ok(L.importPack({ format: L.FORMAT, version: 1, presets: [] }).error, '空包 → 报错');
ok(L.save({}).error, '没有 draft 的方案 → 报错');
ok(L.save(null).error, 'null 方案 → 报错');
ok(L.remove('不存在').error, '删不存在的 → 报错');

console.log('\n=== 删除 ===');
const del = L.remove(r1.sid);
ok(del.ok && del.removed === 1 && del.total === 5, '删掉一条', JSON.stringify(del));
ok(!L.list().some((p) => p.sid === r1.sid), '列表里没有了');

console.log('\n=== 库文件本身是给用户看的 JSON ===');
const doc = JSON.parse(fs.readFileSync(L.filePath(), 'utf8'));
ok(doc.format === L.FORMAT && Array.isArray(doc.presets) && doc.presets.length === 5, 'cards.json 结构可读', Object.keys(doc).join(','));
ok(JSON.stringify(doc).includes('data:image/png;base64,AAA'), '带图的方案把原图 base64 存进去了（换台电脑也能复现）');

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n' + (bad === 0 ? '=== LIBRARY TEST PASSED ===' : '=== ' + bad + ' FAILURE(S) ==='));
process.exit(bad === 0 ? 0 : 1);
