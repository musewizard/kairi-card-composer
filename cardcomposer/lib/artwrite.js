'use strict';
/*
 * artwrite.js -- 把用户裁剪好的图写进包里：chr51 立绘（PNG 文件）+ chr10/chr20 卡面（bundle 纹理）
 *
 * 流程：
 *   1. chr51：base64 PNG 直接写文件（尺寸必须和现有文件一致，避免拉伸变形）
 *   2. chr10/chr20：base64 原始 RGBA → 临时文件 → BundleTool import-texture →
 *      输出 bundle 覆盖原文件（只动「明文包」，加密包直接跳过并说明原因）
 *   3. chr51 写完同步 resources/image/manifest.json（服务端只会服务清单里列出的
 *      图片文件；不同步 = 客户端观赏大图全白），再统一 Reseal 一次
 *
 * ★★ 方向约定（2026-09-23 用两张真卡实测过，别删）★★
 *   bundle 里的纹理按 Unity 老约定**上下颠倒**存像素：把 chr10_<PictID> 导出看，
 *   画是竖着翻过来的；而官方的 160×160 卡图缩略图（cn602-admin-assets/card/*.webp）
 *   和 chr51 立绘 PNG 都是正的。
 *   所以：调用方给的是**显示方向**（用户在网页预览里看到的样子），
 *   本模块写 chr10/chr20 之前会竖直翻一次（flipRgbaVertical），chr51 不翻。
 *   要直接灌「存储方向」的原始像素（比如把某张纹理原样复制到另一张），传 flipY:false。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { targetsFor, BUNDLE_TOOL } = require('./artmap');
const imagemap = require('./imagemap');

const TOOLS = require('./tools').toolsRoot();
const RESEAL = require('./tools').reseal();

/** RGBA 像素竖直翻转（行序倒过来，行内不动）。返回新 Buffer，不改原数据。 */
function flipRgbaVertical(buf, w, h) {
  const stride = w * 4;
  const out = Buffer.allocUnsafe(buf.length);
  for (let y = 0; y < h; y++) {
    buf.copy(out, y * stride, (h - 1 - y) * stride, (h - y) * stride);
  }
  return out;
}

/** R 和 B 通道对调（RGBA ↔ BGRA）。返回新 Buffer。 */
function swapRb(buf) {
  const out = Buffer.from(buf);                 // copy
  for (let i = 0; i + 3 < out.length; i += 4) { const t = out[i]; out[i] = out[i + 2]; out[i + 2] = t; }
  return out;
}

/*
 * ★★ 卡面（chr10）为什么要「预先压扁」—— 2026-09-24 用客户端自己的脚本 + 两张游戏截图量出来的 ★★
 *
 * 客户端脚本 `main_c/script.dat` 里的 `player_skillcutin`（用 BundleTool dump 出来看的）写着：
 *     cutin_type 0（通常）→ player_skillcutin_card_img CardMod card_id 20 0   → 用 chr20（图标）
 *     cutin_type 1（豪華）→ player_skillcutin_card_img CardMod card_id 10 0   → 用 chr10（卡面）
 * 而豪華 cut-in 的面板节点叫 `Anm_Chr/Clip_Chr/Dmy_Chr`：一张**竖着的**面板。
 *
 * 实测（用户两张游戏截图 + 我们的 chr51 做特征比对，脚本 inspect\cutin-face.js）：
 * 客户端把**正方形**的卡面纹理贴进那个竖面板时，纵向比横向多放大 **≈1.4 倍**
 * （脸 127×165 / 原图 273×248 → sy/sx = 1.430、1.408 两次一致）。
 * 所以官方卡面纹理本身是**预先横向拉长 ~1.4 倍**（= 纵向压扁）过的：
 * 拿同一张卡（PictID 91000953）的 chr10 和 chr20 比，脸宽高比 1.176 : 0.873 = **1.35 倍**。
 * 两个数（1.35 / 1.43）互相印证 —— 官方就是为了让这个竖面板显示出来是正常比例。
 *
 * 我们原来是按自然比例写 chr10 ⇒ 游戏里被拉长 1.4 倍 ⇒ 用户看到「比例不对」。
 * 这里的修法：写 chr10 之前，把画布内容**纵向压缩 1/1.4**（上下留透明，不裁掉用户的内容），
 * 游戏面板再把它拉回来，比例就正常了。chr20（图标）和 chr51（放大立绘）**不动**：
 * 小方框用的是 chr20（自然比例才正常），chr51 是独立 PNG，用 contain 装框。
 */
const CARD_FACE_PANEL_STRETCH = 1.4;

/**
 * 把「显示方向」的 RGBA **纵向缩到 1/k**（整张图等比纵向缩小、左右不动），上下补透明 —— 
 * 用于卡面预补偿：内容一点不裁，只是纵向变矮，游戏面板再把它拉回来就正常了。
 * 用按面积加权的重采样（不是最近邻丢行），缩放后不会出现锯齿丢行。
 */
function compressVerticalCentered(buf, w, h, k) {
  const out = Buffer.alloc(w * h * 4);            // 全透明
  const dstH = Math.round(h / k), yOff = Math.round((h - dstH) / 2);
  for (let y = 0; y < dstH; y++) {
    const start = y * k, end = (y + 1) * k;       // 这一输出行覆盖的源行区间
    const r0 = Math.floor(start), r1 = Math.min(h, Math.ceil(end));
    const dRow = (yOff + y) * w * 4;
    for (let x = 0; x < w; x++) {
      let rs = 0, gs = 0, bs = 0, as = 0, wsum = 0;
      for (let r = r0; r < r1; r++) {
        const ov = Math.min(end, r + 1) - Math.max(start, r);   // 重叠长度 = 权重
        if (ov <= 0) continue;
        const o = (r * w + x) * 4;
        rs += buf[o] * ov; gs += buf[o + 1] * ov; bs += buf[o + 2] * ov; as += buf[o + 3] * ov;
        wsum += ov;
      }
      const d = dRow + x * 4;
      if (wsum > 0) {
        out[d] = Math.round(rs / wsum); out[d + 1] = Math.round(gs / wsum);
        out[d + 2] = Math.round(bs / wsum); out[d + 3] = Math.round(as / wsum);
      }
    }
  }
  return out;
}

/** compressVerticalCentered 的逆：把中间那一条纵向拉回 k 倍，还原成「自然比例」的画布。 */
function expandVerticalCentered(buf, w, h, k) {
  const out = Buffer.alloc(w * h * 4);
  const srcH = Math.round(h / k), yOff = Math.round((h - srcH) / 2);
  for (let y = 0; y < h; y++) {
    const srcY = Math.min(h - 1, Math.max(0, yOff + Math.floor(y * srcH / h)));
    buf.copy(out, y * w * 4, srcY * w * 4, (srcY + 1) * w * 4);
  }
  return out;
}

/**
 * @param pkgRoot 包根目录
 * @param pictId  卡面 ID
 * @param images  { chr51?: {pngBase64}, chr10?: {rgbaBase64,w,h}, chr20?: {rgbaBase64,w,h} }
 *                纹理给的是 **RGBA 顺序 + 显示方向** 的像素（网页 canvas 的原样输出）
 * @param opts    { write:boolean, log:fn, flipY:boolean（默认 true）, rawStorage:boolean（默认 false） }
 *                flipY:false   → 不做竖直翻转（像素已经是「存储方向」）
 *                rawStorage:true → 给的就是 `BundleTool export-texture` 出来的字节，
 *                                  一个字节都不动地写回去（记住导入器总会换一次 R/B，
 *                                  所以这里要自己换回来；竖直翻转也一并跳过）
 */
function applyArt(pkgRoot, pictId, images, opts) {
  const o = opts || {};
  const log = o.log || (() => {});
  const rawStorage = !!o.rawStorage;
  const doFlip = o.flipY !== false && !rawStorage;
  const plan = targetsFor(pkgRoot, pictId);
  const report = { pictId: Number(pictId), written: [], skipped: [], changed: [], verified: [] };
  const tmpFiles = [];
  let chr51Written = false;

  for (const t of plan.targets) {
    const img = images && images[t.key];
    if (!img) { report.skipped.push({ key: t.key, reason: '没有提供这张图' }); continue; }
    if (!t.editable) { report.skipped.push({ key: t.key, reason: t.note || '不可编辑' }); continue; }

    if (t.key === 'chr51') {
      if (!img.pngBase64) { report.skipped.push({ key: t.key, reason: 'chr51 需要 PNG（base64）' }); continue; }
      const buf = Buffer.from(String(img.pngBase64).replace(/^data:image\/png;base64,/, ''), 'base64');
      // 尺寸校验：原文件多大就得裁多大（客户端按原尺寸用）
      if (t.exists && t.width && t.height) {
        const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
        if (w !== t.width || h !== t.height) {
          report.skipped.push({ key: t.key, reason: '尺寸必须裁成 ' + t.width + '×' + t.height + '，收到 ' + w + '×' + h });
          continue;
        }
      }
      const abs = path.join(pkgRoot, t.fileRel.split('/').join(path.sep));
      if (o.write) {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, buf);
        report.changed.push(t.fileRel);
        chr51Written = true;
      }
      report.written.push({ key: t.key, path: t.fileRel, bytes: buf.length, mode: o.write ? 'written' : 'planned' });
      continue;
    }

    // chr10 / chr20：写 bundle 纹理
    if (!img.rgbaBase64) { report.skipped.push({ key: t.key, reason: t.key + ' 需要原始 RGBA（base64）' }); continue; }
    let rawIn = Buffer.from(String(img.rgbaBase64).replace(/^data:[^,]*,/, ''), 'base64');
    const w = Number(img.w || t.width), h = Number(img.h || t.height);
    if (!w || !h) { report.skipped.push({ key: t.key, reason: '不知道目标尺寸' }); continue; }
    if (rawIn.length !== w * h * 4) {
      report.skipped.push({ key: t.key, reason: 'RGBA 长度不对：' + rawIn.length + '，期望 ' + (w * h * 4) });
      continue;
    }
    // ★ 卡面预补偿：客户端会把正方形卡面贴进竖的 cut-in 面板（纵向放大 ~1.4 倍），
    //   所以这里先把画布纵向压缩 1/1.4（上下留透明，不裁用户的内容）。见文件顶部说明。
    const compensate = t.key === 'chr10' && o.compensateCardFace !== false && !rawStorage;
    if (compensate) {
      rawIn = compressVerticalCentered(rawIn, w, h, CARD_FACE_PANEL_STRETCH);
      log('卡面预补偿：纵向压缩 1/' + CARD_FACE_PANEL_STRETCH + '（游戏 cut-in 面板会拉回来，比例才正常）');
    }
    // 显示方向 → 存储方向（纹理在引擎里是上下颠倒存的）
    const raw = rawStorage ? swapRb(rawIn) : (doFlip ? flipRgbaVertical(rawIn, w, h) : rawIn);
    const rawPath = require('./tmp').file('art-' + t.key, '.rgba');
    const outBundle = require('./tmp').file('art-' + t.key, '.dat');
    tmpFiles.push(rawPath, outBundle);
    fs.writeFileSync(rawPath, raw);
    // bundlePath 是「相对 resource-set」，包内绝对路径要补上 resource-set
    const srcAbs = path.join(pkgRoot, 'resource-set', t.bundlePath);
    const relFromPkg = ('resource-set/' + t.bundlePath.split(path.sep).join('/'));
    let out;
    try {
      out = execFileSync(BUNDLE_TOOL, ['import-texture', srcAbs, t.texName, rawPath, String(w), String(h), outBundle, '--rgba'],
        { encoding: 'utf8' });
    } catch (e) {
      report.skipped.push({ key: t.key, reason: '写纹理失败: ' + String(e.stderr || e.message).split('\n')[0] });
      continue;
    }
    const verified = /TEXTURE IMPORT VERIFIED/.test(out);
    report.verified.push({ key: t.key, ok: verified });
    if (o.write) {
      fs.copyFileSync(outBundle, srcAbs);
      report.changed.push(relFromPkg);
    }
    report.written.push({
      key: t.key, path: relFromPkg, texName: t.texName,
      size: w + 'x' + h, mode: o.write ? 'written' : 'planned', verified,
    });
  }

  // 清理临时文件
  for (const f of tmpFiles) { try { fs.unlinkSync(f); } catch { } }

  // ★ chr51 换了就必须同步图片清单，否则客户端那侧 404（观赏大图全白）——
  //   见 imagemap.js 顶部说明。
  if (chr51Written || o.write) {
    report.imagemap = imagemap.syncImageManifest(pkgRoot, {
      write: !!o.write, force: [Number(pictId)], log,
    });
    if (report.imagemap.wrote) report.changed.push(imagemap.MANIFEST_REL);
  }

  if (o.write && report.changed.length) {
    log('重签（' + report.changed.length + ' 个文件）…');
    const args = [pkgRoot];
    for (const rel of report.changed) args.push('--changed', rel);
    const out = execFileSync(RESEAL, args, { encoding: 'utf8' });
    report.reseal = out.trim().split('\n').slice(-3).join(' | ');
    log(report.reseal);
  }
  return report;
}

module.exports = { applyArt, flipRgbaVertical, swapRb, compressVerticalCentered, expandVerticalCentered, CARD_FACE_PANEL_STRETCH };
