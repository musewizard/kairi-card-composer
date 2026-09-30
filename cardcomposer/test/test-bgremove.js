#!/usr/bin/env node
/*
 * test-bgremove.js -- 抠背景（把纯色背景变透明）的单测。
 *
 * 为什么必须抠：实测官方资源 chr20 有 20.7%/26.9% 的像素**完全透明**、chr10 有 41.1%
 * （还有 38.8% 半透明）—— 官方卡面/图标都是抠好的立绘。不抠的话游戏里圆形图标位会露出
 * 「白色方块」（用户 2026-09-24 报的）。这个测试盯住：
 *   · 白底要抠掉（四角透明、人物保留、**人物内部的白色**不能被误伤）
 *   · 满版插画（边框颜色不统一）不许乱抠
 *   · 本来就透明的图不重复抠
 *   · 抠过头（>80%）要整个撤回
 *   · fitRgba 的 contain/cover 行为
 */
'use strict';
const WORK_ROOT = process.env.KAIRI_ROOT || require('../lib/tools').ROOT;
const fs = require('fs');
const path = require('path');
const B = require('../lib/bgremove');
const T = require('../lib/thumb');

let bad = 0;
const ok = (c, m, d) => { console.log((c ? '  [OK]   ' : '  [FAIL] ') + m + (d ? '  ' + d : '')); if (!c) bad++; };
const W = 64, H = 64;

function canvas(fill) {
  const b = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) { b[i * 4] = fill[0]; b[i * 4 + 1] = fill[1]; b[i * 4 + 2] = fill[2]; b[i * 4 + 3] = fill.length > 3 ? fill[3] : 255; }
  return b;
}
const setPx = (b, x, y, c) => { const o = (y * W + x) * 4; b[o] = c[0]; b[o + 1] = c[1]; b[o + 2] = c[2]; b[o + 3] = c.length > 3 ? c[3] : 255; };
const getA = (b, x, y) => b[(y * W + x) * 4 + 3];
const getRgb = (b, x, y) => [b[(y * W + x) * 4], b[(y * W + x) * 4 + 1], b[(y * W + x) * 4 + 2]];

console.log('=== 白底 + 中间一个方块 + 方块内部有个白洞 ===');
{
  const b = canvas([255, 255, 255]);
  for (let y = 16; y < 48; y++) for (let x = 16; x < 48; x++) setPx(b, x, y, [200, 30, 30]);
  for (let y = 28; y < 36; y++) for (let x = 28; x < 36; x++) setPx(b, x, y, [255, 255, 255]);   // 内部白洞
  const r = B.removeBackground(b, W, H, {});
  ok(r.ok, '抠成功', r.share || '');
  ok(getA(b, 0, 0) === 0 && getA(b, W - 1, H - 1) === 0, '四角变成透明');
  ok(getA(b, 32, 20) === 255, '人物的红色像素保留（不透明）', 'alpha=' + getA(b, 32, 20));
  ok(getA(b, 32, 32) === 255, '★ 人物**内部**的白色没被误伤（泛洪只抠和边框连通的）', 'alpha=' + getA(b, 32, 32));
  ok(JSON.stringify(getRgb(b, 32, 20)) === '[200,30,30]', '颜色没被改，只改了 alpha');
}

console.log('\n=== 满版插画（边框颜色乱）不该抠 ===');
{
  const b = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) setPx(b, x, y, [(x * 7) % 256, (y * 11) % 256, (x * y) % 256]);
  const before = Buffer.from(b);
  const r = B.removeBackground(b, W, H, {});
  ok(!r.ok && /满版图/.test(String(r.reason)), '明确说「看起来是满版图，不抠」', String(r.reason));
  ok(Buffer.compare(before, b) === 0, '一个像素都没动');
}

console.log('\n=== 本来就透明的图，不重复抠 ===');
{
  const b = canvas([255, 255, 255]);
  for (let y = 0; y < H; y++) for (let x = 0; x < 10; x++) setPx(b, x, y, [0, 0, 0, 0]);      // 左边一条透明
  const before = Buffer.from(b);
  const r = B.removeBackground(b, W, H, {});
  ok(r.ok && /已经是透明背景/.test(String(r.reason)), '识别出「本来就已经是透明背景」', String(r.reason));
  ok(Buffer.compare(before, b) === 0, '还是没动它');
}

console.log('\n=== 抠过头要撤回 ===');
{
  const b = canvas([255, 255, 255]);                       // 几乎全白，只有中心 4 个像素有颜色
  for (let y = 31; y < 33; y++) for (let x = 31; x < 33; x++) setPx(b, x, y, [10, 10, 10]);
  const before = Buffer.from(b);
  const r = B.removeBackground(b, W, H, {});
  ok(!r.ok && /撤回/.test(String(r.reason)), '抠掉太多 → 撤回并说明', String(r.reason));
  ok(Buffer.compare(before, b) === 0, '图没被毁');
}

console.log('\n=== fitRgba：contain 装进去 / cover 裁满 ===');
{
  const src = canvas([9, 200, 9]);
  for (let y = 0; y < 20; y++) for (let x = 0; x < 80; x++) setPx(src, x, y, [200, 9, 9]);   // 64x64 里画一条 80 宽（越界截断）
  const con = T.fitRgba(src, W, H, 32, 32, 'contain');
  ok(con.length === 32 * 32 * 4, 'contain 尺寸对');
  const cov = T.fitRgba(src, W, H, 32, 32, 'cover');
  ok(cov.length === 32 * 32 * 4, 'cover 尺寸对');
  // contain：整张 64×64 缩到 32×32 ⇒ 每一格都有内容（这里源图不透明，所以全都 alpha=255）
  ok(con[3] === 255 && cov[3] === 255, '两种模式都没丢 alpha');
  // 非正方形源 + contain：上下（或左右）应该留透明边
  const wide = T.fitRgba(src, 64, 16, 32, 32, 'contain');
  ok(wide[3] === 0 || wide[(31 * 32 + 31) * 4 + 3] === 0, '非正方形 contain 会留透明边（不会拉伸）');
  const wideCover = T.fitRgba(src, 64, 16, 32, 32, 'cover');
  ok(wideCover[3] === 255, 'cover 填满、不留边');
}

console.log('\n=== 真实素材（用户那张白底原图，有就测）===');
{
  const raw = (WORK_ROOT + '/inspect/bgtest/user-src.raw');
  if (!fs.existsSync(raw)) console.log('  （没有 ' + raw + '，跳过）');
  else {
    const meta = JSON.parse(fs.readFileSync((WORK_ROOT + '/inspect/bgtest/user-src.json'), 'utf8').replace(/^\uFEFF/, ''));
    const b = Buffer.from(fs.readFileSync(raw));
    const r = B.removeBackground(b, meta.w, meta.h, {});
    ok(r.ok && r.transparent > meta.w * meta.h * 0.05, '用户那张白底图抠掉 >5%', r.share);
    ok(b[3] === 0 && b[(meta.w * meta.h - 1) * 4 + 3] === 0, '四角透明');
    ok(b[((meta.h >> 1) * meta.w + (meta.w >> 1)) * 4 + 3] === 255, '中心（人物）不透明');
  }
}

console.log('\n' + (bad === 0 ? '=== BGRemove TEST PASSED ===' : '=== ' + bad + ' FAILURE(S) ==='));
process.exit(bad === 0 ? 0 : 1);
