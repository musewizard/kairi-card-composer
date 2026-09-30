'use strict';
/*
 * bgremove.js -- 把「背景色」抠成透明（官方卡面就是这么做的）
 *
 * 实测官方资源（2026-09-24）：
 *   chr20 图标  20.7% / 26.9% 的像素是**完全透明**的（还有 1.5%~9% 半透明）
 *   chr10 卡面  41.1% 完全透明 + 38.8% 半透明
 * 也就是说官方卡面/图标都是**抠好的立绘**（背景透明），游戏里卡框、圆形图标位靠的就是这个 alpha。
 * 我第一版把用户给的图直接方形裁剪、背景留白 ⇒ 圆形图标位会出现「白色方块溢出圆形」，
 * 演出/卡面也会带一块白底。
 *
 * 做法：从**四边**做泛洪（flood fill），只把「和边框同色且与边框连通」的区域设成透明：
 *   · 主体内部的白色（书页、眼睛高光…）跟边框不连通，不会被误伤；
 *   · 边缘做一圈「羽化」：紧贴背景、颜色接近但没达到阈值的像素按距离给部分 alpha，
 *     免得留下白边（JPEG 边缘本来就有过渡色）。
 * 判定不了（边框颜色本身就不统一，例如整幅满版插画）时**什么都不做**，原样返回。
 */

/** 两色距离（0..441），用 max 通道差更好用 */
function colorDist(a, b) { return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2])); }

function borderColor(rgba, w, h) {
  // 四边各取一批样本（避开最角上两个像素），求「出现最多的那个颜色」
  const tally = new Map();
  let total = 0;
  const push = (i) => {
    // 4bit 量化：JPEG 的白底会有 ±3 的噪声，量化粗一点才聚得起来
    const key = (rgba[i] >> 4) + ',' + (rgba[i + 1] >> 4) + ',' + (rgba[i + 2] >> 4);
    const e = tally.get(key) || { n: 0, r: 0, g: 0, b: 0 };
    e.n++; e.r += rgba[i]; e.g += rgba[i + 1]; e.b += rgba[i + 2];
    tally.set(key, e);
    total++;
  };
  for (let x = 1; x < w - 1; x++) { push((0 * w + x) * 4); push(((h - 1) * w + x) * 4); }
  for (let y = 1; y < h - 1; y++) { push((y * w) * 4); push((y * w + w - 1) * 4); }
  let best = null;
  for (const e of tally.values()) if (!best || e.n > best.n) best = e;
  if (!best || !total) return null;
  const c = [Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n)];
  return { color: c, share: best.n / total, kinds: tally.size, total };
}

/**
 * @param rgba Buffer/Uint8Array（会被就地改 alpha）
 * @param opts { tolerance=42, feather=96, minShare }
 * @returns { ok, transparent, feathered, color, reason }
 */
function removeBackground(rgba, w, h, opts) {
  const o = opts || {};
  const TOL = o.tolerance === undefined ? 42 : o.tolerance;          // 判定为背景的阈值
  const FEATHER = o.feather === undefined ? 96 : o.feather;          // 羽化阈值（更大）
  const out = { ok: false, transparent: 0, feathered: 0, color: null, reason: '' };
  // ★ 已经自带透明像素的图（例如放大立绘用「装进去」留的透明边）就别再抠了：
  //   那时候边框颜色会是 (0,0,0)，按黑色一抠有可能啃到人物的深色描边。
  let already = 0;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] === 0) { already++; if (already > rgba.length / 4 * 0.01) break; }
  if (already > rgba.length / 4 * 0.01) {
    out.ok = true; out.transparent = already;
    out.share = (100 * already / (rgba.length / 4)).toFixed(1) + '%';
    out.reason = '本来就已经是透明背景，不用抠';
    return out;
  }
  const bc = borderColor(rgba, w, h);
  if (!bc) { out.reason = '读不到边框颜色'; return out; }
  out.color = bc.color;
  // 边框上「主色」占比太低 ⇒ 大概是满版插画（没有纯色背景），别乱抠。
  // 用户那种白底图：白占边框 60%~90%（底部可能有阴影/头发压边）⇒ 该抠。
  const minShare = o.minShare === undefined ? 0.3 : o.minShare;
  if (bc.share < minShare && !o.force) {
    out.reason = '边框主色只占 ' + (100 * bc.share).toFixed(0) + '%（' + bc.kinds + ' 种颜色），看起来是满版图，不抠';
    return out;
  }

  const n = w * h;
  const isBg = new Uint8Array(n);
  const stack = new Int32Array(n);
  let sp = 0;
  const near = (i, tol) => {
    const p = i * 4;
    return colorDist([rgba[p], rgba[p + 1], rgba[p + 2]], bc.color) <= tol;
  };
  // 种子：四边所有「接近背景色」的像素
  for (let x = 0; x < w; x++) {
    for (const y of [0, h - 1]) { const i = y * w + x; if (!isBg[i] && near(i, TOL)) { isBg[i] = 1; stack[sp++] = i; } }
  }
  for (let y = 0; y < h; y++) {
    for (const x of [0, w - 1]) { const i = y * w + x; if (!isBg[i] && near(i, TOL)) { isBg[i] = 1; stack[sp++] = i; } }
  }
  // 泛洪（4 邻域）
  while (sp > 0) {
    const i = stack[--sp];
    const x = i % w, y = (i - x) / w;
    if (x > 0 && !isBg[i - 1] && near(i - 1, TOL)) { isBg[i - 1] = 1; stack[sp++] = i - 1; }
    if (x < w - 1 && !isBg[i + 1] && near(i + 1, TOL)) { isBg[i + 1] = 1; stack[sp++] = i + 1; }
    if (y > 0 && !isBg[i - w] && near(i - w, TOL)) { isBg[i - w] = 1; stack[sp++] = i - w; }
    if (y < h - 1 && !isBg[i + w] && near(i + w, TOL)) { isBg[i + w] = 1; stack[sp++] = i + w; }
  }
  // 落地：背景 alpha=0；紧贴背景的、颜色接近的像素按距离羽化
  let transparent = 0, feathered = 0;
  const undo = [];
  for (let i = 0; i < n; i++) {
    if (isBg[i]) {
      const p = i * 4 + 3;
      undo.push(p, rgba[p]);
      rgba[p] = 0; transparent++;
      continue;
    }
    const x = i % w, y = (i - x) / w;
    const touchBg = (x > 0 && isBg[i - 1]) || (x < w - 1 && isBg[i + 1]) || (y > 0 && isBg[i - w]) || (y < h - 1 && isBg[i + w]);
    if (!touchBg) continue;
    const p = i * 4;
    const d = colorDist([rgba[p], rgba[p + 1], rgba[p + 2]], bc.color);
    if (d < FEATHER) {
      const a = Math.round(255 * (d / FEATHER));
      if (a < rgba[p + 3]) { undo.push(p + 3, rgba[p + 3]); rgba[p + 3] = a; feathered++; }
    }
  }
  // 保险：抠得太狠（>80%）说明泛洪可能从人物贴边处漏进去了 —— 整个撤回，别毁图
  const maxFrac = o.maxFraction === undefined ? 0.8 : o.maxFraction;
  if (transparent > n * maxFrac) {
    for (let k = 0; k < undo.length; k += 2) rgba[undo[k]] = undo[k + 1];
    out.reason = '抠掉了 ' + (100 * transparent / n).toFixed(0) + '%（太多，可能漏进人物里了），已撤回';
    return out;
  }
  out.transparent = transparent;
  out.feathered = feathered;
  out.ok = out.transparent > n * 0.01;                 // 至少抠掉 1% 才算成功（防止误判）
  out.share = (100 * out.transparent / n).toFixed(1) + '%';
  if (!out.ok && !out.reason) out.reason = '几乎没抠到背景（可能本来就没有纯色背景）';
  return out;
}

module.exports = { removeBackground, borderColor, colorDist };
