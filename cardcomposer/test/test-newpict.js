#!/usr/bin/env node
/*
 * test-newpict.js -- 「凭空造一个新卡面 ID」的单元测试（用临时假包，不碰真包）
 *
 *   · allocateId：跳过已被资源/卡号/目录占用的 ID
 *   · 干跑：真的把包造出来并回读验证，但一个字节都不写进假包
 *   · 真写：新包落盘、version.dat 追加行并重新加密、asset-map 行/计数正确（跳过 Reseal）
 *   · 拒绝：同一个 ID 造两次、RGBA 长度不对
 * 真包上的端到端（客户端下载清单 + 客户端目录 <a>/<b> 行）见 inspect\newpict-e2e.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const N = require('../lib/newpict');

let bad = 0;
const ok = (c, m, d) => { console.log((c ? '  [OK]   ' : '  [FAIL] ') + m + (d ? '  ' + d : '')); if (!c) bad++; };

const REAL_PKG = (process.env.KAIRI_PKG || require('../lib/tools').findPackage());
const TPL_REL = 'resources/patch/card/img/20/006/card_20006000_img.dat';

function makeFake() {
  const root = require('../lib/tmp').dir('newpict');
  const rs = path.join(root, 'resource-set');
  const tplDst = path.join(rs, TPL_REL.split('/').join(path.sep));
  fs.mkdirSync(path.dirname(tplDst), { recursive: true });
  fs.copyFileSync(path.join(REAL_PKG, 'resource-set', TPL_REL.split('/').join(path.sep)), tplDst);
  // version.dat：照真格式造一份小的（<version> + 几行 bundle_ver），加密写回
  const vdLines = ['<version>,790',
    '<bundle_ver>,card/img/20/006/card_20006000_img.dat,0,0372B5AC',
    '<bundle_ver>,misc/title.dat,0,1D6FB901', ''];
  const dec = Buffer.from(vdLines.join('\n'), 'utf8');
  const KEY = [0x01, 0xcd, 0x45, 0x89, 0x67, 0xab, 0x23, 0xef];
  const enc = Buffer.alloc(dec.length);
  for (let i = 0; i < dec.length; i++) enc[i] = (dec[i] + KEY[i % 8]) & 0xff;
  fs.writeFileSync(path.join(rs, 'resources', 'patch', 'version.dat'), enc);
  const map = {
    schema_version: 2, client_profile: 'cn602-bootstrap',
    source: {
      kind: 'x', catalog_version: 790, version_dat_sha256: 'x'.repeat(64),
      patch_roots: ['resources/patch'], versioned_bundle_count: 2, present_versioned_bundle_count: 2,
      missing_versioned_bundle_count: 0, parsed_unity_bundle_count: 2, non_unity_bundle_count: 0,
      selected_bundle_count_by_root: { 'resources/patch': 2 },
      exported_container_asset_count: 1, catalog_asset_count: 1,
      bundle_dependency_edge_count: 0, unresolved_bundle_dependency_count: 0,
      scrambled_bundle_count: 1, plain_bundle_count: 1,
    },
    bundles: [
      { bundle: 'card/img/20/006/card_20006000_img.dat', cab_name: 'cab-a', scrambled: false, delivery_crc32: '0372B5AC', dependencies: [] },
      { bundle: 'misc/title.dat', cab_name: 'cab-b', scrambled: true, delivery_crc32: '1D6FB901', dependencies: [] },
    ],
    assets: [
      { container_path: 'assets/resources/05_image_assets/chr10/20/006/chr10_20006001.pvr', directory: '05_image_assets/chr10/20/006', name: 'chr10_20006001', extension: '.pvr', object_type: 'Texture2D', bundle: 'card/img/20/006/card_20006000_img.dat' },
      { container_path: 'assets/resources/05_image_assets/chr10/99990005/999/chr10_99990005.pvr', directory: 'x', name: 'chr10_99990005', extension: '.pvr', object_type: 'Texture2D', bundle: 'misc/title.dat' },
    ],
    catalog_assets: [
      { container_path: 'assets/resources/05_image_assets/chr10/20/006/chr10_20006001.pvr', directory: '05_image_assets/chr10/20/006', name: 'chr10_20006001', base_dir: '', extension: '.pvr', object_type: 'Texture2D', bundle: 'card/img/20/006/card_20006000_img.dat' },
    ],
  };
  fs.writeFileSync(path.join(rs, 'asset-map.json'), JSON.stringify(map, null, 2) + '\n', 'utf8');
  return { root, mapFile: path.join(rs, 'asset-map.json'), vd: path.join(rs, 'resources', 'patch', 'version.dat') };
}

function flatRgba(w, h, seed) {
  const b = Buffer.alloc(w * h * 4);
  for (let i = 0; i < b.length; i += 4) {
    b[i] = (seed + (i / 4) % 251) & 0xff; b[i + 1] = (seed * 3 + (i / 4) % 97) & 0xff;
    b[i + 2] = (seed * 7 + (i / 4) % 53) & 0xff; b[i + 3] = 255;
  }
  return b;
}

(async () => {
  console.log('=== allocateId ===');
  const f = makeFake();
  // 99990005 被资源占了 → 应该跳过；99990001 没被占 → 用它
  const id0 = N.allocateId(f.root, []);
  ok(id0 === N.ID_FLOOR, '第一个可用 ID = ' + N.ID_FLOOR, String(id0));
  const id1 = N.allocateId(f.root, [N.ID_FLOOR, N.ID_FLOOR + 1]);
  ok(id1 === N.ID_FLOOR + 2, '卡号占用的 ID 也会跳过', String(id1));

  console.log('\n=== 干跑（真造包，但不写假包）===');
  const mapBefore = fs.readFileSync(f.mapFile, 'utf8');
  const vdBefore = fs.readFileSync(f.vd);
  const id = 99990001;
  const dry = N.createPict(f.root, id, {
    chr10: { rgbaBase64: flatRgba(512, 512, 11).toString('base64'), w: 512, h: 512 },
    chr20: { rgbaBase64: flatRgba(256, 256, 22).toString('base64'), w: 256, h: 256 },
    chr51: { pngBase64: Buffer.from('fakepng').toString('base64') },
  }, { write: false });
  ok(!dry.error && dry.dryRun, '干跑成功（包造好并回读验证过）', dry.note || '');
  ok(dry.created.filter(c => c.kind !== 'chr51').every(c => c.verified), '两个纹理包都通过回读验证',
    dry.created.map(c => c.kind + '=' + c.verified).join(' '));
  ok(dry.created.every(c => c.bytes > 0), '包有内容', dry.created.map(c => c.kind + ':' + c.bytes).join(' '));
  ok((dry.compensated || []).join(',') === 'chr10',
    '★ 凭空新建卡面 ID 时，chr10 也会做「cut-in 面板预补偿」（和 artwrite 一致）', JSON.stringify(dry.compensated || []));
  ok(dry.plan.versionDatRows.length === 2 && /chr10\/99\/990\/chr10_99990001\.pvr/.test(dry.plan.assetRows[0]),
    '计划里的容器路径按规约算对了（PictID 99990001 → chr10/99/990）', dry.plan.assetRows.join(' | '));
  ok(fs.readFileSync(f.mapFile, 'utf8') === mapBefore && Buffer.compare(fs.readFileSync(f.vd), vdBefore) === 0,
    '干跑真的没动 asset-map.json 和 version.dat');

  console.log('\n=== 真写（跳过 Reseal）===');
  const wet = N.createPict(f.root, id, {
    chr10: { rgbaBase64: flatRgba(512, 512, 11).toString('base64'), w: 512, h: 512 },
    chr20: { rgbaBase64: flatRgba(256, 256, 22).toString('base64'), w: 256, h: 256 },
    chr51: { pngBase64: Buffer.from('fakepng').toString('base64') },
  }, { write: true, reseal: false });
  ok(!wet.error, '真写成功', wet.note || '');
  for (const rel of ['main_c/image/custom_card_99990001_img.dat', 'main_c/image/custom_card_99990001_icon.dat']) {
    ok(fs.existsSync(path.join(f.root, 'resource-set', 'resources', 'patch', rel.split('/').join(path.sep))), '落盘: ' + rel);
  }
  ok(fs.existsSync(N.chr51Path(f.root, id)), 'chr51 落盘');
  const vdText = N.readVersionDat(f.root);
  ok(vdText.includes('custom_card_99990001_img.dat,0,' + wet.crc.chr10), 'version.dat 追加了 img 行（CRC 正确）', wet.crc.chr10);
  ok(vdText.includes('custom_card_99990001_icon.dat,0,' + wet.crc.chr20), 'version.dat 追加了 icon 行');
  ok(vdText.split('\n').filter(l => l.startsWith('<bundle_ver>')).length === 4, 'version.dat 现在 4 行 bundle');
  const m = JSON.parse(fs.readFileSync(f.mapFile, 'utf8'));
  ok(m.bundles.length === 4 && m.assets.length === 4 && m.catalog_assets.length === 3, 'asset-map 三个数组都加了行',
    m.bundles.length + '/' + m.assets.length + '/' + m.catalog_assets.length);
  ok(m.source.parsed_unity_bundle_count === 4 && m.source.plain_bundle_count === 3 && m.source.scrambled_bundle_count === 1,
    '计数重算正确（原来 1 明文 + 1 加密，加了 2 个明文包）',
    JSON.stringify({ b: m.source.parsed_unity_bundle_count, p: m.source.plain_bundle_count, s: m.source.scrambled_bundle_count }));
  const sha = require('crypto').createHash('sha256').update(fs.readFileSync(f.vd)).digest('hex');
  ok(m.source.version_dat_sha256 === sha, 'version_dat_sha256 跟着更新了');

  console.log('\n=== 边界 / 拒绝 ===');
  const again = N.createPict(f.root, id, {
    chr10: { rgbaBase64: flatRgba(512, 512, 1).toString('base64'), w: 512, h: 512 },
    chr20: { rgbaBase64: flatRgba(256, 256, 1).toString('base64'), w: 256, h: 256 },
  }, { write: false });
  ok(again.error && /已经有这个 PictID/.test(String(again.note)), '同一个 ID 不许造两次', String(again.note));
  const badLen = N.createPict(f.root, 99990002, {
    chr10: { rgbaBase64: Buffer.alloc(100).toString('base64'), w: 512, h: 512 },
    chr20: { rgbaBase64: flatRgba(256, 256, 1).toString('base64'), w: 256, h: 256 },
  }, { write: false });
  ok(badLen.error && /长度不对/.test(String(badLen.note)), 'RGBA 字节数不对时明确报错', String(badLen.note));

  console.log('\n=== 删除自己造的卡面 ID（removePict）===');
  const dryDel = N.removePict(f.root, id, { write: false });
  ok(!dryDel.error && dryDel.cut && dryDel.cut.bundles === 2 && dryDel.versionRowsRemoved === 2,
    '干跑算出要删 2 个包 + 2 行 version.dat', JSON.stringify(dryDel.cut));
  const refus = N.removePict(f.root, 10000182, { write: false });
  ok(refus.error && /只允许删自己新建/.test(String(refus.note)), '不许删官方卡面 ID', String(refus.note));
  const wetDel = N.removePict(f.root, id, { write: true, reseal: false });
  ok(!wetDel.error && wetDel.moved.length === 3, '真删：3 个文件挪到回收站', wetDel.moved.join(', '));
  ok(!fs.existsSync(path.join(f.root, 'resource-set', 'resources', 'patch', 'main_c', 'image', 'custom_card_99990001_img.dat')),
    '包从 patch 目录里挪走了');
  ok(fs.existsSync(path.join(f.root, '_local', 'newpict-removed', 'custom_card_99990001_img.dat')),
    '回收站在包根 _local 下（不在资源集里，客户端看不到）');
  ok(N.readVersionDat(f.root).split('\n').filter(l => l.startsWith('<bundle_ver>')).length === 2, 'version.dat 回到 2 行');
  const mAfter = JSON.parse(fs.readFileSync(f.mapFile, 'utf8'));
  ok(mAfter.bundles.length === 2 && mAfter.assets.length === 2 && mAfter.catalog_assets.length === 1,
    'asset-map 三个数组回到原样', mAfter.bundles.length + '/' + mAfter.assets.length + '/' + mAfter.catalog_assets.length);
  ok(mAfter.source.plain_bundle_count === 1 && mAfter.source.scrambled_bundle_count === 1, '计数也回去了',
    JSON.stringify({ p: mAfter.source.plain_bundle_count, s: mAfter.source.scrambled_bundle_count }));
  const againDel = N.removePict(f.root, id, { write: false });
  ok(!againDel.error && /本来就不存在/.test(String(againDel.note)), '重复删除是安全的空操作', String(againDel.note));

  fs.rmSync(f.root, { recursive: true, force: true });
  console.log('\n' + (bad === 0 ? '=== NEWPICT TEST PASSED ===' : '=== ' + bad + ' FAILURE(S) ==='));
  process.exit(bad === 0 ? 0 : 1);
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
