'use strict';
/*
 * voiceaudio.js -- 读游戏里的「配音音频」（只读 + 试听），也是以后「自定义配音」的地基。
 *
 * ★ 2026-09-24 实测出来的结构（别再从头查）：
 *   配音在 `resource-set/resources/cpk/CueSheet_Card_<0..21,97,98,99>.cpk` 里（另有 CueSheet_Legend_0）。
 *   每个 CPK 是 CRI CPK 容器：头部 16 字节 + @UTF 头表 + `(c)CRITOC` + 一个 **明文** @UTF 文件表
 *   （列：DirName/FileName/FileSize/ExtractSize/FileOffset/ID/UserString，**没有 CRC 列**），
 *   文件表里的名字就是 **<配音ID>.acb**（例：600010010.acb）。
 *   每个这样的文件其实是 **一个 AFS2(AWB) 容器**（6~40 KB），里面是**一段 CRI HCA 音频**
 *   （22050 Hz 单声道，2~3 秒 = 一句台词）。
 *   ★ HCA **没有加密**（vgmstream 不带 key 就能解出波形）—— 这点很关键：
 *     意味着「换掉某个配音的音频」在格式上是可能的（剩下的问题是 HCA **编码器**）。
 *
 * 名字与偏移的对应关系：文件表里的名字按顺序排列，磁盘上 AFS2 也按同样顺序排列，
 * 两边个数一一对应（实测 CueSheet_Card_0：1320 个名字 = 1320 个 AFS2）——
 * 所以不用完整解析 CPK 文件表就能建立「配音ID → 文件偏移/大小」的映射。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const TOOLS = require('./tools').toolsRoot();
const VGMSTREAM = require('./tools').vgmstream();
const CACHE = path.join(__dirname, '..', 'cache', 'voice');

const CARD_CPK_RE = /^CueSheet_(Card|Legend)_?\d*\.cpk$/i;
const NAME_RE = /([0-9]{9})\.acb/g;

function cpkDir(pkgRoot) { return path.join(pkgRoot, 'resource-set', 'resources', 'cpk'); }

/** 列出包里所有「卡牌配音」CPK（含 Legend）。 */
function listVoiceCpks(pkgRoot) {
  const dir = cpkDir(pkgRoot);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => CARD_CPK_RE.test(f)).sort();
}

/** 读一个 CPK 的「配音ID → 偏移/大小」索引（只读文件头部 + 扫 AFS2 位置，很快）。 */
function readCpkVoiceIndex(pkgRoot, cpkName) {
  const p = path.join(cpkDir(pkgRoot), cpkName);
  const buf = fs.readFileSync(p);
  const latin = buf.toString('latin1');
  // 名字：从 (c)CRITOC 的表里按出现顺序取（表在文件头部，但整段扫描更稳）
  const names = [];
  NAME_RE.lastIndex = 0;
  let m;
  while ((m = NAME_RE.exec(latin))) names.push({ id: m[1], name: m[0], at: m.index });
  // AFS2 偏移
  const offsets = [];
  let i = -1;
  while ((i = latin.indexOf('AFS2', i + 1)) >= 0) offsets.push(i);
  // 按名字出现的顺序（表里是文件名，顺序 = 文件顺序）与 AFS2 顺序一一对应
  const entries = names.map((n, k) => ({
    voiceId: n.id,
    name: n.name,
    cpk: cpkName,
    index: k,
    offset: offsets[k],
    size: (k + 1 < offsets.length ? offsets[k + 1] : buf.length) - offsets[k],
  })).filter((e) => e.offset > 0);
  // 名字有可能和 AFS2 数量不一致（防御）：不一致就只用前面 min 个
  return { cpk: cpkName, cpkBytes: buf.length, names: names.length, awbs: offsets.length, entries };
}

/** 只看 CPK 头部就能拿到「这个 CPK 里有哪些配音 ID」（文件表在前 ~256KB 内）。 */
function readCpkNames(pkgRoot, cpkName, headBytes) {
  const p = path.join(cpkDir(pkgRoot), cpkName);
  const size = fs.statSync(p).size;
  const len = Math.min(size, headBytes || 256 * 1024);
  const fd = fs.openSync(p, 'r');
  const head = Buffer.alloc(len);
  try { fs.readSync(fd, head, 0, len, 0); } finally { fs.closeSync(fd); }
  const latin = head.toString('latin1');
  const ids = [];
  NAME_RE.lastIndex = 0;
  let m;
  while ((m = NAME_RE.exec(latin))) ids.push(m[1]);
  return { cpk: cpkName, bytes: size, ids, truncated: len < size };
}

const _nameCache = new Map();
/** 全部卡牌配音 CPK 里的配音 ID（只读文件头，很快；列表/挑选用）。 */
function listVoiceIds(pkgRoot) {
  const key = path.resolve(pkgRoot);
  if (_nameCache.has(key)) return _nameCache.get(key);
  const byId = new Map();       // id -> cpk
  const cpks = [];
  for (const cpk of listVoiceCpks(pkgRoot)) {
    try {
      const r = readCpkNames(pkgRoot, cpk);
      cpks.push({ cpk, count: r.ids.length, bytes: r.bytes, truncated: r.truncated });
      for (const id of r.ids) if (!byId.has(id)) byId.set(id, cpk);
    } catch (e) { /* 跳过读不了的 */ }
  }
  const out = { cpks, byVoiceId: byId, total: byId.size };
  _nameCache.set(key, out);
  return out;
}

/** 读一个 CPK 的「配音ID → 偏移/大小」索引（这个要整文件扫 AFS2 位置，按 CPK 缓存）。 */
const _cpkIndexCache = new Map();
function cpkVoiceIndex(pkgRoot, cpkName) {
  const key = path.resolve(pkgRoot) + '|' + cpkName;
  if (_cpkIndexCache.has(key)) return _cpkIndexCache.get(key);
  const idx = readCpkVoiceIndex(pkgRoot, cpkName);
  _cpkIndexCache.set(key, idx);
  return idx;
}

/** 全部配音的完整索引（含偏移）——只在需要时才建（比较重）。 */
const _indexCache = new Map();
function voiceIndex(pkgRoot) {
  const key = path.resolve(pkgRoot);
  if (_indexCache.has(key)) return _indexCache.get(key);
  const all = [];
  for (const cpk of listVoiceCpks(pkgRoot)) {
    try { all.push(cpkVoiceIndex(pkgRoot, cpk)); } catch (e) { /* ignore */ }
  }
  const map = new Map();
  for (const c of all) for (const e of c.entries) if (!map.has(e.voiceId)) map.set(e.voiceId, e);
  const out = { cpks: all, byVoiceId: map, total: map.size };
  _indexCache.set(key, out);
  return out;
}
function invalidate() { _indexCache.clear(); _cpkIndexCache.clear(); _nameCache.clear(); }

/** 找某个配音 ID 在哪个 CPK 的哪个偏移。找不到返回 null。 */
function findVoice(pkgRoot, voiceId) {
  const id = String(voiceId).replace(/\D/g, '');
  if (!id) return null;
  const where = listVoiceIds(pkgRoot).byVoiceId.get(id);
  if (!where) return null;
  const e = cpkVoiceIndex(pkgRoot, where).entries.find((x) => x.voiceId === id);
  return e || null;
}

/** 把一个配音的 AWB 原样切出来（调试/后继替换用）。 */
function carveVoice(pkgRoot, voiceId, outFile) {
  const e = findVoice(pkgRoot, voiceId);
  if (!e) return null;
  const src = fs.readFileSync(path.join(cpkDir(pkgRoot), e.cpk));
  const data = src.slice(e.offset, e.offset + e.size);
  if (outFile) { fs.mkdirSync(path.dirname(outFile), { recursive: true }); fs.writeFileSync(outFile, data); }
  return Object.assign({}, e, { data });
}

function vgmstreamPath() { return VGMSTREAM; }
function hasDecoder() { return fs.existsSync(VGMSTREAM); }

/** 试听用：把某个配音解成 wav（缓存在 tools/cardcomposer/cache/voice/ 下）。 */
function decodeVoiceToWav(pkgRoot, voiceId, opts) {
  const o = opts || {};
  const id = String(voiceId).replace(/\D/g, '');
  if (!id) return { error: '配音 ID 必须是数字' };
  const e = findVoice(pkgRoot, id);
  if (!e) return { error: '这个配音 ID 不在包里（' + id + '）' };
  if (!hasDecoder()) {
    return { error: '没有解码器：工具需要 tools\\vgmstream\\vgmstream-cli.exe（可用 inspect\\fetch-vgmstream.js 下载）', needDecoder: true };
  }
  fs.mkdirSync(CACHE, { recursive: true });
  const wav = path.join(CACHE, id + '.wav');
  const cached = !o.force && fs.existsSync(wav) && fs.statSync(wav).size > 44;
  if (!cached) {
    const awb = path.join(CACHE, id + '.awb');
    carveVoice(pkgRoot, id, awb);
    try {
      execFileSync(VGMSTREAM, ['-o', wav, awb], { encoding: 'utf8', cwd: path.dirname(VGMSTREAM), timeout: 60000 });
    } catch (err) {
      return { error: '解码失败：' + String(err.stdout || '') + String(err.stderr || err.message).slice(0, 200) };
    } finally { try { fs.unlinkSync(awb); } catch (e2) { } }
  }
  if (!fs.existsSync(wav) || fs.statSync(wav).size <= 44) return { error: '解码后没有音频数据' };
  const st = fs.statSync(wav);
  const head = Buffer.alloc(44);
  const fd = fs.openSync(wav, 'r'); fs.readSync(fd, head, 0, 44, 0); fs.closeSync(fd);
  const rate = head.readUInt32LE(24), ch = head.readUInt16LE(22), bits = head.readUInt16LE(34);
  const seconds = (st.size - 44) / (rate * ch * (bits / 8));
  return { ok: true, cached, wav, voiceId: id, cpk: e.cpk, size: e.size, bytes: st.size,
    rate, channels: ch, bits, seconds: Number(seconds.toFixed(2)) };
}

/** 这个配音听起来是什么（不改盘，只报解码信息）。 */
function probeVoice(pkgRoot, voiceId) {
  const tmp = path.join(os.tmpdir(), 'voice-probe-' + voiceId + '.awb');
  const e = carveVoice(pkgRoot, voiceId, tmp);
  if (!e) return { error: '这个配音 ID 不在包里' };
  if (!hasDecoder()) return { error: '没有解码器（tools\\vgmstream）', needDecoder: true };
  try {
    const out = execFileSync(VGMSTREAM, ['-m', tmp], { encoding: 'utf8', cwd: path.dirname(VGMSTREAM) });
    const rate = /sample rate: (\d+)/.exec(out), ch = /channels: (\d+)/.exec(out), dur = /play duration: [^(]*\(([^)]+)\)/.exec(out), enc = /encoding: (.+)/.exec(out);
    return { ok: true, voiceId: String(voiceId), cpk: e.cpk, size: e.size,
      rate: rate ? Number(rate[1]) : null, channels: ch ? Number(ch[1]) : null,
      duration: dur ? dur[1] : null, encoding: enc ? enc[1].trim() : null };
  } catch (err) {
    return { error: '解码失败：' + String(err.stdout || err.message).slice(0, 200) };
  } finally { try { fs.unlinkSync(tmp); } catch (e2) { } }
}

module.exports = { cpkDir, listVoiceCpks, readCpkNames, readCpkVoiceIndex, cpkVoiceIndex, listVoiceIds, voiceIndex,
  invalidate, findVoice, carveVoice, decodeVoiceToWav, probeVoice, hasDecoder, vgmstreamPath, CACHE, VGMSTREAM };
