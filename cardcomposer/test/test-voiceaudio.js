#!/usr/bin/env node
/*
 * test-voiceaudio.js -- 「配音索引 + 试听」单元测试（只读，不改任何包）。
 *
 * 这块是 2026-09-24 实测出来的结构：配音在 CueSheet_Card_*.cpk 里，每个配音 ID 一个小 AWB，
 * 里面是**未加密的 CRI HCA**。这里盯住：索引对不对（名字数 == AFS2 数）、映射对不对、
 * 能不能解出波形（需要 tools\vgmstream）、找不到的 ID 要给人话错误。
 */
'use strict';
const fs = require('fs');
const V = require('../lib/voiceaudio');

const PKG = process.env.KAIRI_PKG || (process.env.KAIRI_PKG || require('../lib/tools').findPackage());
let bad = 0;
const ok = (c, m, d) => { console.log((c ? '  [OK]   ' : '  [FAIL] ') + m + (d ? '  ' + d : '')); if (!c) bad++; };

console.log('=== CPK 与索引 ===');
const cpks = V.listVoiceCpks(PKG);
ok(cpks.length >= 20, '找到卡牌配音 CPK', cpks.length + ' 个：' + cpks.slice(0, 4).join(', ') + ' …');
ok(cpks.every((f) => /^CueSheet_(Card|Legend)/.test(f)), '只挑卡牌配音的 CPK（没混进 BGM/SE/mov）');
const idx = V.voiceIndex(PKG);
ok(idx.total > 8000, '索引里的配音 ID 数量', String(idx.total));
ok(idx.cpks.every((c) => c.names === c.awbs), '★ 每个 CPK 里「<配音ID>.acb 名字数」== 「AFS2 个数」（名字和偏移一一对应）',
  idx.cpks.slice(0, 3).map((c) => c.cpk + ':' + c.names + '/' + c.awbs).join(' '));

console.log('\n=== 找具体配音 ===');
const e = V.findVoice(PKG, '600740010');
ok(!!e, '★ 找得到克隆源那张卡的配音 600740010', e ? (e.cpk + ' @' + e.offset + ' ' + e.size + ' 字节') : '(没有)');
ok(e && e.size > 4096 && e.size < 65536, '每句配音是个 6~64KB 的小文件', e ? String(e.size) : '-');
ok(e && e.offset > 0 && e.offset + e.size <= fs.statSync(require('path').join(V.cpkDir(PKG), e.cpk)).size,
  '偏移+大小落在 CPK 文件范围内');
ok(V.findVoice(PKG, '600740010').name === '600740010.acb', '文件名就是 <配音ID>.acb', e ? e.name : '-');
ok(V.findVoice(PKG, '000000000') === null, '不存在的 ID 返回 null（不抛异常）');
ok(V.findVoice(PKG, 'abc') === null, '非数字输入返回 null');

console.log('\n=== 切出来的确实是 AWB ===');
const carved = V.carveVoice(PKG, '600740010');
ok(!!carved && carved.data.length === carved.size, '切出的字节数和索引一致', carved ? String(carved.data.length) : '-');
ok(!!carved && carved.data.toString('latin1', 0, 4) === 'AFS2', '开头是 AFS2（CRI AWB 容器）', carved ? JSON.stringify(carved.data.toString('latin1', 0, 4)) : '-');

console.log('\n=== 解码 / 试听 ===');
if (!V.hasDecoder()) {
  ok(false, '需要解码器 tools\\vgmstream\\vgmstream-cli.exe（inspect\\fetch-vgmstream.js 能下载）', V.vgmstreamPath());
} else {
  ok(true, '解码器就位', V.vgmstreamPath());
  const info = V.probeVoice(PKG, '600740010');
  ok(info.ok && /HCA/.test(String(info.encoding)), '★ 里面是 CRI HCA（且不带 key 就能读 ⇒ 没加密）', JSON.stringify(info.encoding));
  ok(info.ok && info.rate === 22050 && info.channels === 1, '官方配音的格式：22050Hz 单声道', (info.rate || '?') + 'Hz ' + (info.channels || '?') + 'ch');
  const dec = V.decodeVoiceToWav(PKG, '600740010', { force: true });
  ok(dec.ok && dec.bytes > 10000, '解成 wav 成功', dec.ok ? (dec.bytes + ' 字节 ≈ ' + dec.seconds + ' 秒') : dec.error);
  ok(dec.ok && dec.seconds > 0.5 && dec.seconds < 15, '一句台词的时长合理（0.5~15 秒）', dec.ok ? String(dec.seconds) : '-');
  const again = V.decodeVoiceToWav(PKG, '600740010');
  ok(again.ok && again.cached === true, '第二次走缓存（不重复解码）', String(again.cached));
  const bad2 = V.decodeVoiceToWav(PKG, '000000000');
  ok(!!bad2.error && /不在包里/.test(bad2.error), '不存在的 ID 给人话错误', String(bad2.error));
  // 换一个 CPK 里的配音（确认跨 CPK 也能找到并解开）
  const other = [...idx.byVoiceId.values()].find((x) => x.cpk !== e.cpk);
  const dec2 = V.decodeVoiceToWav(PKG, other.voiceId);
  ok(dec2.ok && dec2.seconds > 0.2, '另一个 CPK 里的配音也能解（' + other.cpk + '）', dec2.ok ? (other.voiceId + ' ' + dec2.seconds + 's') : dec2.error);
}

console.log('\n' + (bad === 0 ? '=== VOICE AUDIO TEST PASSED ===' : '=== ' + bad + ' FAILURE(S) ==='));
process.exit(bad === 0 ? 0 : 1);
