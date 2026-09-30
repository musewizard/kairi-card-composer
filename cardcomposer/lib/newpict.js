'use strict';
/*
 * newpict.js -- 给「全新的卡面 ID」凭空造资源（不碰任何现有卡）
 *
 * 背景：客户端按 PictID 去资源包里找三张图：
 *   chr10_<PictID>  卡面大图 512×512，在 bundle 里
 *   chr20_<PictID>  小图     256×256，在 bundle 里
 *   chr51_<PictID>.png 放大立绘，普通文件
 * 全新 PictID 的三张图在包里根本不存在 ⇒ 以前只能用「借」现成 ID 的办法。
 *
 * 这里走的是「自己造一个**明文**包并登记进目录」的路子（2026-09-23 打通）：
 *   1. 复制一个模板明文包（card/img/20/006/card_20006000_img.dat，里面只有一张 512×512 纹理），
 *      把里面那张纹理改名为 chr10_<新ID>（或 chr20）、写入你的像素、把 AssetBundle 的
 *      m_Container 容器路径改成规约路径、换一个新 cab 名 → 得到属于新 ID 的包
 *      （BundleTool make-card-bundle，会自己读回来验证名字/容器路径/像素）
 *   2. 新包放进 resources/patch/main_c/image/，往 version.dat（就是那个「减一下」加密的目录）
 *      追加一行 <bundle_ver>,<路径>,0,<CRC32>，再加密写回
 *   3. asset-map.json 里加 bundle 行 + asset 行（assets 和 catalog_assets 都要），
 *      并重算 asset_map.go 会逐条校验的那些计数（bundle 数 / scrambled+plain / 依赖边…），
 *      更新 version_dat_sha256
 *   4. chr51_<新ID>.png 直接写文件（普通资源）
 *   5. Reseal 重签（resource-set.json / release-manifest.json）
 *
 * 客户端那边认不认？—— 它读的就是服务器用 buildCN602Catalog() 现算的 catalog.dat，
 * 而 `<a>` 资产行全部来自 asset-map.json、`<b>` 包行来自「version.dat ∩ 磁盘上存在的包」。
 * 所以只要上面登记对了，客户端就能拿到这三张图（明文包它本来就支持：1130 个明文包）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const TOOLS = require('./tools').toolsRoot();
const BUNDLE_TOOL = path.join(TOOLS, 'bundle-tool', 'bin', 'Release', 'net8.0', 'BundleTool.exe');
const RESEAL = path.join(TOOLS, 'reseal', 'bin', 'Release', 'net8.0', 'Reseal.exe');
const imagemap = require('./imagemap');
const AW = require('./artwrite');

// 模板：一个只有单张 512×512 纹理的**明文**包（改大小就能当 chr20 用）
const TEMPLATE = {
  rel: 'card/img/20/006/card_20006000_img.dat',
  texName: 'chr10_20006001',
};
// 新 PictID 从这里往上取
const ID_FLOOR = 99990001;
const ID_CEIL = 99999999;
const SCRAMBLE_KEY = [0x01, 0xcd, 0x45, 0x89, 0x67, 0xab, 0x23, 0xef];

function mapPath(pkgRoot) { return path.join(pkgRoot, 'resource-set', 'asset-map.json'); }
function patchRoot(pkgRoot) { return path.join(pkgRoot, 'resource-set', 'resources', 'patch'); }
function versionDatPath(pkgRoot) { return path.join(patchRoot(pkgRoot), 'version.dat'); }
function templatePath(pkgRoot) { return path.join(patchRoot(pkgRoot), TEMPLATE.rel.split('/').join(path.sep)); }
function chr51Path(pkgRoot, pictId) {
  return path.join(pkgRoot, 'resource-set', 'resources', 'image', 'chr51', 'chr51_' + Number(pictId) + '.png');
}

let CRC_T = null;
function crc32Hex(buf) {
  if (!CRC_T) {
    CRC_T = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_T[n] = c; }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ((c ^ -1) >>> 0).toString(16).toUpperCase().padStart(8, '0');
}
function sha256File(p) { return require('crypto').createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }

/** version.dat：减密钥解密 / 加密钥加密（source/server/internal/cnbootstrap 里的 cn602ScrambleKey） */
function readVersionDat(pkgRoot) {
  const enc = fs.readFileSync(versionDatPath(pkgRoot));
  const dec = Buffer.alloc(enc.length);
  for (let i = 0; i < enc.length; i++) dec[i] = (enc[i] - SCRAMBLE_KEY[i % 8]) & 0xff;
  return dec.toString('utf8');
}
function writeVersionDat(pkgRoot, text) {
  const dec = Buffer.from(text, 'utf8');
  const enc = Buffer.alloc(dec.length);
  for (let i = 0; i < dec.length; i++) enc[i] = (dec[i] + SCRAMBLE_KEY[i % 8]) & 0xff;
  fs.writeFileSync(versionDatPath(pkgRoot), enc);
}

/** 规约容器路径：assets/resources/05_image_assets/chr10/<id/1e6>/<(id/1e3)%1e3 三位>/<名字>.pvr */
function containerPathFor(kind, pictId) {
  const id = Number(pictId);
  const a = Math.floor(id / 1000000);
  const b = String(Math.floor(id / 1000) % 1000).padStart(3, '0');
  const name = kind + '_' + id;
  return 'assets/resources/05_image_assets/' + kind + '/' + a + '/' + b + '/' + name + '.pvr';
}
function bundleRelFor(kind, pictId) {
  return 'main_c/image/custom_card_' + Number(pictId) + (kind === 'chr10' ? '_img.dat' : '_icon.dat');
}
function cabNameFor(kind, pictId) {
  const h = require('crypto').createHash('md5').update(kind + ':' + pictId).digest('hex');
  return 'CAB-' + h;
}

function readMap(pkgRoot) { return JSON.parse(fs.readFileSync(mapPath(pkgRoot), 'utf8')); }

/** 找一个没被任何卡/任何资源占用的新 PictID */
function allocateId(pkgRoot, cardIds) {
  const m = readMap(pkgRoot);
  const used = new Set();
  for (const a of (m.assets || [])) {
    const mm = /^chr\d+_(\d+)$/.exec(a.name || '');
    if (mm) used.add(Number(mm[1]));
  }
  for (const id of (cardIds || [])) {
    used.add(Number(id));
    used.add(Number(id));                     // 卡号本身也占着（PictID 常常等于卡号）
  }
  for (let id = ID_FLOOR; id <= ID_CEIL; id++) {
    if (used.has(id)) continue;
    if (fs.existsSync(chr51Path(pkgRoot, id))) continue;
    if (fs.existsSync(path.join(patchRoot(pkgRoot), bundleRelFor('chr10', id).split('/').join(path.sep)))) continue;
    return id;
  }
  throw new Error('没有可用的新 PictID 了（' + ID_FLOOR + '~' + ID_CEIL + ' 都被占了）');
}

/**
 * 造一个新 PictID 的三张图。
 * images = { chr10: {rgbaBase64,w,h}, chr20: {rgbaBase64,w,h}, chr51: {pngBase64}, chr51Size:{w,h} }
 *   —— 纹理给的像素是**显示方向**的 RGBA（跟 artwrite 的约定一致，这里负责翻成存储方向）
 * opts = { write, log, cardIds }
 */
function createPict(pkgRoot, pictId, images, opts) {
  const o = opts || {};
  const log = o.log || (() => {});
  const id = Number(pictId);
  const out = {
    pictId: id, created: [], changed: [], skipped: [], reseal: null, crc: {},
    bundleRel: { chr10: bundleRelFor('chr10', id), chr20: bundleRelFor('chr20', id) },
    containerPath: { chr10: containerPathFor('chr10', id), chr20: containerPathFor('chr20', id) },
  };
  const tpl = templatePath(pkgRoot);
  if (!fs.existsSync(tpl)) { out.error = true; out.note = '模板包不在: ' + tpl; return out; }

  const m = readMap(pkgRoot);
  if ((m.bundles || []).some(b => b.bundle === out.bundleRel.chr10 || b.bundle === out.bundleRel.chr20)) {
    out.error = true; out.note = 'asset-map 里已经有这个 PictID 的包了'; return out;
  }
  if ((m.assets || []).some(a => a.name === 'chr10_' + id || a.name === 'chr20_' + id)) {
    out.error = true; out.note = 'asset-map 里已经有这个 PictID 的资源了'; return out;
  }

  const w10 = Number(images.chr10 && images.chr10.w) || 512;
  const h10 = Number(images.chr10 && images.chr10.h) || 512;
  const w20 = Number(images.chr20 && images.chr20.w) || 256;
  const h20 = Number(images.chr20 && images.chr20.h) || 256;

  const tmpDir = require('./tmp').dir('newpict');
  const targets = [
    { kind: 'chr10', name: 'chr10_' + id, w: w10, h: h10, img: images.chr10, bundle: out.bundleRel.chr10, container: out.containerPath.chr10 },
    { kind: 'chr20', name: 'chr20_' + id, w: w20, h: h20, img: images.chr20, bundle: out.bundleRel.chr20, container: out.containerPath.chr20 },
  ];
  try {
    for (const t of targets) {
      if (!t.img || !t.img.rgbaBase64) { out.skipped.push({ key: t.kind, reason: '没有提供这张图' }); continue; }
      let display = Buffer.from(String(t.img.rgbaBase64).replace(/^data:[^,]*,/, ''), 'base64');
      if (display.length !== t.w * t.h * 4) { out.error = true; out.note = t.kind + ' RGBA 长度不对: ' + display.length; return out; }
      // ★ 卡面（chr10）预补偿：客户端把正方形卡面贴进竖的 cut-in 面板时会纵向放大 ~1.4 倍，
      //   所以这里先把画布纵向缩 1/1.4（上下补透明）。和 artwrite.js 里那套完全一致，
      //   否则「凭空新建卡面 ID」这条路会写出自然比例的卡面 ⇒ 游戏里被拉长。
      if (t.kind === 'chr10' && o.compensateCardFace !== false) {
        display = AW.compressVerticalCentered(display, t.w, t.h, AW.CARD_FACE_PANEL_STRETCH);
        out.compensated = (out.compensated || []).concat(['chr10']);
        log('卡面预补偿：纵向压缩 1/' + AW.CARD_FACE_PANEL_STRETCH + '（游戏 cut-in 面板会拉回来）');
      }
      // 显示方向 RGBA → 存储方向（bundle 里的纹理是上下颠倒存的，见 artwrite.js）
      const stride = t.w * 4;
      const flipped = Buffer.allocUnsafe(display.length);
      for (let y = 0; y < t.h; y++) display.copy(flipped, y * stride, (t.h - 1 - y) * stride, (t.h - y) * stride);
      const rawPath = path.join(tmpDir, t.kind + '.rgba');
      fs.writeFileSync(rawPath, flipped);
      const specPath = path.join(tmpDir, t.kind + '.spec');
      fs.writeFileSync(specPath, [TEMPLATE.texName, t.name, t.container, rawPath, t.w, t.h].join('\t') + '\n', 'utf8');
      const outBundle = path.join(tmpDir, t.kind + '.dat');
      const txt = execFileSync(BUNDLE_TOOL, ['make-card-bundle', tpl, outBundle, cabNameFor(t.kind, id), specPath], { encoding: 'utf8' });
      const verified = /CARD BUNDLE VERIFIED/.test(txt);
      out.created.push({ kind: t.kind, name: t.name, container: t.container, bundle: t.bundle, size: t.w + 'x' + t.h, bytes: fs.statSync(outBundle).size, verified });
      if (!verified) { out.error = true; out.note = t.kind + ' 造包没有通过验证:\n' + txt; return out; }
      t.built = outBundle;
      out.crc[t.kind] = crc32Hex(fs.readFileSync(outBundle));
    }
    if (out.error) return out;

    // chr51 放大立绘（普通 PNG 文件）
    const png = images.chr51 && images.chr51.pngBase64;
    if (!png) out.skipped.push({ key: 'chr51', reason: '没有提供放大立绘' });
    else out.created.push({ kind: 'chr51', name: 'chr51_' + id + '.png', file: 'resource-set/resources/image/chr51/chr51_' + id + '.png', bytes: Buffer.from(String(png).replace(/^data:image\/png;base64,/, ''), 'base64').length, verified: true });

    // ---- version.dat：追加行 + 加密写回
    const vdBefore = readVersionDat(pkgRoot);
    let vdText = vdBefore;
    const rows = [];
    for (const t of targets) {
      if (!t.built) continue;
      const line = '<bundle_ver>,' + t.bundle + ',0,' + out.crc[t.kind];
      if (vdText.includes(',' + t.bundle + ',')) { out.error = true; out.note = 'version.dat 里已经有 ' + t.bundle; return out; }
      rows.push(line);
    }
    const eol = vdText.includes('\r\n') ? '\r\n' : '\n';
    if (!vdText.endsWith(eol)) vdText += eol;
    vdText += rows.join(eol) + eol;
    out.versionRows = rows;

    // ---- asset-map：bundle 行 + asset 行 + 计数 + version_dat sha
    for (const t of targets) {
      if (!t.built) continue;
      m.bundles.push({
        bundle: t.bundle, cab_name: cabNameFor(t.kind, id), scrambled: false,
        delivery_crc32: out.crc[t.kind], dependencies: [],
      });
      const row = {
        container_path: t.container,
        directory: t.container.replace(/^assets\/resources\//, '').replace(/\/[^/]+$/, ''),
        name: t.name, object_type: 'Texture2D', extension: '.pvr', bundle: t.bundle,
      };
      m.assets.push(row);
      m.catalog_assets.push(Object.assign({ base_dir: '' }, row));
    }
    // 计数重算（asset_map.go 逐条校验：bundle 数 == 磁盘上存在的 bundle 数、scrambled+plain、依赖边）
    const src = m.source;
    let edges = 0;
    for (const b of m.bundles) edges += (b.dependencies || []).length;
    src.parsed_unity_bundle_count = m.bundles.length;
    src.present_versioned_bundle_count = m.bundles.length;
    src.versioned_bundle_count = (src.versioned_bundle_count || 0) + rows.length;
    if (src.selected_bundle_count_by_root && src.selected_bundle_count_by_root['resources/patch'] !== undefined) {
      src.selected_bundle_count_by_root['resources/patch'] += rows.length;
    }
    src.scrambled_bundle_count = m.bundles.filter(b => b.scrambled).length;
    src.plain_bundle_count = m.bundles.filter(b => !b.scrambled).length;
    src.bundle_dependency_edge_count = edges;
    src.exported_container_asset_count = m.assets.length;
    src.catalog_asset_count = m.catalog_assets.length;

    if (!o.write) {
      out.dryRun = true;
      out.note = '干跑：包已经造好并验证过（在临时目录），但没有写进卡包';
      out.plan = {
        files: targets.filter(t => t.built).map(t => 'resource-set/resources/patch/' + t.bundle),
        versionDatRows: rows,
        assetRows: targets.filter(t => t.built).map(t => t.container),
        chr51: !!png,
      };
      return out;
    }

    // ---- 真正落盘
    for (const t of targets) {
      if (!t.built) continue;
      const abs = path.join(patchRoot(pkgRoot), t.bundle.split('/').join(path.sep));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.copyFileSync(t.built, abs);
      out.changed.push('resources/patch/' + t.bundle);
      log('新包写入 ' + t.bundle + '（' + fs.statSync(abs).size + ' 字节，CRC ' + out.crc[t.kind] + '）');
    }
    writeVersionDat(pkgRoot, vdText);
    out.changed.push('resources/patch/version.dat');
    log('version.dat 追加 ' + rows.length + ' 行并重新加密');
    const vdSha = sha256File(versionDatPath(pkgRoot));
    src.version_dat_sha256 = vdSha;
    if (Array.isArray(src.version_manifests)) for (const vm of src.version_manifests) if (vm.patch_root === 'resources/patch') vm.sha256 = vdSha;
    fs.writeFileSync(mapPath(pkgRoot), JSON.stringify(m, null, 2) + '\n', 'utf8');
    out.changed.push('asset-map.json');
    if (png) {
      const p = chr51Path(pkgRoot, id);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, Buffer.from(String(png).replace(/^data:image\/png;base64,/, ''), 'base64'));
      out.changed.push('resources/image/chr51/chr51_' + id + '.png');
      log('放大立绘写入 chr51_' + id + '.png');
      // ★ 图片清单必须跟着更新，否则服务端不提供这张图（客户端观赏大图全白）
      const im = imagemap.syncImageManifest(pkgRoot, { write: true, force: [id], log });
      out.imagemap = { added: im.added, total: im.total, namespace: im.namespaceAfter };
      if (im.wrote) { out.changed.push(imagemap.MANIFEST_REL); log('图片清单登记 chr51_' + id + '.png（共 ' + im.total + ' 张）'); }
    }

    // ---- 重签
    if (o.reseal === false) { out.reseal = '(skipped)'; return out; }
    log('重签（' + out.changed.length + ' 个文件）…');
    const args = [pkgRoot];
    for (const rel of out.changed) args.push('--changed', rel);
    const reseal = execFileSync(RESEAL, args, { encoding: 'utf8' });
    out.reseal = reseal.trim().split(/\r?\n/).filter(Boolean).slice(-4).join(' | ');
    log(out.reseal);
    return out;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { }
  }
}

/**
 * 删掉一个「自己造的」新卡面 ID（createPict 的逆操作）。
 * 只允许删我们自己造的那段 ID（ID_FLOOR 以上），而且要求没有任何卡在用它 ——
 * 现有卡的图绝不能被这个函数碰到。
 */
function removePict(pkgRoot, pictId, opts) {
  const o = opts || {};
  const log = o.log || (() => {});
  const id = Number(pictId);
  const out = { pictId: id, action: 'remove', moved: [], changed: [], reseal: null };
  if (!(id >= ID_FLOOR)) { out.error = true; out.note = '只允许删自己新建的卡面 ID（≥ ' + ID_FLOOR + '）'; return out; }
  const m = readMap(pkgRoot);
  const rels = [bundleRelFor('chr10', id), bundleRelFor('chr20', id)];
  const inMap = (m.bundles || []).filter(b => rels.includes(b.bundle)).map(b => b.bundle);
  const png = chr51Path(pkgRoot, id);
  if (!inMap.length && !fs.existsSync(png)) { out.note = '这个 ID 本来就不存在'; return out; }

  // 安全闸：有任何卡在用它就不许删（拿 card.csv 查）。读不到 card.csv（残缺包 / 测试用的假包）
  // 就跳过这道闸，但要在报告里说明。
  const users = [];
  try {
    const pkgLib = require('./pkg');
    const P = new pkgLib.Package(pkgRoot); P.load();
    for (const [cid, row] of P.cardById) if (String(row[pkgLib.CARD_COL.pictId] || '').trim() === String(id)) users.push(cid);
    out.checkedUsers = true;
  } catch (e) {
    out.checkedUsers = false;
    out.userCheckNote = '读不到 card.csv，跳过「有没有卡在用」检查: ' + e.message;
  }
  if (users.length) { out.error = true; out.note = '还有卡在用这个卡面 ID（' + users.join('、') + '），先改掉它们'; return out; }

  const vdBefore = readVersionDat(pkgRoot);
  const eol = vdBefore.includes('\r\n') ? '\r\n' : '\n';
  const lines = vdBefore.split(/\r?\n/);
  const kept = lines.filter(l => !(l.startsWith('<bundle_ver>') && rels.some(r => l.includes(',' + r + ','))));
  out.versionRowsRemoved = lines.length - kept.length;
  const vdText = kept.join(eol);

  // 摘 asset-map 条目
  const cut = { bundles: [], assets: [], catalogAssets: [] };
  m.bundles = (m.bundles || []).filter(b => { if (rels.includes(b.bundle)) { cut.bundles.push(b); return false; } return true; });
  m.assets = (m.assets || []).filter(a => { if (rels.includes(a.bundle)) { cut.assets.push(a); return false; } return true; });
  m.catalog_assets = (m.catalog_assets || []).filter(a => { if (rels.includes(a.bundle)) { cut.catalogAssets.push(a); return false; } return true; });
  out.cut = { bundles: cut.bundles.length, assets: cut.assets.length, catalogAssets: cut.catalogAssets.length };
  const src = m.source;
  let edges = 0; for (const b of m.bundles) edges += (b.dependencies || []).length;
  src.parsed_unity_bundle_count = m.bundles.length;
  src.present_versioned_bundle_count = m.bundles.length;
  src.versioned_bundle_count = Math.max(0, (src.versioned_bundle_count || 0) - out.versionRowsRemoved);
  if (src.selected_bundle_count_by_root && src.selected_bundle_count_by_root['resources/patch'] !== undefined) {
    src.selected_bundle_count_by_root['resources/patch'] = Math.max(0, src.selected_bundle_count_by_root['resources/patch'] - out.versionRowsRemoved);
  }
  src.scrambled_bundle_count = m.bundles.filter(b => b.scrambled).length;
  src.plain_bundle_count = m.bundles.filter(b => !b.scrambled).length;
  src.bundle_dependency_edge_count = edges;
  src.exported_container_asset_count = m.assets.length;
  src.catalog_asset_count = m.catalog_assets.length;

  if (!o.write) { out.dryRun = true; out.note = '干跑：会删 ' + inMap.length + ' 个包 + chr51 + ' + out.versionRowsRemoved + ' 行 version.dat'; return out; }

  const park = path.join(pkgRoot, '_local', 'newpict-removed');
  fs.mkdirSync(park, { recursive: true });
  for (const rel of inMap) {
    const abs = path.join(patchRoot(pkgRoot), rel.split('/').join(path.sep));
    if (!fs.existsSync(abs)) continue;
    const dst = path.join(park, path.basename(rel));
    fs.renameSync(abs, dst);
    out.moved.push(path.relative(pkgRoot, dst).split(path.sep).join('/'));
    out.changed.push('resources/patch/' + rel);
  }
  if (fs.existsSync(png)) {
    const dst = path.join(park, path.basename(png));
    fs.renameSync(png, dst);
    out.moved.push(path.relative(pkgRoot, dst).split(path.sep).join('/'));
    out.changed.push('resources/image/chr51/' + path.basename(png));
    // ★ 顺手把图片清单里这一条摘掉（服务端只认清单，留着会启动不了）
    const im = imagemap.syncImageManifest(pkgRoot, { write: true, force: [id], log });
    out.imagemap = { removed: im.removed, total: im.total, namespace: im.namespaceAfter };
    if (im.wrote) { out.changed.push(imagemap.MANIFEST_REL); log('图片清单去掉 chr51_' + id + '.png'); }
  }
  fs.writeFileSync(path.join(park, 'card_' + id + '.json'), JSON.stringify({ cardId: id, cut, versionRowsRemoved: out.versionRowsRemoved }, null, 2), 'utf8');
  writeVersionDat(pkgRoot, vdText);
  out.changed.push('resources/patch/version.dat');
  const vdSha = sha256File(versionDatPath(pkgRoot));
  src.version_dat_sha256 = vdSha;
  if (Array.isArray(src.version_manifests)) for (const vm of src.version_manifests) if (vm.patch_root === 'resources/patch') vm.sha256 = vdSha;
  fs.writeFileSync(mapPath(pkgRoot), JSON.stringify(m, null, 2) + '\n', 'utf8');
  out.changed.push('asset-map.json');
  log('删掉 ' + out.moved.length + ' 个文件（挪到 _local\\newpict-removed\\），version.dat 去掉 ' + out.versionRowsRemoved + ' 行');
  if (o.reseal === false) { out.reseal = '(skipped)'; return out; }
  const args = [pkgRoot];
  for (const rel of out.changed) args.push('--changed', rel);
  const txt = execFileSync(RESEAL, args, { encoding: 'utf8' });
  out.reseal = txt.trim().split(/\r?\n/).filter(Boolean).slice(-4).join(' | ');
  log(out.reseal);
  return out;
}

module.exports = { allocateId, createPict, removePict, crc32Hex, containerPathFor, bundleRelFor, cabNameFor, readVersionDat, chr51Path, TEMPLATE, mapPath, ID_FLOOR, ID_CEIL };
