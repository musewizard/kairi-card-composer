'use strict';
/*
 * thumb.js -- 卡面缩略图（`_local/control/server/cn602-admin-assets/card/<卡号>.webp`）
 *
 * 这张 160×160 的**无损 WebP** 是「后台目录/卡表里那张小图」：工具左边的卡列表、
 * 立绘预览、服务端后台面板、kairimod 都读它。它跟游戏里真正显示的三张图（chr10/chr20/chr51）
 * 是两回事 —— 所以自定义卡面时必须**单独**给它取一次景（一般要对准脸/头，位置不固定）。
 *
 * 编码器是自己的：lib\webp.js（这台机器上只有 WebP **解码器**，没有任何编码器），
 * 正确性用 Windows WIC 回读验证过（tools\thumb-tool，像素逐字节一致）。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { encodeVp8lLossless } = require('./webp');

const THUMB_TOOL = require('./tools').thumbTool();
const RESEAL = require('./tools').reseal();

/** Reseal：缩略图在资源集里（_local/control/server/...），改完必须重签，否则清单对不上 */
function resealThumb(pkgRoot, relative, log) {
  const args = [pkgRoot, '--changed', relative];
  try {
    const out = execFileSync(RESEAL, args, { encoding: 'utf8' });
    const line = out.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' | ');
    if (log) log(line);
    return line;
  } catch (e) {
    const msg = String(e.stderr || e.message).split('\n')[0];
    if (log) log('重签失败: ' + msg);
    return '重签失败: ' + msg;
  }
}

function adminDir(pkgRoot) { return path.join(pkgRoot, 'resource-set', '_local', 'control', 'server', 'cn602-admin-assets'); }
function thumbPath(pkgRoot, cardId) { return path.join(adminDir(pkgRoot), 'card', String(Number(cardId)) + '.webp'); }

/** PNG 尺寸（读 IHDR） */
function pngSize(buf) {
  try {
    if (buf.length < 24 || buf.toString('ascii', 1, 4) !== 'PNG') return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } catch { return null; }
}

/** 用 WIC 回读校验（可选，慢一点点；测试和首次生成时用） */
function verifyWithWic(file) {
  try {
    const out = execFileSync(THUMB_TOOL, ['check', file], { encoding: 'utf8' });
    const m = /(\d+)x(\d+)/.exec(out);
    return { ok: /OK/.test(out), width: m ? Number(m[1]) : null, height: m ? Number(m[2]) : null, raw: out.trim() };
  } catch (e) {
    return { ok: false, error: String(e.stderr || e.message).split('\n')[0] };
  }
}

/**
 * 写一张卡面缩略图。
 * @param rgba   RGBA 像素（显示方向），必须正好是 w*h*4
 * @param opts   { write, verify }
 */
function writeThumbnail(pkgRoot, cardId, rgba, w, h, opts) {
  const o = opts || {};
  const out = { cardId: Number(cardId), path: thumbPath(pkgRoot, cardId), width: w, height: h, wrote: false };
  if (rgba.length !== w * h * 4) { out.error = true; out.note = 'RGBA 长度不对: ' + rgba.length + '，期望 ' + (w * h * 4); return out; }
  const existed = fs.existsSync(out.path);
  out.replaced = existed;
  out.oldBytes = existed ? fs.statSync(out.path).size : null;
  const webp = encodeVp8lLossless(rgba, w, h);
  out.bytes = webp.length;
  out.relative = path.relative(pkgRoot, out.path).split(path.sep).join('/');
  if (!o.write) { out.note = '干跑：算出了 ' + webp.length + ' 字节的 WebP，没有写'; return out; }
  fs.mkdirSync(path.dirname(out.path), { recursive: true });
  fs.writeFileSync(out.path, webp);
  out.wrote = true;
  if (o.verify !== false) {
    out.verify = verifyWithWic(out.path);
    if (!out.verify.ok) { out.error = true; out.note = '写完用 WIC 校验失败: ' + (out.verify.error || out.verify.raw); }
  }
  if (o.reseal !== false) out.reseal = resealThumb(pkgRoot, out.relative, o.log);
  return out;
}

/**
 * 把一张 RGBA 图按面积平均缩到 dw×dh（cover：先按目标比例中心裁，再缩）。
 * 用于「从卡面大图直接生成缩略图」（注入新卡时如果用户没单独取景就用它兜底）。
 */
function coverResizeRgba(src, sw, sh, dw, dh) {
  const sc = Math.max(dw / sw, dh / sh);
  const cw = dw / sc, ch = dh / sc;                    // 需要从原图取的区域（原图像素）
  const ox = (sw - cw) / 2, oy = (sh - ch) / 2;
  const out = Buffer.alloc(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy0 = Math.max(0, Math.floor(oy + y * ch / dh));
    const sy1 = Math.min(sh, Math.max(sy0 + 1, Math.ceil(oy + (y + 1) * ch / dh)));
    for (let x = 0; x < dw; x++) {
      const sx0 = Math.max(0, Math.floor(ox + x * cw / dw));
      const sx1 = Math.min(sw, Math.max(sx0 + 1, Math.ceil(ox + (x + 1) * cw / dw)));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const o = (sy * sw + sx) * 4;
          r += src[o]; g += src[o + 1]; b += src[o + 2]; a += src[o + 3]; n++;
        }
      }
      const o = (y * dw + x) * 4;
      if (n) { out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n); out[o + 3] = Math.round(a / n); }
    }
  }
  return out;
}

/**
 * 从某个卡面 ID 的 chr10（卡面大图）生成缩略图像素 —— 注入新卡时如果用户没有单独取景，
 * 就用它兜底（比「复制克隆源的缩略图」正确得多：至少跟这张卡实际显示的画一致）。
 * 返回 { rgba, width, height, from } 或 null（加密包读不了等）。
 */
function thumbFromPictId(pkgRoot, pictId, size) {
  const A = require('./artmap');
  const { execFileSync } = require('child_process');
  const os = require('os');
  const plan = A.targetsFor(pkgRoot, Number(pictId));
  const t = plan.targets.find(x => x.key === 'chr10');
  if (!t || !t.editable || !t.width || !t.height) return null;
  const abs = path.join(pkgRoot, 'resource-set', t.bundlePath);
  const raw = require('./tmp').file('thumb-src-' + pictId, '.raw');
  try {
    execFileSync(A.BUNDLE_TOOL, ['export-texture', abs, t.texName, raw], { encoding: 'utf8' });
    const bgra = fs.readFileSync(raw);
    if (bgra.length !== t.width * t.height * 4) return null;
    // 存储方向(BGRA) → 显示方向(RGBA)：换通道 + 竖直翻
    const stride = t.width * 4;
    const rgba = Buffer.allocUnsafe(bgra.length);
    for (let y = 0; y < t.height; y++) {
      const srcRow = (t.height - 1 - y) * stride;
      for (let x = 0; x < t.width; x++) {
        const s = srcRow + x * 4, d = y * stride + x * 4;
        rgba[d] = bgra[s + 2]; rgba[d + 1] = bgra[s + 1]; rgba[d + 2] = bgra[s]; rgba[d + 3] = bgra[s + 3];
      }
    }
    const n = Number(size) || 160;
    // ★ 包里存的卡面是**预补偿**过的（纵向压扁 1/1.4、上下留透明，见 artwrite.js 顶部说明）。
    //   缩略图要的是「游戏里看起来的样子」，所以先把它拉回自然比例再缩放（结果和改之前一模一样）。
    const AW = require('./artwrite');
    const natural = AW.expandVerticalCentered(rgba, t.width, t.height, AW.CARD_FACE_PANEL_STRETCH);
    return { rgba: coverResizeRgba(natural, t.width, t.height, n, n), width: n, height: n, from: t.containerPath };
  } catch (e) {
    return null;
  } finally {
    try { fs.unlinkSync(raw); } catch { }
  }
}

/**
 * 把 RGBA 图按 cover/contain 缩到 tw×th（cover=裁满、contain=装进去留透明边）。
 * 放大立绘用 contain：背景已经抠成透明，四周留边看不出来，而且不会把人物裁掉。
 */
function fitRgba(src, sw, sh, tw, th, mode) {
  const contain = mode === 'contain';
  const sc = contain ? Math.min(tw / sw, th / sh) : Math.max(tw / sw, th / sh);
  const dw = Math.max(1, Math.round(sw * sc)), dh = Math.max(1, Math.round(sh * sc));
  const ox = Math.floor((tw - dw) / 2), oy = Math.floor((th - dh) / 2);
  const out = Buffer.alloc(tw * th * 4);        // 默认全 0 = 全透明
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor((y + 0.5) / sc));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.floor((x + 0.5) / sc));
      const s = (sy * sw + sx) * 4, d = ((oy + y) * tw + (ox + x)) * 4;
      out[d] = src[s]; out[d + 1] = src[s + 1]; out[d + 2] = src[s + 2]; out[d + 3] = src[s + 3];
    }
  }
  return out;
}

module.exports = { writeThumbnail, thumbPath, adminDir, verifyWithWic, pngSize, resealThumb, coverResizeRgba, fitRgba, thumbFromPictId, THUMB_TOOL };
