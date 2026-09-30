'use strict';
/*
 * imagemap.js -- 维护「放大立绘」的图片清单：resource-set/resources/image/manifest.json
 *
 * ★★ 为什么必须有这个模块（2026-09-24 踩到的坑，别删）★★
 *   客户端要的放大立绘（观赏大图 / 战斗 cut-in）不是从 patch 包拿的，而是走
 *   HTTP 图片服务：登录时服务端给 res_img_url = <base>/image/<namespace>/，
 *   namespace = sha256(resources/image/manifest.json) 的前 16 字节。
 *   服务端内部（internal/cnbootstrap/card_images.go）**只认 manifest.json 里列出的
 *   文件**，而且是先按 manifest 校验 bytes/sha256、再提供服务：
 *     - manifest 里没有的 PNG → 一律 404（客户端观赏大图就全白/全透明）
 *     - manifest 和磁盘对不上 → 服务端直接拒绝启动
 *   所以：写/删 chr51_<PictID>.png 之后，必须同步这个 manifest，然后再 Reseal。
 *   （以前只改 PNG 没改 manifest，就是「图换不掉 / 全白」的真正原因。）
 *
 * 另外两条硬约束（服务端会逐条校验，违反了服务端起不来）：
 *   1. 路径必须精确匹配 ^chr51/chr51_[0-9]{8}\.png$ —— 必须是 8 位数字 ID
 *   2. schema_version = 1，files 不能为空，bytes>0 且 ≤32MB，sha256 是 64 位十六进制
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const IMAGE_DIR_REL = 'resources/image';
const CHR51_DIR_REL = 'resources/image/chr51';
const MANIFEST_REL = 'resources/image/manifest.json';
const NAME_RE = /^chr51_(\d{8})\.png$/;

function imageDir(pkgRoot) { return path.join(pkgRoot, 'resource-set', 'resources', 'image'); }
function chr51Dir(pkgRoot) { return path.join(imageDir(pkgRoot), 'chr51'); }
function manifestPath(pkgRoot) { return path.join(imageDir(pkgRoot), 'manifest.json'); }
function chr51Rel(pictId) { return 'chr51/chr51_' + Number(pictId) + '.png'; }

function sha256File(abs) {
  return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}

function readManifest(pkgRoot) {
  const p = manifestPath(pkgRoot);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/** 目录里现有的 chr51 PNG（只认 8 位数字 ID 的文件名）。 */
function listChr51(pkgRoot) {
  const dir = chr51Dir(pkgRoot);
  const out = { files: [], ignored: [] };
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const m = NAME_RE.exec(name);
    const abs = path.join(dir, name);
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    if (!st.isFile()) continue;
    if (!m) { out.ignored.push({ name, reason: '文件名不是 chr51_<8位数字>.png，服务端不认' }); continue; }
    out.files.push({ pictId: Number(m[1]), rel: 'chr51/' + name, name, abs, bytes: st.size, mtimeMs: st.mtimeMs });
  }
  out.files.sort((a, b) => a.pictId - b.pictId);
  return out;
}

/** 当前 namespace（登录时给客户端的图片 URL 前缀），纯粹给日志/诊断用。 */
function namespaceOf(pkgRoot) {
  const p = manifestPath(pkgRoot);
  if (!fs.existsSync(p)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 32);
}

/**
 * 让 manifest.json 和磁盘上的 chr51 PNG 一致。
 *
 * opts = {
 *   write: false,           // true 才真的写文件
 *   force: [pictId, ...],   // 强制重算这些 ID 的 sha256（刚写过这张图时必须传）
 *   verify: false,          // true = 全部重算一遍（维护/体检用，慢）
 *   log: fn,
 * }
 * 返回 { changed, added, updated, removed, total, namespaceBefore, namespaceAfter, ... }
 * 注意：默认对「大小没变的老条目」直接沿用 manifest 里已有的 sha256（不然每次都要
 * 重算 4300 多个 PNG、约 4.4 GB）。谁改的图谁负责把它放进 force。
 */
function syncImageManifest(pkgRoot, opts) {
  const o = opts || {};
  const log = o.log || (() => {});
  const force = new Set((o.force || []).map(Number));
  const before = readManifest(pkgRoot);
  const beforeByPath = new Map();
  for (const f of ((before && before.files) || [])) beforeByPath.set(String(f.path), f);
  const beforeBytes = fs.existsSync(manifestPath(pkgRoot)) ? fs.readFileSync(manifestPath(pkgRoot)) : null;

  const listed = listChr51(pkgRoot);
  const files = [];
  const added = [], updated = [], removed = [], kept = [], rehashed = [];
  const seen = new Set();

  for (const f of listed.files) {
    if (seen.has(f.rel)) { removed.push(f.rel); continue; }   // 不可能发生，防御
    seen.add(f.rel);
    const old = beforeByPath.get(f.rel);
    let sha = null;
    if (old && Number(old.bytes) === f.bytes && !force.has(f.pictId) && !o.verify && /^[0-9a-f]{64}$/.test(String(old.sha256))) {
      sha = String(old.sha256);
      kept.push(f.pictId);
    } else {
      sha = sha256File(f.abs);
      rehashed.push(f.pictId);
      if (!old) added.push(f.pictId);
      else if (old.bytes !== f.bytes || old.sha256 !== sha) updated.push(f.pictId);
    }
    files.push({ path: f.rel, bytes: f.bytes, sha256: sha });
  }
  for (const [p] of beforeByPath) if (!seen.has(p)) removed.push(p);

  const doc = { schema_version: 1, files };
  const afterBytes = Buffer.from(JSON.stringify(doc, null, 2) + '\n', 'utf8');
  const changed = !beforeBytes || Buffer.compare(beforeBytes, afterBytes) !== 0;

  const report = {
    path: MANIFEST_REL,
    total: files.length,
    added, updated, removed, rehashed, kept: kept.length,
    ignored: listed.ignored,
    changed,
    wrote: false,
    namespaceBefore: namespaceOf(pkgRoot),
    namespaceAfter: crypto.createHash('sha256').update(afterBytes).digest('hex').slice(0, 32),
  };
  if (o.write && changed) {
    fs.mkdirSync(imageDir(pkgRoot), { recursive: true });
    fs.writeFileSync(manifestPath(pkgRoot), afterBytes);
    report.wrote = true;
    log('图片清单 updated: 共 ' + files.length + ' 张（新 ' + added.length + ' / 改了 ' +
      updated.length + ' / 去掉 ' + removed.length + '）');
  }
  return report;
}

/**
 * 体检：manifest 里每一条是不是和磁盘完全一致（服务端启动时会做同样的检查，
 * 不一致就整个资源集起不来）。返回问题列表，空数组 = 健康。
 */
function checkImageManifest(pkgRoot) {
  const problems = [];
  const man = readManifest(pkgRoot);
  if (!man) { problems.push({ path: MANIFEST_REL, problem: '清单文件不存在或不是合法 JSON' }); return problems; }
  if (man.schema_version !== 1) problems.push({ path: MANIFEST_REL, problem: 'schema_version 必须是 1' });
  if (!Array.isArray(man.files) || !man.files.length) problems.push({ path: MANIFEST_REL, problem: 'files 是空的（服务端会拒绝）' });
  const seen = new Set();
  for (const f of (man.files || [])) {
    const p = String(f.path || '');
    if (!/^chr51\/chr51_[0-9]{8}\.png$/.test(p)) { problems.push({ path: p, problem: '路径不合规（必须 chr51/chr51_<8位>.png）' }); continue; }
    if (seen.has(p)) problems.push({ path: p, problem: '清单里重复登记' });
    seen.add(p);
    if (!/^[0-9a-f]{64}$/.test(String(f.sha256 || ''))) { problems.push({ path: p, problem: 'sha256 不是 64 位十六进制' }); continue; }
    const abs = path.join(pkgRoot, 'resource-set', 'resources', 'image', p.split('/').join(path.sep));
    if (!fs.existsSync(abs)) { problems.push({ path: p, problem: '磁盘上没这个文件' }); continue; }
    const st = fs.statSync(abs);
    if (st.size !== Number(f.bytes)) problems.push({ path: p, problem: '字节数不一致：清单 ' + f.bytes + ' / 磁盘 ' + st.size });
  }
  return problems;
}

/**
 * 轻量对账（只 stat，不算 sha256）：磁盘上的 chr51 PNG 和清单不一致的地方。
 * 空数组 = 一致。用来在注入/重签前判断「要不要顺手补一下清单」。
 */
function pendingChr51(pkgRoot) {
  const man = readManifest(pkgRoot);
  const byPath = new Map(((man && man.files) || []).map(f => [String(f.path), f]));
  const out = [];
  for (const f of listChr51(pkgRoot).files) {
    const old = byPath.get(f.rel);
    if (!old) out.push({ pictId: f.pictId, path: f.rel, problem: '磁盘上有、清单里没登记（客户端会 404）' });
    else if (Number(old.bytes) !== f.bytes) out.push({ pictId: f.pictId, path: f.rel, problem: '字节数清单 ' + old.bytes + ' / 磁盘 ' + f.bytes });
    byPath.delete(f.rel);
  }
  for (const [p] of byPath) out.push({ path: p, problem: '清单里有、磁盘上没有（服务端起不来）' });
  return out;
}

module.exports = {
  IMAGE_DIR_REL, CHR51_DIR_REL, MANIFEST_REL, NAME_RE,
  imageDir, chr51Dir, manifestPath, chr51Rel,
  listChr51, readManifest, syncImageManifest, checkImageManifest, pendingChr51, namespaceOf, sha256File,
};
