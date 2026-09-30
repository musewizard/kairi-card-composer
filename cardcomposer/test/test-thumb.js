#!/usr/bin/env node
/*
 * test-thumb.js -- 卡面缩略图（160×160 无损 WebP）的单元测试。
 *
 * 为什么要有：这台机器上**没有任何 WebP 编码器**（Windows 的 Webp Image Extension 只带解码器），
 * 所以编码器是自己写的（lib\webp.js: 一个最小 VP8L 编码器）。这个测试盯住：
 *   · 文件结构是 RIFF/WEBP/VP8L，尺寸字段对；
 *   · 真拿 Windows WIC（ThumbTool）解回来，像素逐字节一致（这是「能不能用」的唯一标准）；
 *   · write:false 不写盘；RGBA 长度不对要明确报错。
 * 真包上的端到端（写进包 + /thumb 路由 + 还原）见 inspect\thumb-e2e.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { encodeVp8lLossless } = require('../lib/webp');
const T = require('../lib/thumb');

let bad = 0;
const ok = (c, m, d) => { console.log((c ? '  [OK]   ' : '  [FAIL] ') + m + (d ? '  ' + d : '')); if (!c) bad++; };
const OUT = require('../lib/tmp').dir('thumb');

function pattern(w, h, tag) {
  const b = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    b[o] = (x * 3 + y * 7 + tag) & 0xff;
    b[o + 1] = (x * 11 + y * 5 + tag * 3) & 0xff;
    b[o + 2] = (x * 17 + y * 13 + tag * 5) & 0xff;
    b[o + 3] = (tag % 3 === 0) ? 255 : ((x + y) & 0xff);
  }
  return b;
}

console.log('=== VP8L 文件结构 ===');
const px = pattern(160, 160, 1);
const webp = encodeVp8lLossless(px, 160, 160);
ok(webp.slice(0, 4).toString('ascii') === 'RIFF' && webp.slice(8, 12).toString('ascii') === 'WEBP', 'RIFF/WEBP 容器头');
ok(webp.slice(12, 16).toString('ascii') === 'VP8L', 'chunk 是 VP8L（无损）');
ok(webp.readUInt32LE(4) === webp.length - 8, 'RIFF 长度字段对', webp.readUInt32LE(4) + ' vs ' + (webp.length - 8));
ok(webp.readUInt32LE(16) === webp.length - 20 || webp.readUInt32LE(16) === webp.length - 20 - 1, 'chunk 长度字段对（可能补一个填充字节）',
  webp.readUInt32LE(16) + ' vs ' + (webp.length - 20));
ok(webp[20] === 0x2f, 'VP8L 签名 0x2F', '0x' + webp[20].toString(16));
const bits = webp.readUInt32LE(21);
ok((bits & 0x3fff) + 1 === 160 && ((bits >> 14) & 0x3fff) + 1 === 160, '宽高字段 = 160×160',
  ((bits & 0x3fff) + 1) + '×' + (((bits >> 14) & 0x3fff) + 1));
ok(webp.length < 160 * 160 * 4 + 200, '大小合理（无损不压缩）', (webp.length / 1024).toFixed(1) + ' KB');

console.log('\n=== Windows WIC 回读（唯一标准）===');
const TT = T.THUMB_TOOL;
if (!fs.existsSync(TT)) {
  console.log('  （ThumbTool 没编译，跳过 WIC 回读）');
} else {
  for (const [w, h, tag] of [[160, 160, 1], [160, 160, 3], [1, 1, 2], [7, 5, 4]]) {
    const f = path.join(OUT, 't-' + w + 'x' + h + '-' + tag + '.webp');
    const raw = path.join(OUT, 't-' + w + 'x' + h + '-' + tag + '.raw');
    const src = pattern(w, h, tag);
    fs.writeFileSync(f, encodeVp8lLossless(src, w, h));
    let out = '';
    try { out = execFileSync(TT, ['check', f, raw], { encoding: 'utf8' }); }
    catch (e) { ok(false, w + '×' + h + ' WIC 解不开', String(e.stderr || e.message).split('\n')[0]); continue; }
    const back = fs.readFileSync(raw);
    let diff = 0;
    for (let i = 0; i < src.length; i += 4) {
      if (back[i] !== src[i + 2] || back[i + 1] !== src[i + 1] || back[i + 2] !== src[i] || back[i + 3] !== src[i + 3]) diff++;
    }
    ok(/\d+x\d+/.test(out) && diff === 0, w + '×' + h + (tag % 3 === 0 ? '（不透明）' : '（带透明）') + ' WIC 解回来像素逐字节一致',
      diff === 0 ? (w * h) + ' 个像素全对' : diff + ' 个像素不同');
  }
}

console.log('\n=== writeThumbnail（假包，不碰真包）===');
const fake = path.join(OUT, 'pkg');
fs.mkdirSync(path.join(fake, 'resource-set', '_local', 'control', 'server', 'cn602-admin-assets', 'card'), { recursive: true });
const r1 = T.writeThumbnail(fake, 12345, pattern(160, 160, 5), 160, 160, { write: false, reseal: false });
ok(!r1.error && !r1.wrote && r1.bytes > 0, 'write:false：算出字节数但不写', r1.note || '');
ok(!fs.existsSync(r1.path), 'write:false 时文件真的没生成');
const r2 = T.writeThumbnail(fake, 12345, pattern(160, 160, 5), 160, 160, { write: true, reseal: false, verify: false });
ok(r2.wrote && fs.existsSync(r2.path), 'write:true 会写文件', path.basename(r2.path));
ok(r2.relative === '_local/control/server/cn602-admin-assets/card/12345.webp' || r2.relative.endsWith('12345.webp'),
  '相对路径对（在资源集里）', r2.relative);
const r3 = T.writeThumbnail(fake, 12345, pattern(160, 160, 6), 160, 160, { write: true, reseal: false, verify: false });
ok(r3.replaced === true, '第二次写知道是「替换」而不是新建', 'oldBytes=' + r3.oldBytes);
const r4 = T.writeThumbnail(fake, 12345, Buffer.alloc(10), 160, 160, { write: true, reseal: false });
ok(r4.error && /长度不对/.test(String(r4.note)), 'RGBA 长度不对时明确报错', String(r4.note));

console.log('\n=== coverResizeRgba（从卡面大图缩到 160×160）===');
{
  const src = pattern(64, 40, 3);                 // 非正方形 + 全不透明（tag%3===0）：必须 cover 裁切，不能拉伸变形
  const out = T.coverResizeRgba(src, 64, 40, 32, 32);
  ok(out.length === 32 * 32 * 4, '尺寸对（32×32×4 字节）', out.length + ' 字节');
  ok(out[((16 * 32) + 16) * 4 + 3] === 255, 'alpha 保住了');
  ok(T.coverResizeRgba(src, 64, 40, 160, 160).length === 160 * 160 * 4, '缩到 160×160 也对');
  ok(T.coverResizeRgba(src, 64, 40, 1, 1).length === 4, '缩到 1×1 不炸');
}

console.log('\n=== 从卡面大图直接生成缩略图（真包，只读）===');
{
  const PKG = (process.env.KAIRI_PKG || require('../lib/tools').findPackage());
  if (!fs.existsSync(PKG)) { console.log('  （没有真包，跳过）'); }
  else {
    const px = T.thumbFromPictId(PKG, 91000953, 160);          // 明文包，能读
    ok(!!px && px.width === 160 && px.rgba.length === 160 * 160 * 4, '从 chr10 生成 160×160 像素',
      px ? String(px.from) : 'null');
    if (px) {
      const f = path.join(OUT, 'from-chr10.webp');
      fs.writeFileSync(f, encodeVp8lLossless(px.rgba, 160, 160));
      try {
        const out = execFileSync(T.THUMB_TOOL, ['check', f], { encoding: 'utf8' });
        ok(/160x160/.test(out) && /OK/.test(out), 'WIC 能读它（能直接拿去当缩略图）', out.trim().split('\n')[0]);
      } catch (e) { ok(false, 'WIC 读不了生成的缩略图', String(e.stderr || e.message).split('\n')[0]); }
    }
    ok(T.thumbFromPictId(PKG, 10152034, 160) === null, '加密包读不了时返回 null（调用方回退到复制）');
  }
}

fs.rmSync(OUT, { recursive: true, force: true });
console.log('\n' + (bad === 0 ? '=== THUMB TEST PASSED ===' : '=== ' + bad + ' FAILURE(S) ==='));
process.exit(bad === 0 ? 0 : 1);
