'use strict';
/*
 * live2d.js -- 「这张卡在游戏里是 Live2D 动态卡面吗？能不能关掉改成静态图？」
 *
 * 事实（2026-09-23 查证，见 HOW-TO-MAKE-A-CARD.md 第十六节）：
 *   · 只有 180 张卡有 Live2D 卡面模型，资源在
 *       resource-set/resources/patch/card/ext/card_<卡号>_ext.dat
 *     里面 4 个东西：body.model.json / moc/model.moc / moc/texture.2048/texture_00.png / mtn/idle.mtn
 *   · 其中 179 个包是 **CN 加密** 的（改不了模型本身），而且跟卡面静态图 chr10 不是一套资源。
 *   · 客户端这么找模型：`Live2D/Card_{0:D8}/body.model.json.bytes`
 *     —— 它**不读** asset-map.json / resource-set.json（DLL 里一个字符串都没有），
 *     它读服务器**现算**出来的补丁目录 `<patch>/Android/patch/catalog.dat`。
 *
 * ★ 关键点（这条让「关掉 Live2D」变得可行）：
 *   `source/server/internal/cnbootstrap/resource_catalog.go` 里 buildCN602Catalog()
 *   是拿 version.dat 的行 **∩ 磁盘上真实存在的 bundle** 生成目录的
 *   （`findCNPatchFile` 找不到就 `continue`），资产行 `<a>` 全部来自 asset-map.json。
 *   所以：把某个 `card_<卡号>_ext.dat` 从包里的 patch 目录**挪走** +
 *   把 asset-map.json 里它的 bundle/asset 条目删掉，
 *   客户端拿到的目录里就**没有这个卡号的 Live2D 了** —— 跟那些本来就没有 Live2D 的
 *   四千多张 MMR 卡一模一样 ⇒ 客户端老老实实回退到静态卡面 chr10。
 *   而且 asset_map.go 的 loadCNAssetMap() 有一堆严格校验
 *   （bundle 条数必须等于磁盘上存在的 bundle 数、scrambled+plain 要对得上、
 *     依赖边数要对得上…），所以删条目必须**同时改那些计数**，否则服务端直接起不来。
 *
 * 停用 = 挪文件 + 删条目 + 改计数 + Reseal；启用 = 反过来（sidecar 里存了原始条目）。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TOOLS = require('./tools').toolsRoot();
const RESEAL = path.join(TOOLS, 'reseal', 'bin', 'Release', 'net8.0', 'Reseal.exe');

const REL_PREFIX = 'card/ext/';

/** 这个卡号的 Live2D bundle 相对路径 */
function bundleRel(cardId) { return REL_PREFIX + 'card_' + Number(cardId) + '_ext.dat'; }
function patchRootAbs(pkgRoot) { return path.join(pkgRoot, 'resource-set', 'resources', 'patch'); }
function bundleAbs(pkgRoot, cardId) { return path.join(patchRootAbs(pkgRoot), bundleRel(cardId).split('/').join(path.sep)); }
function backupDir(pkgRoot) { return path.join(pkgRoot, '_local', 'live2d-disabled'); }
function backupAbs(pkgRoot, cardId) { return path.join(backupDir(pkgRoot), 'card_' + Number(cardId) + '_ext.dat'); }
function sidecarAbs(pkgRoot, cardId) { return path.join(backupDir(pkgRoot), 'card_' + Number(cardId) + '_ext.json'); }
function mapPath(pkgRoot) { return path.join(pkgRoot, 'resource-set', 'asset-map.json'); }

// asset-map.json 有 52 MB：每次请求都 parse 一遍太慢（一个 info 请求要查 4 张卡）。
// 按「文件 mtime + 大小」缓存，文件被改过就自动重读。
const mapCache = new Map();
function readMap(pkgRoot) {
  const p = mapPath(pkgRoot);
  const st = fs.statSync(p);
  const key = p;
  const hit = mapCache.get(key);
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.parsed;
  const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  mapCache.set(key, { mtime: st.mtimeMs, size: st.size, parsed });
  return parsed;
}
function invalidate(pkgRoot) { if (pkgRoot) mapCache.delete(mapPath(pkgRoot)); else mapCache.clear(); }

/** 包里有 Live2D 卡面模型的「现役」卡号 + 已经被我们停用的卡号 */
function listCards(pkgRoot, map) {
  const m = map || readMap(pkgRoot);
  const live = [], off = [];
  for (const b of (m.bundles || [])) {
    const mm = new RegExp('^' + REL_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + 'card_(\\d+)_ext\\.dat$').exec(b.bundle || '');
    if (mm) live.push(Number(mm[1]));
  }
  const dir = backupDir(pkgRoot);
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      const mm = /^card_(\d+)_ext\.dat$/.exec(f);
      if (mm) off.push(Number(mm[1]));
    }
  }
  live.sort((a, b) => a - b); off.sort((a, b) => a - b);
  return { live, off, all: new Set([...live, ...off]) };
}

/** 一个卡号的 Live2D 状态 */
function info(pkgRoot, cardId, map) {
  const id = Number(cardId);
  const rel = bundleRel(id);
  const m = map || readMap(pkgRoot);
  const bundle = (m.bundles || []).find(b => b.bundle === rel) || null;
  const assets = (m.assets || []).filter(a => a.bundle === rel);
  const catalogAssets = (m.catalog_assets || []).filter(a => a.bundle === rel);
  const dependents = (m.bundles || []).filter(b => (b.dependencies || []).includes(rel)).map(b => b.bundle);
  const abs = bundleAbs(pkgRoot, id);
  const bak = backupAbs(pkgRoot, id);
  const onDisk = fs.existsSync(abs);
  const hasBackup = fs.existsSync(bak);
  const state = onDisk ? 'on' : (hasBackup ? 'off' : (bundle ? 'broken' : 'none'));
  return {
    cardId: id, bundle: rel, state,
    listedInMap: !!bundle, onDisk, hasBackup,
    scrambled: bundle ? !!bundle.scrambled : null,
    assetCount: assets.length, catalogAssetCount: catalogAssets.length,
    assetPaths: assets.map(a => a.container_path),
    onDiskBytes: onDisk ? fs.statSync(abs).size : null,
    backupBytes: hasBackup ? fs.statSync(bak).size : null,
    backupFile: hasBackup ? path.relative(pkgRoot, bak) : null,
    dependents,
  };
}

/** 从数组重新算 asset-map 里那几个必须自洽的计数（asset_map.go 会逐条校验） */
function recomputeCounts(m) {
  const src = m.source || (m.source = {});
  const bundles = m.bundles || [];
  const assets = m.assets || [];
  const catalog = m.catalog_assets || [];
  let edges = 0;
  for (const b of bundles) edges += (b.dependencies || []).length;
  src.parsed_unity_bundle_count = bundles.length;
  src.present_versioned_bundle_count = bundles.length;
  src.scrambled_bundle_count = bundles.filter(b => b.scrambled).length;
  src.plain_bundle_count = bundles.filter(b => !b.scrambled).length;
  src.bundle_dependency_edge_count = edges;
  src.unresolved_bundle_dependency_count = 0;
  src.exported_container_asset_count = assets.length;
  src.catalog_asset_count = catalog.length;
  return src;
}

/** 把某个 bundle 从 asset-map 里摘出来（带原位置，方便原样还原） */
function cutBundle(m, rel) {
  const idx = (m.bundles || []).findIndex(b => b.bundle === rel);
  const bundle = idx >= 0 ? m.bundles.splice(idx, 1)[0] : null;
  const assets = [];
  const catalogAssets = [];
  const notes = [];
  (m.assets || []).forEach((a, i) => { if (a.bundle === rel) notes.push({ i, a }); });
  notes.reverse().forEach(({ i, a }) => { m.assets.splice(i, 1); assets.unshift({ at: i, row: a }); });
  const notes2 = [];
  (m.catalog_assets || []).forEach((a, i) => { if (a.bundle === rel) notes2.push({ i, a }); });
  notes2.reverse().forEach(({ i, a }) => { m.catalog_assets.splice(i, 1); catalogAssets.unshift({ at: i, row: a }); });
  return { bundle, bundleAt: idx, assets, catalogAssets };
}

/** 按原位置放回去（这样还原后的 asset-map.json 和原来逐字节一样） */
function pasteBundle(m, cut) {
  if (cut.bundle) m.bundles.splice(Math.min(cut.bundleAt == null ? m.bundles.length : cut.bundleAt, m.bundles.length), 0, cut.bundle);
  for (const e of (cut.assets || [])) {
    const row = e.row || e;                       // 兼容旧 sidecar（没有 at/row 结构）
    m.assets.splice(Math.min(e.at == null ? m.assets.length : e.at, m.assets.length), 0, row);
  }
  for (const e of (cut.catalogAssets || [])) {
    const row = e.row || e;
    m.catalog_assets.splice(Math.min(e.at == null ? m.catalog_assets.length : e.at, m.catalog_assets.length), 0, row);
  }
}

/**
 * 打开/关闭一张卡的 Live2D 卡面。
 * @param enabled true = 恢复成动态卡面；false = 停用（改成静态图）
 * @param opts {write:boolean, log:fn}
 */
function setEnabled(pkgRoot, cardId, enabled, opts) {
  const o = opts || {};
  const log = o.log || (() => {});
  const id = Number(cardId);
  const rel = bundleRel(id);
  invalidate(pkgRoot);
  const before = info(pkgRoot, id);
  const out = { cardId: id, bundle: rel, action: enabled ? 'enable' : 'disable', before, changed: [], reseal: null };

  if (enabled) {
    if (before.state === 'on') { out.note = '本来就是动态卡面（bundle 在包里），不用改'; return out; }
    if (!before.hasBackup) { out.note = '没找到被停用的备份文件，没法恢复'; out.error = true; return out; }
  } else {
    if (before.state === 'none') { out.note = '这张卡本来就没有 Live2D 卡面模型（就是静态图），不用关'; return out; }
    if (before.state === 'off') { out.note = '已经关掉了'; return out; }
    if (before.dependents.length) {
      out.note = '别的 bundle 依赖它（' + before.dependents.join('、') + '），不能动'; out.error = true; return out;
    }
  }

  const m = readMap(pkgRoot);
  const sidecar = sidecarAbs(pkgRoot, id);
  const bak = backupAbs(pkgRoot, id);
  const abs = bundleAbs(pkgRoot, id);

  if (!enabled) {
    const cut = cutBundle(m, rel);
    if (!cut.bundle) { out.note = 'asset-map 里没有这个 bundle，状态不正常'; out.error = true; return out; }
    recomputeCounts(m);
    out.cut = { bundle: cut.bundle, assets: cut.assets.length, catalogAssets: cut.catalogAssets.length };
    out.counters = { bundles: m.source.parsed_unity_bundle_count, scrambled: m.source.scrambled_bundle_count, plain: m.source.plain_bundle_count, edges: m.source.bundle_dependency_edge_count };
    if (o.write) {
      fs.mkdirSync(backupDir(pkgRoot), { recursive: true });
      fs.writeFileSync(sidecar, JSON.stringify(cut, null, 2), 'utf8');
      if (before.onDisk) { fs.renameSync(abs, bak); out.changed.push('resources/patch/' + rel); log('挪走 ' + rel + ' → ' + path.relative(pkgRoot, bak)); }
      fs.writeFileSync(mapPath(pkgRoot), JSON.stringify(m, null, 2) + '\n', 'utf8');
      out.changed.push('asset-map.json');
      log('asset-map.json 里删掉了 ' + cut.assets.length + ' 个 asset 行 / ' + cut.catalogAssets.length + ' 个 catalog 行');
    }
  } else {
    const cut = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    pasteBundle(m, cut);
    recomputeCounts(m);
    out.pasted = { bundle: !!cut.bundle, assets: (cut.assets || []).length, catalogAssets: (cut.catalogAssets || []).length };
    out.counters = { bundles: m.source.parsed_unity_bundle_count, scrambled: m.source.scrambled_bundle_count, plain: m.source.plain_bundle_count, edges: m.source.bundle_dependency_edge_count };
    if (o.write) {
      if (fs.existsSync(bak)) { fs.renameSync(bak, abs); out.changed.push('resources/patch/' + rel); log('挪回来 ' + rel); }
      fs.writeFileSync(mapPath(pkgRoot), JSON.stringify(m, null, 2) + '\n', 'utf8');
      out.changed.push('asset-map.json');
      fs.unlinkSync(sidecar);
    }
  }

  if (o.write && out.changed.length && o.reseal !== false) {
    log('重签（' + out.changed.length + ' 个文件）…');
    const args = [pkgRoot];
    for (const rel2 of out.changed) args.push('--changed', rel2);
    const txt = execFileSync(RESEAL, args, { encoding: 'utf8' });
    out.reseal = txt.trim().split(/\r?\n/).filter(Boolean).slice(-4).join(' | ');
    log(out.reseal);
  }
  invalidate(pkgRoot);                      // 文件刚改过，缓存作废
  out.after = o.write ? info(pkgRoot, id) : null;
  return out;
}

module.exports = { info, listCards, setEnabled, bundleRel, bundleAbs, backupDir, backupAbs, sidecarAbs, mapPath, recomputeCounts, invalidate };
