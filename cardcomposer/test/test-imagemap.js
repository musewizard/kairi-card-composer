#!/usr/bin/env node
/*
 * test-imagemap.js -- 放大立绘图片清单（resources/image/manifest.json）的单元测试
 *
 * 这块东西存在的唯一理由：客户端要的放大立绘走 HTTP 图片服务，而服务端**只提供清单
 * 里登记过的文件**，且启动时逐条校验 bytes/sha256。清单漏了这张图 → 客户端观赏大图
 * 全白；清单和磁盘不一致 → 整个资源集起不来。所以这里重点测「登记 / 撤下 / 对账」。
 */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const IM = require('../lib/imagemap');
const { encodePng } = require('../lib/png');

let bad = 0;
const ok = (c, m, d) => { console.log((c ? '  [OK]   ' : '  [FAIL] ') + m + (d ? '  ' + d : '')); if (!c) bad++; };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function fakePkg() {
  const root = require('../lib/tmp').dir('imagemap');
  fs.mkdirSync(IM.chr51Dir(root), { recursive: true });
  return root;
}
function putPng(root, id, w, h, color, extra) {
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < rgba.length; i += 4) { rgba[i] = color; rgba[i + 1] = color + 1; rgba[i + 2] = color + 2; rgba[i + 3] = 255; }
  if (extra) extra(rgba);
  const png = encodePng(rgba, w, h, 6);
  const abs = path.join(IM.chr51Dir(root), 'chr51_' + id + '.png');
  fs.writeFileSync(abs, png);
  return { abs, png, bytes: png.length, sha: sha(png) };
}

console.log('=== 第一次登记（空清单）===');
const root = fakePkg();
const a = putPng(root, 99990221, 8, 8, 10);
const b = putPng(root, 10000010, 6, 6, 20);
const r1 = IM.syncImageManifest(root, { write: true });
ok(r1.total === 2 && r1.added.length === 2, '两张都登记进去了', JSON.stringify(r1));
ok(r1.wrote && r1.changed, '真的写了清单');
const man1 = JSON.parse(fs.readFileSync(IM.manifestPath(root), 'utf8'));
ok(man1.schema_version === 1 && man1.files.length === 2, 'schema_version=1，files 两条');
const e0 = man1.files.find(f => f.path === 'chr51/chr51_99990221.png');
ok(e0 && e0.bytes === a.bytes && e0.sha256 === a.sha, '登记的字节数/sha256 和磁盘一致',
  e0 ? e0.bytes + ' / ' + e0.sha256.slice(0, 12) : '(没这条)');
ok(man1.files.every(f => /^chr51\/chr51_[0-9]{8}\.png$/.test(f.path)), '路径符合服务端的正则（8 位数字 ID）');
ok(IM.checkImageManifest(root).length === 0, '体检通过（服务端能启动）');
ok(IM.pendingChr51(root).length === 0, '对账：没有不一致');

console.log('\n=== 幂等：再同步一次不该有任何变化 ===');
const before = fs.readFileSync(IM.manifestPath(root));
const r2 = IM.syncImageManifest(root, { write: true });
ok(!r2.changed && !r2.wrote, '第二次同步：changed=false', JSON.stringify({ changed: r2.changed, rehash: r2.rehashed.length, kept: r2.kept }));
ok(fs.readFileSync(IM.manifestPath(root)).equals(before), '清单文件一个字节都没动');
ok(IM.namespaceOf(root) === r2.namespaceAfter, 'namespace = sha256(清单) 前 16 字节', String(IM.namespaceOf(root)));

console.log('\n=== 改了图（同尺寸、不同内容）必须靠 force 才发现 ===');
// 同尺寸换内容：不 force 会沿用旧 sha（为了不每次重算 4300 张图），force 才重算
// 直接改原文里的一个字节：字节数一定不变，sha 一定变（清单本身不校验 PNG 能不能解码）
const tampered = Buffer.from(fs.readFileSync(a.abs));
tampered[Math.floor(tampered.length / 2)] ^= 0xff;
fs.writeFileSync(a.abs, tampered);
const c2 = { bytes: tampered.length, sha: sha(tampered) };
ok(c2.bytes === a.bytes && c2.sha !== a.sha, '故意造成「字节数一样、内容不一样」', c2.bytes + ' 字节');
const lazy = IM.syncImageManifest(root, { write: false });
ok(!lazy.changed, '不 force 时按大小沿用旧 sha（性能设计，符合预期）');
const forced = IM.syncImageManifest(root, { write: true, force: [99990221] });
ok(forced.changed && forced.updated.includes(99990221), 'force 之后发现内容变了', JSON.stringify(forced.updated));
const man2 = JSON.parse(fs.readFileSync(IM.manifestPath(root), 'utf8'));
ok(man2.files.find(f => f.path.endsWith('99990221.png')).sha256 === c2.sha, '清单里的 sha256 更新成新内容');
ok(IM.namespaceOf(root) !== r2.namespaceAfter, '★ namespace 跟着变了 → 客户端会重新下载这个 URL');
const verifyAll = IM.syncImageManifest(root, { write: false, verify: true });
ok(!verifyAll.changed && verifyAll.rehashed.length === 2, 'verify 模式全量重算也对得上（清单没漂）');

console.log('\n=== 新 ID 出现 / 图被删掉 ===');
const d = putPng(root, 99990222, 5, 5, 30);
const r3 = IM.syncImageManifest(root, { write: true });
ok(r3.added.includes(99990222) && r3.total === 3, '新 ID 自动登记', JSON.stringify(r3.added));
fs.unlinkSync(d.abs);
const r4 = IM.syncImageManifest(root, { write: true });
ok(r4.removed.includes('chr51/chr51_99990222.png') && r4.total === 2, '图没了就从清单里摘掉（不然服务端起不来）', JSON.stringify(r4.removed));

console.log('\n=== 对账 / 体检能抓到真实会出事的两种状态 ===');
const e = putPng(root, 99990223, 4, 4, 40);
ok(IM.pendingChr51(root).some(p => p.pictId === 99990223), 'pendingChr51 抓到「磁盘上有、清单没登记」（客户端 404 的成因）');
fs.writeFileSync(IM.manifestPath(root), JSON.stringify({ schema_version: 1, files: [
  { path: 'chr51/chr51_99990223.png', bytes: 12345, sha256: e.sha },
  { path: 'chr51/chr51_99999999.png', bytes: 10, sha256: 'a'.repeat(64) },
  { path: 'chr51/chr51_123.png', bytes: 10, sha256: 'b'.repeat(64) },
  { path: 'chr51/chr51_99990221.png', bytes: 1, sha256: 'nothex' },
] }, null, 2));
const probs = IM.checkImageManifest(root);
ok(probs.some(p => /字节数不一致/.test(p.problem)), '抓到字节数不一致');
ok(probs.some(p => /磁盘上没这个文件/.test(p.problem)), '抓到清单里有、磁盘上没有');
ok(probs.some(p => /路径不合规/.test(p.problem)), '抓到不合规路径（非 8 位 ID）');
ok(probs.some(p => /sha256 不是/.test(p.problem)), '抓到 sha256 不是 64 位十六进制');
ok(IM.pendingChr51(root).some(p => /字节数清单/.test(p.problem)), 'pendingChr51 也能抓到字节数不一致');
const fixed = IM.syncImageManifest(root, { write: true, verify: true });
ok(fixed.removed.length === 2 && fixed.updated.length === 2 && fixed.added.length === 1,
  '一次同步把毛病都治好（摘掉幽灵/不合规、重算对不上的、补登缺的）',
  JSON.stringify({ added: fixed.added, updated: fixed.updated, removed: fixed.removed }));
ok(IM.checkImageManifest(root).length === 0, '治完以后体检又是 OK');

console.log('\n=== 不认的文件名要被点名，不能偷偷塞进清单 ===');
fs.writeFileSync(path.join(IM.chr51Dir(root), 'chr51_123.png'), e.png);
fs.writeFileSync(path.join(IM.chr51Dir(root), 'chr51_99990224.png.bak'), e.png);
const r5 = IM.syncImageManifest(root, { write: true });
ok(r5.ignored.length === 2 && r5.total === 3, '只登记 3 张合法的（10000010 / 99990221 / 99990223）',
  '去掉 99990222 之后剩 ' + r5.total + ' 张，忽略 ' + JSON.stringify(r5.ignored.map(i => i.name)));
ok(r5.ignored.every(i => /8位数字/.test(i.reason)), '被忽略的文件都给出了原因');
ok(IM.checkImageManifest(root).length === 0, '清单依旧健康');

console.log('\n=== 空目录 / 目录不存在也不能崩 ===');
const empty = fakePkg();
const r6 = IM.syncImageManifest(empty, { write: true });
ok(r6.total === 0 && r6.changed, '空目录 → 写一个 files: [] （服务端会拒绝启动，但这里不该抛异常）');
const ghost = path.join(os.tmpdir(), 'imagemap-ghost-' + Date.now());
ok(IM.listChr51(ghost).files.length === 0 && IM.readManifest(ghost) === null, '目录根本不存在时返回空');

fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(empty, { recursive: true, force: true });
console.log('\n' + (bad === 0 ? '=== IMAGEMAP TEST PASSED ===' : '=== ' + bad + ' FAILURE(S) ==='));
process.exit(bad === 0 ? 0 : 1);
