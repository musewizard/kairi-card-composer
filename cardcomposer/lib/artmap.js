'use strict';
require('./tmp');   // 先把 TMP/TEMP 指到工作区（BundleTool 内部要用，见 tmp.js）
/*
 * artmap.js -- 「这张卡的卡面到底存在哪、能不能改」
 *
 * 权威来源：`resource-set/asset-map.json`（Reseal 生成的客户端资源清单，52 MB）。
 * 里面每个 Texture2D 都有 container_path / name / bundle，每个 bundle 有 scrambled 标记。
 *
 * 实测结论（2026-09-23）：
 *   chr10_<PictID>  512×512 RGBA32  = 卡面大图，在 bundle 里
 *   chr20_<PictID>  256×256 RGBA32  = 卡面小图/图标，在另一个 bundle 里
 *   chr51_<PictID>.png 1280×1024（或 1024×1024）= 放大立绘，**就是普通文件**
 * bundle 里 4864/5994 是 CN 加密的（AssetsTools.NET 没密钥读不了），
 * 所以：明文包能改、加密包只能放弃（chr51 永远能改，因为是独立 PNG 文件）。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const BUNDLE_TOOL = require('./tools').bundleTool();

const mapCache = new Map();
function assetMap(pkgRoot) {
  const p = path.join(pkgRoot, 'resource-set', 'asset-map.json');
  // asset-map.json 有 52 MB：缓存它，但**按 mtime+大小**失效 —— 因为我们自己会改它
  // （自定义卡面写入、Live2D 开关、新建卡面 ID），不能让缓存挡住新条目。
  let stamp = null;
  try { const st = fs.statSync(p); stamp = st.mtimeMs + ':' + st.size; } catch { }
  const hit = mapCache.get(p);
  if (hit && hit.stamp === stamp) return hit.value;
  const m = JSON.parse(fs.readFileSync(p, 'utf8'));
  const scrambled = new Map(m.bundles.map(b => [b.bundle, !!b.scrambled]));
  const byName = new Map();
  for (const a of m.assets) if (a.object_type === 'Texture2D') byName.set(a.name, a);
  const v = { scrambled, byName, bundles: m.bundles.length, assets: m.assets.length };
  mapCache.set(p, { stamp, value: v });
  return v;
}

/** 清掉 asset-map 缓存（写完 asset-map 之后叫一声，保险起见） */
function invalidate() { mapCache.clear(); infoCache.clear(); }

/** PNG 尺寸（读 IHDR，不解码整张图） */
function pngSize(abs) {
  try {
    const b = fs.readFileSync(abs);
    if (b.length < 24 || b.toString('ascii', 1, 4) !== 'PNG') return null;
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), bytes: b.length };
  } catch { return null; }
}

const infoCache = new Map();
/** 读 bundle 里某张纹理的尺寸/格式（加密包会失败，返回 {error}） */
function textureInfo(pkgRoot, relBundle, texName) {
  const key = relBundle + '|' + texName;
  if (infoCache.has(key)) return infoCache.get(key);
  const abs = path.join(pkgRoot, 'resource-set', relBundle);
  let out = null;
  try {
    const txt = execFileSync(BUNDLE_TOOL, ['texture-info', abs, texName], { encoding: 'utf8' });
    const m = /width=(\d+) height=(\d+) format=(\S+) formatId=(\d+)/.exec(txt);
    out = m ? { width: Number(m[1]), height: Number(m[2]), format: m[3], formatId: Number(m[4]) } : { error: '解析不了: ' + txt.trim() };
  } catch (e) {
    const msg = String(e.stderr || e.message || '');
    out = { error: /BUNDLE UNREADABLE/.test(msg) ? 'bundle 是 CN 加密包，读不了（也就改不了）' : ('读失败: ' + msg.split('\n')[0]) };
  }
  infoCache.set(key, out);
  return out;
}

/** 一个 PictID 的全部卡面目标 */
function targetsFor(pkgRoot, pictId) {
  const id = String(pictId);
  const map = assetMap(pkgRoot);
  const out = { pictId: Number(id), targets: [], editableCount: 0, totalCount: 0 };
  for (const [key, tex] of [['chr10', 'chr10_' + id], ['chr20', 'chr20_' + id]]) {
    const a = map.byName.get(tex);
    const rel = a ? path.join('resources', 'patch', a.bundle.replace(/\//g, path.sep)) : null;
    const scrambled = a ? !!map.scrambled.get(a.bundle) : null;
    const t = {
      key, texName: tex, kind: 'texture',
      bundleRel: a ? a.bundle : null,
      bundlePath: rel,
      containerPath: a ? a.container_path : null,
      scrambled,
      editable: !!a && !scrambled,
      note: !a ? '这个 PictID 在资源清单里没有这张纹理' : (scrambled ? '所在 bundle 是 CN 加密包（改不了）' : ''),
    };
    if (t.editable) {
      const info = textureInfo(pkgRoot, rel, tex);
      Object.assign(t, info);
      t.editable = !info.error;
      if (info.error) t.note = info.error;
    }
    out.targets.push(t);
    out.totalCount++;
    if (t.editable) out.editableCount++;
  }
  // chr51：普通 PNG 文件，永远可改
  const rel51 = path.join('resource-set', 'resources', 'image', 'chr51', 'chr51_' + id + '.png');
  const abs51 = path.join(pkgRoot, rel51);
  const size = pngSize(abs51);
  out.targets.push({
    key: 'chr51', texName: 'chr51_' + id, kind: 'png',
    fileRel: rel51.split(path.sep).join('/'),
    exists: !!size, width: size ? size.width : null, height: size ? size.height : null,
    bytes: size ? size.bytes : null,
    editable: true,
    note: size ? '放大立绘（独立 PNG 文件，直接替换）' : '这个 PictID 还没有放大立绘文件，可以新建（尺寸随你裁）',
  });
  out.editableCount++;
  out.totalCount++;
  return out;
}

/** 找一批「卡面/图标/放大图都能改」的 PictID（给用户换卡面 ID 用）。 */
function editablePictIds(pkgRoot, limit) {
  const map = assetMap(pkgRoot);
  const chr10 = new Map(), chr20 = new Map();
  for (const a of map.byName.values()) {
    let m;
    if ((m = /^chr10_(\d+)$/.exec(a.name))) chr10.set(m[1], a);
    else if ((m = /^chr20_(\d+)$/.exec(a.name))) chr20.set(m[1], a);
  }
  const dir51 = path.join(pkgRoot, 'resource-set', 'resources', 'image', 'chr51');
  const out = [];
  for (const [id, a10] of chr10) {
    if (map.scrambled.get(a10.bundle)) continue;                  // chr10 必须明文
    const a20 = chr20.get(id);
    if (!a20 || map.scrambled.get(a20.bundle)) continue;          // chr20 也必须明文
    const abs51 = path.join(dir51, 'chr51_' + id + '.png');
    if (!fs.existsSync(abs51)) continue;                          // 最好已有放大图
    const s = pngSize(abs51);
    out.push({ pictId: Number(id), chr51: s ? s.width + 'x' + s.height : null, bundle10: a10.bundle, bundle20: a20.bundle });
    if (out.length >= (limit || 60)) break;
  }
  return out;
}

module.exports = { assetMap, targetsFor, textureInfo, pngSize, editablePictIds, BUNDLE_TOOL, invalidate };
