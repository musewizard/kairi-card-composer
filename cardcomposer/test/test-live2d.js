#!/usr/bin/env node
/*
 * test-live2d.js -- 「关掉一张卡的 Live2D 动态卡面」的单元测试。
 *
 * 用**临时假包**（自己造 asset-map.json + 一个假的 _ext.dat），所以不会碰真包：
 *   · 干跑：一个字节都不改
 *   · 停用：文件挪到 _local/live2d-disabled/、asset-map 里条目没了、计数自动重算
 *   · 恢复：asset-map.json 逐字节回到原样（连数组顺序都不能变）、文件回到 patch 目录
 *   · 依赖它的 bundle 不许动；本来没有 Live2D 的卡会说清楚
 * 真包上的端到端（客户端下载清单里那个 bundle 真的消失/回来）见 inspect\live2d-e2e.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('../lib/live2d');

let bad = 0;
const ok = (c, m, d) => { console.log((c ? '  [OK]   ' : '  [FAIL] ') + m + (d ? '  ' + d : '')); if (!c) bad++; };

function makeFake() {
  const root = require('../lib/tmp').dir('l2');
  const patch = path.join(root, 'resource-set', 'resources', 'patch', 'card', 'ext');
  fs.mkdirSync(patch, { recursive: true });
  const rel = 'card/ext/card_1234_ext.dat';
  fs.writeFileSync(path.join(patch, 'card_1234_ext.dat'), Buffer.from('FAKE BUNDLE BYTES'));
  fs.writeFileSync(path.join(patch, 'card_5678_ext.dat'), Buffer.from('OTHER BUNDLE'));
  const map = {
    schema_version: 2,
    client_profile: 'cn602-bootstrap',
    source: {
      // 键的顺序照真文件抄一份：recomputeCounts 只改值不动顺序，
      // 所以恢复后必须能逐字节还原（真包上 inspect\live2d-e2e.js 也是这么验的）
      kind: 'cn602-ordered-unity-assetbundle-container-table',
      catalog_version: 790,
      version_dat_sha256: 'x'.repeat(64),
      patch_roots: ['resources/patch'],
      versioned_bundle_count: 3,
      present_versioned_bundle_count: 3,
      missing_versioned_bundle_count: 0,
      parsed_unity_bundle_count: 3,
      non_unity_bundle_count: 0,
      selected_bundle_count_by_root: { 'resources/patch': 3 },
      exported_container_asset_count: 2,
      catalog_asset_count: 3,
      bundle_dependency_edge_count: 0,
      unresolved_bundle_dependency_count: 0,
      scrambled_bundle_count: 2,
      plain_bundle_count: 1,
    },
    bundles: [
      { bundle: 'card/ext/card_1234_ext.dat', cab_name: 'cab-a', scrambled: true, delivery_crc32: 'AAAAAAAA', dependencies: [] },
      { bundle: 'card/ext/card_5678_ext.dat', cab_name: 'cab-b', scrambled: false, delivery_crc32: 'BBBBBBBB', dependencies: [] },
      { bundle: 'main_c/image/x.dat', cab_name: 'cab-c', scrambled: true, delivery_crc32: 'CCCCCCCC', dependencies: [] },
    ],
    assets: [
      { container_path: 'assets/resources/live2d/card_1234/body.model.json.bytes', directory: 'live2d/card_1234', name: 'body.model.json', extension: '.bytes', object_type: 'TextAsset', bundle: rel },
      { container_path: 'assets/resources/live2d/card_1234/moc/model.moc.bytes', directory: 'live2d/card_1234/moc', name: 'model.moc', extension: '.bytes', object_type: 'TextAsset', bundle: rel },
    ],
    catalog_assets: [
      { container_path: 'assets/resources/live2d/card_1234/body.model.json.bytes', directory: 'live2d/card_1234', name: 'body.model.json', base_dir: '', extension: '.bytes', object_type: 'TextAsset', bundle: rel },
      { container_path: 'assets/resources/live2d/card_1234/moc/model.moc.bytes', directory: 'live2d/card_1234/moc', name: 'model.moc', base_dir: '', extension: '.bytes', object_type: 'TextAsset', bundle: rel },
      { container_path: 'assets/resources/05_image_assets/chr10/x.pvr', directory: '05_image_assets/chr10', name: 'chr10_x', base_dir: '', extension: '.pvr', object_type: 'Texture2D', bundle: 'main_c/image/x.dat' },
    ],
  };
  fs.writeFileSync(path.join(root, 'resource-set', 'asset-map.json'), JSON.stringify(map, null, 2) + '\n', 'utf8');
  return { root, rel, mapFile: path.join(root, 'resource-set', 'asset-map.json') };
}

(function () {
  console.log('=== 起始状态 ===');
  const f = makeFake();
  L.invalidate();
  const map0 = fs.readFileSync(f.mapFile, 'utf8');
  const i0 = L.info(f.root, 1234);
  ok(i0.state === 'on' && i0.assetCount === 2 && i0.catalogAssetCount === 2 && i0.scrambled === true,
    '识别出「动态卡面」和它的资源行', i0.state + '/' + i0.assetCount + '/' + i0.catalogAssetCount);
  ok(L.info(f.root, 9999).state === 'none', '没有 Live2D 的卡报 none');

  console.log('\n=== 干跑（不写盘）===');
  const dry = L.setEnabled(f.root, 1234, false, { write: false });
  ok(!dry.error && dry.cut && dry.cut.assets === 2 && dry.cut.catalogAssets === 2,
    '干跑算出要摘掉 1 个 bundle + 2 个 asset 行 + 2 个 catalog 行',
    JSON.stringify(dry.cut && { bundle: !!dry.cut.bundle, assets: dry.cut.assets, catalog: dry.cut.catalogAssets }));
  ok(dry.counters.bundles === 2 && dry.counters.scrambled === 1 && dry.counters.plain === 1,
    '干跑算出新的计数（bundle 3→2、scrambled 2→1）', JSON.stringify(dry.counters));
  ok(fs.readFileSync(f.mapFile, 'utf8') === map0 && fs.existsSync(L.bundleAbs(f.root, 1234)),
    '干跑真的一个字节都没改');

  console.log('\n=== 停用 ===');
  const off = L.setEnabled(f.root, 1234, false, { write: true, reseal: false });
  ok(!off.error, '停用没有报错', off.note || '');
  ok(!fs.existsSync(L.bundleAbs(f.root, 1234)), 'patch 目录里那个 _ext.dat 已经挪走');
  ok(fs.existsSync(L.backupAbs(f.root, 1234)), '备份出现在 _local/live2d-disabled/');
  ok(fs.existsSync(L.sidecarAbs(f.root, 1234)), 'sidecar（原条目）已保存，方便还原');
  L.invalidate();
  const i1 = L.info(f.root, 1234);
  ok(i1.state === 'off' && !i1.listedInMap && i1.assetCount === 0, 'asset-map 里它的条目没了', i1.state);
  const m1 = JSON.parse(fs.readFileSync(f.mapFile, 'utf8'));
  ok(m1.bundles.length === 2 && m1.assets.length === 0 && m1.catalog_assets.length === 1, '三个数组都少了对应的行',
    m1.bundles.length + '/' + m1.assets.length + '/' + m1.catalog_assets.length);
  ok(m1.source.parsed_unity_bundle_count === 2 && m1.source.scrambled_bundle_count === 1 &&
     m1.source.plain_bundle_count === 1 && m1.source.exported_container_asset_count === 0 &&
     m1.source.catalog_asset_count === 1 && m1.source.bundle_dependency_edge_count === 0,
    '★ 计数全部自动重算（服务端 asset_map.go 会逐条校验这些）', JSON.stringify(m1.source));
  ok(L.listCards(f.root).off.includes(1234) && !L.listCards(f.root).live.includes(1234), 'listCards 把它算进「已停用」');

  console.log('\n=== 恢复 ===');
  const on = L.setEnabled(f.root, 1234, true, { write: true, reseal: false });
  ok(!on.error, '恢复没有报错', on.note || '');
  ok(fs.existsSync(L.bundleAbs(f.root, 1234)) && !fs.existsSync(L.backupAbs(f.root, 1234)), 'bundle 挪回 patch 目录');
  ok(fs.readFileSync(L.bundleAbs(f.root, 1234), 'utf8') === 'FAKE BUNDLE BYTES', 'bundle 内容一个字节没变');
  ok(!fs.existsSync(L.sidecarAbs(f.root, 1234)), 'sidecar 用完就删了');
  L.invalidate();
  ok(L.info(f.root, 1234).state === 'on', '状态回到「动态卡面」');
  ok(fs.readFileSync(f.mapFile, 'utf8') === map0, '★ asset-map.json 逐字节回到原样（连数组顺序都不变）');

  console.log('\n=== 边界情况 ===');
  const dry2 = L.setEnabled(f.root, 9999, false, { write: false });
  ok(!dry2.error && /没有 Live2D/.test(String(dry2.note)), '本来没有 Live2D 的卡给出明确说明', String(dry2.note));
  const dry3 = L.setEnabled(f.root, 1234, true, { write: false });
  ok(!dry3.error && /本来就是动态卡面/.test(String(dry3.note)), '已经是动态卡面时「启用」是空操作', String(dry3.note));
  const dry4 = L.setEnabled(f.root, 1234, false, { write: false });
  ok(!dry4.error, '正常卡可以停用');

  // 依赖保护：让别的 bundle 依赖它
  const m = JSON.parse(fs.readFileSync(f.mapFile, 'utf8'));
  m.bundles[0].dependencies = ['card/ext/card_1234_ext.dat'];
  m.source.bundle_dependency_edge_count = 1;
  fs.writeFileSync(f.mapFile, JSON.stringify(m, null, 2) + '\n', 'utf8');
  L.invalidate();
  const dep = L.setEnabled(f.root, 1234, false, { write: false });
  ok(dep.error && /依赖/.test(String(dep.note)), '有别的 bundle 依赖它时拒绝动手（不会把服务端搞崩）', String(dep.note));

  fs.rmSync(f.root, { recursive: true, force: true });
  console.log('\n' + (bad === 0 ? '=== LIVE2D TEST PASSED ===' : '=== ' + bad + ' FAILURE(S) ==='));
  process.exit(bad === 0 ? 0 : 1);
})();
