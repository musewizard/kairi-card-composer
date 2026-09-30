'use strict';
/*
 * webp.js -- 一个「够用就好」的 VP8L（WebP 无损）编码器。
 *
 * 为什么自己写：卡面缩略图是 `_local/control/server/cn602-admin-assets/card/<卡号>.webp`
 * （160×160 无损 WebP），而**这台机器上没有任何 WebP 编码器**：
 *   · Windows 的 WebP Image Extension（已装）AppxManifest 里写着 "This is a Webp decoder"，
 *     WIC 里只有解码器，没有编码器；
 *   · 没有 cwebp / ffmpeg / ImageMagick，没有 NuGet 缓存里能编码 WebP 的库。
 * 所以这里直接按 WebP 无损位流规范写一个**最小**编码器：
 *   · 不做任何变换（无预测/无减绿/无色彩索引）、不用色彩缓存、单 Huffman 组、不用回引；
 *   · 四个通道各用一个「所有符号长度都是 8 bit」的完备 Huffman 码 ⇒ 每像素 4 字节，
 *     即「无损但不压缩」：160×160 缩略图约 12.8 KB（官方那些压缩过的约 42 KB，无所谓）。
 * 正确性由 WIC 解码器回读验证（tools\thumb-tool check），像素必须逐字节一致。
 *
 * 位流要点（LSB-first）：
 *   0x2F | 宽-1(14) | 高-1(14) | alpha_used(1) | version(3)=0
 *   变换循环 1 bit = 0；色彩缓存 1 bit = 0；meta-Huffman 1 bit = 0
 *   5 个 Huffman 码表（green(280) red(256) blue(256) alpha(256) distance(40)）：
 *     前四个用「复杂码」：num_code_lengths-4(4) + 每个 3 bit（顺序 kCodeLengthCodeOrder）
 *     这里只用两个码长符号 {0, 8}，各 1 bit ⇒ 0 的码是 0、8 的码是 1，
 *     然后连发 256 个「8」（256 bit）—— 第 256 个之后码就完备了，解码器会停下；
 *     distance 用「简单码」：1 个符号（符号 0，1 bit 码），因为根本不会有距离码。
 *   像素按行从上到下：每个像素 green(8) red(8) blue(8) alpha(8)
 */
const K_CODE_LENGTH_CODE_ORDER = [17, 18, 0, 1, 2, 3, 4, 5, 16, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

class BitWriter {
  constructor() { this.bytes = []; this.acc = 0; this.n = 0; }
  put(value, bits) {
    for (let i = 0; i < bits; i++) {
      this.acc |= ((value >>> i) & 1) << this.n;
      if (++this.n === 8) { this.bytes.push(this.acc); this.acc = 0; this.n = 0; }
    }
  }
  /** Huffman 码字要按「规范顺序」逐位写：先写最高位（实测：反了的话颜色会变成位反序） */
  putCode(code, len) {
    for (let i = len - 1; i >= 0; i--) this.put((code >>> i) & 1, 1);
  }
  finish() {
    if (this.n) { this.bytes.push(this.acc); this.acc = 0; this.n = 0; }
    return Buffer.from(this.bytes);
  }
}

/** 四个通道的「全部符号长度 8」的复杂码表 */
function putFlatCode(bw, alphabetSize) {
  bw.put(0, 1);                                   // 复杂码（不是简单码）
  bw.put(12 - 4, 4);                              // num_code_lengths = 12（要够到顺序里的符号 8）
  for (const sym of K_CODE_LENGTH_CODE_ORDER.slice(0, 12)) {
    bw.put(sym === 0 || sym === 8 ? 1 : 0, 3);    // 只用码长符号 0 和 8，各 1 bit ⇒ 完备
  }
  bw.put(0, 1);                                   // use_length = 0（不额外限制 max_symbol）
  // ★ 解码器会一直读到「符号数 = 整个字母表大小」为止（vp8l_dec.c 的 ReadHuffmanCodeLengths
  //   没有「码完备就停」的分支），所以**必须把整个字母表都写完**：
  //   绿通道 280 个 = 256 个「长度 8」+ 24 个「长度 0」（长度前缀码用不到）。
  for (let s = 0; s < alphabetSize; s++) bw.put(s < 256 ? 1 : 0, 1);
}

/**
 * @param rgba Buffer/Uint8Array，RGBA 顺序（显示方向，逐行从上到下）
 * @param w,h  尺寸
 * @returns Buffer（完整 .webp 文件）
 */
function encodeVp8lLossless(rgba, w, h) {
  if (rgba.length !== w * h * 4) throw new Error('RGBA 长度不对: ' + rgba.length + '，期望 ' + (w * h * 4));
  const bw = new BitWriter();
  bw.put(0x2f, 8);
  bw.put(w - 1, 14);
  bw.put(h - 1, 14);
  let hasAlpha = false;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) { hasAlpha = true; break; }
  bw.put(hasAlpha ? 1 : 0, 1);
  bw.put(0, 3);                                   // version = 0
  bw.put(0, 1);                                   // 没有变换
  bw.put(0, 1);                                   // 没有色彩缓存
  bw.put(0, 1);                                   // 单 Huffman 组（没有 meta huffman）
  putFlatCode(bw, 280);                           // green + 长度码
  putFlatCode(bw, 256);                           // red
  putFlatCode(bw, 256);                           // blue
  putFlatCode(bw, 256);                           // alpha
  // distance：简单码，1 个符号（符号 0）
  bw.put(1, 1);                                   // 简单码
  bw.put(0, 1);                                   // num_symbols - 1 = 0 → 1 个符号
  bw.put(0, 1);                                   // 第一个符号用 1 bit 表示
  bw.put(0, 1);                                   // 符号 = 0
  // 像素数据：green, red, blue, alpha（每个都是 8 bit 的码字，规范顺序逐位写）
  for (let i = 0; i < rgba.length; i += 4) {
    bw.putCode(rgba[i + 1], 8);
    bw.putCode(rgba[i + 0], 8);
    bw.putCode(rgba[i + 2], 8);
    bw.putCode(rgba[i + 3], 8);
  }
  const payload = bw.finish();
  const chunks = [Buffer.from('VP8L', 'ascii')];
  const size = Buffer.alloc(4);
  size.writeUInt32LE(payload.length, 0);
  chunks.push(size, payload);
  if (payload.length % 2) chunks.push(Buffer.from([0]));       // RIFF 要求偶数长度
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(4);
  head.writeUInt32LE(4 + body.length, 0);                     // 'WEBP' + chunks
  return Buffer.concat([Buffer.from('RIFF', 'ascii'), head, Buffer.from('WEBP', 'ascii'), body]);
}

module.exports = { encodeVp8lLossless };
