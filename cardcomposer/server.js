#!/usr/bin/env node
'use strict';
/*
 * server.js -- local web UI for composing a card.
 *
 *   node server.js [--package <path>] [--port 8788]
 *
 * Endpoints (all JSON):
 *   GET  /api/state                        package summary + card count
 *   GET  /api/cards                        compact card list for the clone picker
 *   GET  /api/clone?id=N                   everything pre-fillable from that card
 *   GET  /api/palette                      effect blocks + real observed parameter values
 *   GET  /api/conditions                   condition codes the startup gate allows
 *   GET  /api/skill?id=N                   describe an existing skill
 *   POST /api/preview   {draft}            resolve + compile (writes nothing)
 *   POST /api/inject    {draft, write}     write the 8 write points (write:false = check only)
 *   GET  /api/state                        package identity + counts
 *   GET  /api/package/check?path=...       is this a usable package?
 *   GET  /api/package/browse?path=...      directory navigation for the picker
 *   POST /api/package/select {path}        switch packages (persisted)
 *   GET  /thumb/<cardId>  /art/<pictId>    existing card art
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const { Package, CARD_COL } = require('./lib/pkg');
const C = require('./lib/compose');
const { inject } = require('./lib/injector');
const engine = require('./lib/engine');

const DEFAULT_PKG = require('./lib/tools').findPackage();   // KAIRI_PKG / .cardcomposer.json / 自动查找；找不到就让用户在界面里选
const CONFIG = path.join(__dirname, '.cardcomposer.json');

function parseArgs(argv) {
  const out = { package: null, port: 8788 };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--package' && argv[i + 1]) out.package = argv[++i];
    else if (argv[i] === '--port' && argv[i + 1]) out.port = Number(argv[++i]);
  }
  return out;
}
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return {}; }
}
function saveConfig(obj) {
  try { fs.writeFileSync(CONFIG, JSON.stringify(obj, null, 2) + '\n', 'utf8'); } catch { /* best effort */ }
}

// ---------------------------------------------------------------- package identity
/** A path is a usable package only if the tables the tool writes are all there. */
function inspectPackage(root) {
  if (!root) return { ok: false, reason: '未指定路径' };
  let abs;
  try { abs = path.resolve(root); } catch { return { ok: false, reason: '路径不合法' }; }
  if (!fs.existsSync(abs)) return { ok: false, reason: '路径不存在' };
  if (!fs.statSync(abs).isDirectory()) return { ok: false, reason: '不是目录' };
  const srv = path.join(abs, 'resource-set', '_local', 'control', 'server');
  const need = [
    ['card.csv', path.join(srv, 'cn602-card-master', 'card.csv')],
    ['skill_player.csv', path.join(srv, 'cn602-battle-master', 'skill_player.csv')],
    ['skill_role_player.csv', path.join(srv, 'cn602-battle-master', 'skill_role_player.csv')],
    ['cn602-card-runtime-master.json', path.join(srv, 'cn602-card-runtime-master.json')],
    ['admin manifest.json', path.join(srv, 'cn602-admin-assets', 'manifest.json')],
    ['container.dat', path.join(abs, 'resource-set', 'resources', 'patch', 'main_c', 'container.dat')],
    ['resource-set.json', path.join(abs, 'resource-set', 'resource-set.json')],
  ];
  const missing = need.filter(([, f]) => !fs.existsSync(f)).map(([n]) => n);
  if (missing.length) {
    return { ok: false, reason: '缺少 ' + missing.length + ' 个必需文件（' + missing.slice(0, 3).join('、') +
      (missing.length > 3 ? ' 等' : '') + '）' };
  }
  // identity: card count + a hash of card.csv, so a wrong-but-similar package is obvious
  const cardCsv = path.join(srv, 'cn602-card-master', 'card.csv');
  const stat = fs.statSync(cardCsv);
  let cards = 0;
  try {
    const txt = fs.readFileSync(cardCsv, 'utf8');
    cards = txt.replace(/\r\n/g, '\n').split('\n').filter(l => l && !l.startsWith('#')).length;
  } catch { /* ignore */ }
  const sha = crypto.createHash('sha256').update(fs.readFileSync(cardCsv)).digest('hex');
  let templates = 0;
  try {
    templates = JSON.parse(fs.readFileSync(path.join(srv, 'cn602-card-runtime-master.json'), 'utf8')).card_templates.length;
  } catch { /* ignore */ }
  return {
    ok: true, root: abs, cards, templates, missing: [],
    cardCsvBytes: stat.size, cardCsvMtime: stat.mtime.toISOString(),
    fingerprint: sha.slice(0, 16),
    containerBytes: fs.statSync(path.join(abs, 'resource-set', 'resources', 'patch', 'main_c', 'container.dat')).size,
    hasShim: fs.existsSync(path.join(abs, 'Start-Server.ps1')),
    deployment: (() => {
      try { return JSON.parse(fs.readFileSync(path.join(abs, 'deployment.json'), 'utf8')); } catch { return null; }
    })(),
  };
}

/** List sub-directories so the user can navigate to their package. */
function browse(dir, showFiles) {
  const abs = path.resolve(dir || 'D:\\');
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return { ok: false, error: '不是目录', path: abs };
  const entries = [];
  const dirs = [];
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.name.startsWith('$') || e.name === 'System Volume Information') continue;
    const full = path.join(abs, e.name);
    if (e.isDirectory()) {
      // mark candidates: a package has resource-set\_local\control\server
      const candidate = fs.existsSync(path.join(full, 'resource-set', '_local', 'control', 'server'));
      dirs.push({ name: e.name, path: full, candidate });
    } else if (showFiles) {
      entries.push({ name: e.name, path: full });
    }
  }
  dirs.sort((a, b) => (b.candidate - a.candidate) || a.name.localeCompare(b.name));
  const parent = path.dirname(abs);
  return { ok: true, path: abs, parent: parent === abs ? null : parent, dirs, files: entries.slice(0, 200),
    isPackage: fs.existsSync(path.join(abs, 'resource-set', '_local', 'control', 'server')) };
}

let cache = { at: 0, pkg: null, root: null };
function pkg(root) {
  // reload if the file changed on disk (cheap stat check) or the package changed
  const cardCsv = path.join(root, 'resource-set', '_local', 'control', 'server', 'cn602-card-master', 'card.csv');
  const mtime = fs.statSync(cardCsv).mtimeMs;
  if (!cache.pkg || cache.at !== mtime || cache.root !== root) {
    cache = { at: mtime, pkg: new Package(root).load(), root };
  }
  return cache.pkg;
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function sendFile(res, file, type) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { res.writeHead(404); return res.end('not found'); }
  // ★ 卡面图/缩略图是「会被我们改的文件」：以前 max-age=3600 会让浏览器缓存一小时，
  //   改完卡面缩略图在页面上还是老图 —— 用户会以为「缩略图功能没生效」（2026-09-24 实测）。
  //   所以这些图一律 no-store，永远读磁盘上的最新字节。
  const noStore = /^image\//.test(String(type || ''));
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': noStore ? 'no-store' : 'max-age=3600' });
  res.end(buf);
}
/**
 * 收到页面送来的卡面像素：先抠背景（官方卡面/图标都是**透明的立绘** —— 实测 chr20 有 20~27%
 * 全透明像素、chr10 有 41%；不抠的话圆形图标位会露出「白色方块」，演出也会带白底）。
 * chr51（放大立绘）页面送的是 RGBA，这里抠完自己编成 PNG 再交给 artwrite/newpict，
 * 这样「抠背景」只有这一份实现。
 * @returns { bgStats, logs }
 */
function processArtImages(body) {
  const BG = require('./lib/bgremove');
  const { encodePng } = require('./lib/png');
  const bgStats = {};
  const logs = [];
  for (const key of Object.keys(body.images || {})) {
    const im = body.images[key];
    if (!im || !im.rgbaBase64) continue;              // 已经是 PNG/没给像素就跳过
    const raw = Buffer.from(String(im.rgbaBase64).replace(/^data:[^,]*,/, ''), 'base64');
    const w = Number(im.w) || 0, h = Number(im.h) || 0;
    if (!w || !h || raw.length !== w * h * 4) continue;
    const st = body.removeBg === false ? { ok: false, reason: '页面上关掉了抠背景' } : BG.removeBackground(raw, w, h, {});
    bgStats[key] = { ok: !!st.ok, transparent: st.share || '0%', color: st.color, reason: st.reason };
    if (key === 'chr51') {
      // ★ 顺序很重要：先在**原图**上抠背景（这时背景还是纯色），再按 fit 装进目标尺寸
      //   （contain = 四周留透明边，不裁人物）。反过来先留透明边的话，抠背景会以为
      //   「本来就是透明背景」而跳过，人物背后那块白底就留下来了。
      const target = im.target || null;
      const tw = target && target.w ? Number(target.w) : w;
      const th = target && target.h ? Number(target.h) : h;
      let out = raw;
      if (tw !== w || th !== h) {
        const T = require('./lib/thumb');
        out = T.fitRgba(raw, w, h, tw, th, im.fit || 'contain');
      }
      im.pngBase64 = encodePng(out, tw, th).toString('base64');
      im.width = tw; im.height = th;
      delete im.rgbaBase64;
      delete im.target; delete im.fit;
    } else {
      im.rgbaBase64 = raw.toString('base64');
    }
    logs.push(key + '：' + (st.ok ? ('背景已抠成透明（' + st.share + '）') : ('没抠背景（' + (st.reason || '?') + '）')));
  }
  return { bgStats, logs };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    // 自定义卡面要传 512×512 / 256×256 的原始像素（base64 后 1.4MB / 350KB）+ chr51 的 PNG，
    // 所以上限放到 24 MB。
    req.on('data', c => { s += c; if (s.length > 24e6) reject(new Error('body too large')); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const args = parseArgs(process.argv);
// precedence: --package > saved choice > built-in default
let PKG = args.package || loadConfig().package || DEFAULT_PKG;
{
  const info = inspectPackage(PKG);
  if (!info.ok) {
    console.error('警告：启动时的包路径不可用 -> ' + PKG + '  (' + info.reason + ')');
    console.error('       可以在界面右上角「换包」里改。');
  } else {
    PKG = info.root;
  }
}

const server = http.createServer(async (req, res) => {
  // new URL 取代已废弃的 url.parse（Node 24 会对 url.parse 打弃用警告，启动器日志里很难看）
  let u;
  try { u = new URL(req.url, 'http://127.0.0.1'); }
  catch (e) { res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('bad url'); }
  const p = u.pathname;
  const q = (k) => u.searchParams.get(k);
  try {
    if (p === '/' || p === '/index.html') {
      const html = fs.readFileSync(path.join(__dirname, 'web', 'index.html'), 'utf8');
      // no-store: otherwise the browser may keep serving an old page after the tool
      // was updated, and the user sees stale buttons / scary fetch errors.
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, must-revalidate',
        Pragma: 'no-cache',
      });
      return res.end(html);
    }
    if (p === '/values.js') {
      // lib/values.js 是「游戏说明里的数字 ↔ CSV 原始参数」的换算公式。
      // 浏览器要用同一套公式（不能各写一份，否则两边会算不一样），所以直接把模块
      // 包一层 CommonJS 壳发给浏览器，页面里得到 window.VALUES。
      const src = fs.readFileSync(path.join(__dirname, 'lib', 'values.js'), 'utf8');
      const body = 'window.VALUES=(function(){var module={exports:{}};var exports=module.exports;\n' +
        src + '\nreturn module.exports;})();\n';
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(body);
    }
    if (p === '/api/decompile') {
      // 把已有技能拆回效果块（用户要的「克隆老卡的技能、直接改数值」）
      const P = pkg(PKG);
      const conventions = require('./lib/conventions').forPackage(P);
      const D = require('./lib/decompile');
      const cardId = Number(q('cardId')) || 0;
      const skillId = Number(q('id')) || 0;
      const out = cardId ? D.pickCardSkill(P, cardId, { conventions })
        : (skillId ? D.decompileSkill(P, skillId, { conventions }) : null);
      if (!out) return send(res, 400, { error: '要带 ?id=<技能id> 或 ?cardId=<卡id>' });
      // 名字/说明附上中文版（官方包里还留着日服原文，界面上要显示汉语；
      // 说明里的 {N} 占位符原样保留 —— 数值由客户端自己算）
      if (out.ok && out.skill) {
        const T = require('./lib/translate');
        out.skill.nameCn = T.cardName(out.skill.name || '');
        out.skill.descriptionCn = T.toChinese(out.skill.description || '');
        out.skill.descriptionWasJapanese = T.looksJapanese(out.skill.description || '');
      }
      if (cardId && out.ok && out.skillId) {
        // 顺带把卡的壳信息也带上，方便界面一边填技能一边提示
        const row = P.cardById.get(cardId);
        const tpl = P.tplById.get(cardId);
        return send(res, 200, Object.assign({}, out, {
          card: row ? { id: cardId, crown: row[CARD_COL.crown] || '', name: row[CARD_COL.name] || '',
            cost: row[CARD_COL.cost] || '' } : null,
          rarityRank: tpl ? tpl.rarity_rank : null,
        }));
      }
      return send(res, 200, out);
    }
    // ---- 自定义卡面（导入图片 → 按游戏尺寸裁剪 → 写进包）
    if (p === '/api/art/targets') {
      const A = require('./lib/artmap');
      const P = pkg(PKG);
      let pictId = Number(q('pictId')) || 0;
      if (!pictId && q('cardId')) {
        const row = P.cardById.get(Number(q('cardId')));
        pictId = row ? Number(row[CARD_COL.pictId]) || 0 : 0;
      }
      if (!pictId) return send(res, 400, { error: '要带 ?pictId= 或 ?cardId=' });
      return send(res, 200, A.targetsFor(PKG, pictId));
    }
    if (p === '/api/art/editable') {
      const A = require('./lib/artmap');
      return send(res, 200, { pictIds: A.editablePictIds(PKG, Math.min(200, Number(q('limit')) || 60)) });
    }
    // ---- 新建一个「全新的卡面 ID」（自己造明文包 + 登记进目录，不碰任何现有卡）
    if (p === '/api/art/new-pict') {
      const L = require('./lib/newpict');
      const P = pkg(PKG);
      if (req.method === 'GET') {
        // 只问「下一个能用的新 ID 是多少」+ 干跑信息
        const id = L.allocateId(PKG, [...P.cardById.keys()]);
        return send(res, 200, { nextPictId: id, container: { chr10: L.containerPathFor('chr10', id), chr20: L.containerPathFor('chr20', id) },
          bundles: { chr10: L.bundleRelFor('chr10', id), chr20: L.bundleRelFor('chr20', id) } });
      }
      const body = await readBody(req);
      const logs = [];
      // 删除一个自己造的卡面 ID（createPict 的逆操作）
      if (body.remove) {
        try {
          const out = L.removePict(PKG, Number(body.pictId) || 0, {
            write: !!body.write,
            log: (m) => { logs.push(m); console.log('[newpict] ' + m); },
          });
          require('./lib/artmap').invalidate();
          return send(res, 200, { ok: !out.error, result: out, logs });
        } catch (e) {
          return send(res, 500, { ok: false, error: e.message, logs });
        }
      }
      try {
        let id = Number(body.pictId) || 0;
        if (!id) id = L.allocateId(PKG, [...P.cardById.keys()]);
        const { logs: bgLogs2 } = processArtImages(body);
        for (const l of bgLogs2) logs.push(l);
        const out = L.createPict(PKG, id, body.images || {}, {
          write: !!body.write,
          log: (m) => { logs.push(m); console.log('[newpict] ' + m); },
        });
        require('./lib/artmap').invalidate();
        if (!out.error && body.thumb && body.thumb.rgbaBase64 && body.cardId) {
          const T = require('./lib/thumb');
          const raw = Buffer.from(String(body.thumb.rgbaBase64).replace(/^data:[^,]*,/, ''), 'base64');
          out.thumbnail = T.writeThumbnail(PKG, Number(body.cardId), raw, Number(body.thumb.w) || 160, Number(body.thumb.h) || 160, { write: !!body.write });
          logs.push('卡面缩略图：' + out.thumbnail.relative + '  ' + (out.thumbnail.bytes / 1024).toFixed(1) + ' KB');
        }
        return send(res, 200, { ok: !out.error, result: out, logs });
      } catch (e) {
        return send(res, 500, { ok: false, error: e.message, logs });
      }
    }
    // 候选卡面 ID（含「现在有哪张卡在用」）—— 换 ID 会动到那些卡的图，所以必须让用户看见
    if (p === '/api/art/candidates') {
      const A = require('./lib/artmap');
      const C = require('./lib/compose');
      const L = require('./lib/live2d');
      const base = A.editablePictIds(PKG, 5000);
      const liveSet = new Set(L.listCards(PKG).live);
      return send(res, 200, { total: base.length, candidates: C.pictCandidates(pkg(PKG), base, liveSet) });
    }
    // ---- Live2D 动态卡面（只有 180 张卡有；可以按卡关掉，让它回退成静态图）
    if (p === '/api/live2d/info') {
      const L = require('./lib/live2d');
      const P = pkg(PKG);
      const cardIds = [];
      if (q('cardId')) {
        cardIds.push(Number(q('cardId')));
      } else if (q('pictId')) {
        const want = String(q('pictId')).trim();
        for (const [id, row] of P.cardById) {
          if (String(row[CARD_COL.pictId] || '').trim() === want) cardIds.push(id);
        }
      }
      const L2 = require('./lib/compose');
      const cards = cardIds.map((id) => {
        const info = L.info(PKG, id);
        const row = P.cardById.get(id);
        const tpl = P.tplById.get(id);
        return Object.assign(info, {
          name: row ? (require('./lib/translate').cardName((row[CARD_COL.crown] || '') + (row[CARD_COL.name] || ''))) : '',
          rarity: tpl ? (L2.rarityLabel(tpl.rarity_rank) || '') : '',
        });
      });
      const all = L.listCards(PKG);
      return send(res, 200, { cards, liveCount: all.live.length, offCount: all.off.length });
    }
    if (p === '/api/live2d/toggle' && req.method === 'POST') {
      const body = await readBody(req);
      const L = require('./lib/live2d');
      if (!body.cardId) return send(res, 400, { error: '要带 cardId' });
      const logs = [];
      try {
        const out = L.setEnabled(PKG, Number(body.cardId), !!body.enabled, {
          write: !!body.write,
          log: (m) => { logs.push(m); console.log('[live2d] ' + m); },
        });
        return send(res, 200, { ok: !out.error, result: out, logs });
      } catch (e) {
        return send(res, 500, { ok: false, error: e.message, logs });
      }
    }
    // ---- 抠背景预览：页面裁剪区「实际会写进去的图」显示的就是这个（棋盘格底，透明一眼可见）
    if (p === '/api/art/bg-preview' && req.method === 'POST') {
      const body = await readBody(req);
      const BG = require('./lib/bgremove');
      const { encodePng } = require('./lib/png');
      const out = { stats: {}, previews: {} };
      for (const key of Object.keys(body.images || {})) {
        const im = body.images[key];
        if (!im || !im.rgbaBase64) continue;
        const raw = Buffer.from(String(im.rgbaBase64).replace(/^data:[^,]*,/, ''), 'base64');
        const w = Number(im.w) || 0, h = Number(im.h) || 0;
        if (!w || !h || raw.length !== w * h * 4) continue;
        const st = body.removeBg === false ? { ok: false, reason: '关掉了' } : BG.removeBackground(raw, w, h, {});
        out.stats[key] = { ok: !!st.ok, transparent: st.share || '0%', color: st.color, reason: st.reason };
        const maxSide = 200;
        const k = Math.min(1, maxSide / Math.max(w, h));
        const pw = Math.max(1, Math.round(w * k)), ph = Math.max(1, Math.round(h * k));
        const pv = Buffer.alloc(pw * ph * 4);
        for (let y = 0; y < ph; y++) {
          for (let x = 0; x < pw; x++) {
            const sx = Math.min(w - 1, Math.floor(x / k)), sy = Math.min(h - 1, Math.floor(y / k));
            const s = (sy * w + sx) * 4, d = (y * pw + x) * 4;
            const a = raw[s + 3] / 255;
            const check = (((x >> 3) + (y >> 3)) % 2) ? 205 : 150;      // 棋盘格 = 透明
            pv[d] = Math.round(raw[s] * a + check * (1 - a));
            pv[d + 1] = Math.round(raw[s + 1] * a + check * (1 - a));
            pv[d + 2] = Math.round(raw[s + 2] * a + check * (1 - a));
            pv[d + 3] = 255;
          }
        }
        out.previews[key] = { width: pw, height: ph, png: 'data:image/png;base64,' + encodePng(pv, pw, ph).toString('base64') };
      }
      return send(res, 200, out);
    }
    if (p === '/api/art/apply' && req.method === 'POST') {
      const body = await readBody(req);
      const W = require('./lib/artwrite');
      let pictId = Number(body.pictId) || 0;
      if (!pictId && body.cardId) {
        const row = pkg(PKG).cardById.get(Number(body.cardId));
        pictId = row ? Number(row[CARD_COL.pictId]) || 0 : 0;
      }
      if (!pictId) return send(res, 400, { error: '要带 pictId 或 cardId' });
      const logs = [];
      try {
        const { bgStats, logs: bgLogs } = processArtImages(body);
        for (const l of bgLogs) logs.push(l);
        const report = W.applyArt(PKG, pictId, body.images || {}, {
          write: !!body.write,
          flipY: body.flipY === false ? false : true,
          rawStorage: body.rawStorage === true,
          compensateCardFace: body.compensateCardFace !== false,
          log: (m) => { logs.push(m); console.log('[art] ' + m); },
        });
        report.bg = bgStats;
        // 卡面缩略图（160×160 无损 WebP）是**另一张图**：客户端不读它，但工具列表/服务端后台读。
        // 它有单独的一次取景（通常要对准脸），所以由页面另外送一份像素过来。
        if (body.thumb && body.thumb.rgbaBase64) {
          const T = require('./lib/thumb');
          const cardId = Number(body.cardId) || 0;
          if (!cardId) {
            report.thumbnail = { error: true, note: '给了缩略图像素但没给 cardId，没写' };
          } else {
            const raw = Buffer.from(String(body.thumb.rgbaBase64).replace(/^data:[^,]*,/, ''), 'base64');
            const w = Number(body.thumb.w) || 160, h = Number(body.thumb.h) || 160;
            const t = T.writeThumbnail(PKG, cardId, raw, w, h, { write: !!body.write });
            report.thumbnail = t;
            logs.push((body.write ? (t.replaced ? '卡面缩略图已替换' : '卡面缩略图已生成') : '缩略图（干跑）') +
              '：' + t.relative + '  ' + (t.bytes / 1024).toFixed(1) + ' KB' +
              (t.verify ? ('  WIC 校验 ' + t.verify.width + '×' + t.verify.height + (t.verify.ok ? ' ✓' : ' ✗')) : ''));
            if (t.error) logs.push('缩略图出错: ' + (t.note || ''));
          }
        }
        return send(res, 200, { ok: true, report, logs });
      } catch (e) {
        return send(res, 500, { ok: false, error: e.message, logs });
      }
    }
    if (p === '/api/state') {
      const P = pkg(PKG);
      const info = inspectPackage(PKG);
      return send(res, 200, {
        package: PKG,
        packageInfo: info,
        cardCount: P.cardById.size,
        templateCount: P.master.card_templates.length,
        skillCount: P.skillById.size,
        maxCardId: P.maxCardId(),
        nextCardId: P.freeCardId(Math.max(P.maxCardId() + 1, 99992000)),
        effects: require('./lib/effects').EFFECTS.length,
        // 属性 / 稀有度 / 职业 / 目标 这些下拉的中文标签（界面里不再出现裸英文）
        choices: require('./lib/compose').choices(),
      });
    }
    // ---- package location
    if (p === '/api/package/check') {
      return send(res, 200, inspectPackage(q('path')));
    }
    if (p === '/api/package/browse') {
      return send(res, 200, browse(q('path'), q('files') === '1'));
    }
    if (p === '/api/package/select' && req.method === 'POST') {
      const body = await readBody(req);
      const info = inspectPackage(body.path);
      if (!info.ok) return send(res, 400, { error: '这个路径不是可用的服务端包：' + info.reason, info });
      PKG = info.root;
      cache = { at: 0, pkg: null, root: null };
      saveConfig(Object.assign(loadConfig(), { package: PKG }));
      console.log('package switched -> ' + PKG);
      return send(res, 200, { ok: true, info });
    }
    // Open the REAL Windows folder picker on the machine running this server, so the
    // user can just browse to the folder like in Explorer instead of typing a path.
    if (p === '/api/package/pick' && req.method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const start = body.start || PKG || 'D:\\';
      const script = path.join(__dirname, 'lib', 'Pick-Folder.ps1');
      if (!fs.existsSync(script)) return send(res, 500, { error: '找不到文件夹选择器脚本: ' + script });
      const out = await new Promise((resolve) => {
        execFile('powershell.exe',
          ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script,
            '-StartPath', start],
          { timeout: 10 * 60 * 1000, windowsHide: true, encoding: 'utf8' },
          (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
      });
      const chosen = (out.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
      if (!chosen) {
        return send(res, 200, { ok: false, cancelled: true, error: '没有选择文件夹' + (out.stderr ? '（' + out.stderr.trim().slice(0, 200) + '）' : '') });
      }
      const info = inspectPackage(chosen);
      if (!info.ok) {
        return send(res, 200, { ok: false, cancelled: false, path: chosen,
          error: '选了「' + chosen + '」，但它不是可用的服务端包：' + info.reason });
      }
      return send(res, 200, { ok: true, path: chosen, info });
    }
    if (p === '/api/cards') {
      const P = pkg(PKG);
      return send(res, 200, { cards: C.listCards(P) });
    }
    if (p === '/api/clone') {
      const P = pkg(PKG);
      const src = C.cloneSource(P, Number(q('id')));
      if (!src) return send(res, 404, { error: 'card not found' });
      return send(res, 200, src);
    }
    // 配音表：card.csv 第 82 列按「配音 ID」聚合（官方是「按角色」共用的），
    // 附带一张样例卡的卡名+台词，供页面「借用别的配音」挑。
    if (p === '/api/voices') {
      const P = pkg(PKG);
      // ① card.csv 里的用法（哪些配音被官方卡用着、用了几张、样例卡+台词）
      const map = new Map();
      for (const [, row] of P.cardById) {
        const v = String(row[CARD_COL.voiceId] || '').trim();
        if (!v || /^0+$/.test(v)) continue;
        const name = ((row[CARD_COL.crown] || '') + (row[CARD_COL.name] || '')).trim();
        const cur = map.get(v);
        if (cur) { cur.cards++; }
        else map.set(v, { voiceId: v, numeric: /^[0-9]+$/.test(v), cards: 1, sample: name, sampleSerif: String(row[CARD_COL.serif] || '') });
      }
      // ② 包里真实存在的配音音频（CueSheet_Card_*.cpk 里的 <配音ID>.acb）
      //    合起来：能用的配音全集（含**没有任何卡在用**的空闲档，可以放心借来给自己卡用）
      let audio = { byVoiceId: new Map(), total: 0, cpks: [] };
      try {
        const V = require('./lib/voiceaudio');
        audio = V.listVoiceIds(PKG);
        for (const [id, cpk] of audio.byVoiceId) {
          const cur = map.get(id);
          if (cur) { cur.hasAudio = true; cur.cpk = cpk; }
          else map.set(id, { voiceId: id, numeric: /^[0-9]+$/.test(id), cards: 0, sample: '', sampleSerif: '', hasAudio: true, cpk, free: true });
        }
      } catch (e) { /* 没有音频库也能列表 */ }
      const voices = [...map.values()].sort((a, b) =>
        // 有音频的先排（还没被任何卡用的「空闲档」单独排后面）；再按用的人多的排
        ((a.hasAudio === false) - (b.hasAudio === false)) || ((a.cards === 0) - (b.cards === 0)) ||
        (b.cards - a.cards) || String(a.voiceId).localeCompare(String(b.voiceId)));
      return send(res, 200, {
        voices, count: voices.length, invalid: voices.filter(v => !v.numeric).length,
        withAudio: audio.total, free: voices.filter(v => v.cards === 0 && v.hasAudio).length,
        decoder: require('./lib/voiceaudio').hasDecoder(),
      });
    }
    // ---- images: card thumbnails + the chr51 enlarged art. Both are just files on
    // disk, so picking an existing card's art is a copy, not a new resource.
    if (p.startsWith('/thumb/')) {
      const id = String(u.pathname.slice('/thumb/'.length)).replace(/[^0-9]/g, '');
      if (!id) { res.writeHead(400); return res.end('bad id'); }
      return sendFile(res, path.join(PKG, 'resource-set', '_local', 'control', 'server',
        'cn602-admin-assets', 'card', id + '.webp'), 'image/webp');
    }
    if (p.startsWith('/art/')) {
      const id = String(u.pathname.slice('/art/'.length)).replace(/[^0-9]/g, '');
      if (!id) { res.writeHead(400); return res.end('bad id'); }
      return sendFile(res, path.join(PKG, 'resource-set', 'resources', 'image', 'chr51',
        'chr51_' + id + '.png'), 'image/png');
    }
    // which cards have usable art, for the art picker
    if (p === '/api/art-list') {
      const P = pkg(PKG);
      const thumbs = new Set(fs.readdirSync(path.join(P.adminDir, 'card'))
        .filter(f => f.endsWith('.webp')).map(f => f.replace('.webp', '')));
      const chrDir = path.join(P.root, 'resource-set', 'resources', 'image', 'chr51');
      const chr = new Set(fs.existsSync(chrDir)
        ? fs.readdirSync(chrDir).map(f => { const m = /^chr51_(\d+)\.png$/i.exec(f); return m ? m[1] : null; }).filter(Boolean)
        : []);
      const list = C.listCards(P)
        .filter(c => thumbs.has(String(c.id)))
        .map(c => ({ id: c.id, name: (c.crown || '') + (c.name || ''), rarity: c.rarity, job: c.job,
                     pictId: c.pictId, hasLarge: chr.has(String(c.pictId)) }));
      return send(res, 200, { cards: list, largeCount: chr.size });
    }
    if (p === '/api/skill') {
      const P = pkg(PKG);
      const info = C.describeSkill(P, Number(q('id')));
      if (!info) return send(res, 404, { error: 'skill not found' });
      return send(res, 200, info);
    }
    if (p === '/api/palette') {
      const P = pkg(PKG);
      return send(res, 200, {
        effects: C.palette(P),
        conditions: C.conditions(),
        // 哪些效果有「数值」、对应哪几个参数（界面据此画 Lv1/满级 输入框）
        valueShapes: require('./lib/values').VALUE_SHAPE,
      });
    }
    // ---- 配音试听：把某个官方的配音解码成 wav 放给页面听（只读，不改包）
    //      配音存在 CueSheet_Card_*.cpk 里，每句是一个小 AWB + 未加密的 CRI HCA；
    //      解码用 tools\vgmstream\vgmstream-cli.exe（见 lib\voiceaudio.js 顶部说明）
    if (p.startsWith('/api/voice-audio/')) {
      const id = String(u.pathname.slice('/api/voice-audio/'.length)).replace(/[^0-9]/g, '');
      if (!id) return send(res, 400, { error: '要带配音 ID' });
      const V = require('./lib/voiceaudio');
      if (!V.hasDecoder()) {
        return send(res, 200, { error: '还没有解码器：把 vgmstream 放到 tools\\vgmstream\\ 下（inspect\\fetch-vgmstream.js 会自动下载）', needDecoder: true });
      }
      const r = V.decodeVoiceToWav(PKG, id, { force: q('force') === '1' });
      if (r.error) return send(res, 404, { error: r.error });
      return sendFile(res, r.wav, 'audio/wav');
    }
    if (p === '/api/voice-info') {
      const id = String(q('id') || '').replace(/[^0-9]/g, '');
      if (!id) return send(res, 400, { error: '要带 id' });
      const V = require('./lib/voiceaudio');
      const e = V.findVoice(PKG, id);
      if (!e) return send(res, 404, { error: '这个配音 ID 不在包里（' + id + '）' });
      return send(res, 200, { ok: true, voiceId: id, cpk: e.cpk, offset: e.offset, bytes: e.size,
        decoder: V.hasDecoder(), info: V.hasDecoder() ? V.probeVoice(PKG, id) : null });
    }
    if (p === '/api/voice-audit') {
      const V = require('./lib/voiceaudio');
      const idx = V.voiceIndex(PKG);
      return send(res, 200, { ok: true, cpks: idx.cpks.map(c => ({ cpk: c.cpk, names: c.names, awbs: c.awbs, bytes: c.cpkBytes })),
        voiceCount: idx.total, decoder: V.hasDecoder() });
    }

    // ---- 卡牌方案库：记住写过的卡 / 导出分享 / 导入别人的 ----
    if (p === '/api/library' && req.method === 'GET') {
      const L = require('./lib/library');
      return send(res, 200, {
        file: L.filePath(), format: L.FORMAT, version: L.VERSION,
        presets: (q('full') === '1' && q('sid')) ? [L.get(q('sid'))].filter(Boolean) : L.list(),
      });
    }
    if (p === '/api/library/get' && req.method === 'GET') {
      const L = require('./lib/library');
      const one = L.get(q('sid'));
      if (!one) return send(res, 404, { error: '库里没有这个方案' });
      return send(res, 200, { preset: one });
    }
    if (p === '/api/library/save' && req.method === 'POST') {
      const L = require('./lib/library');
      const body = await readBody(req);
      const r = L.save(body.preset);
      if (r.error) return send(res, 400, { error: r.error, friendly: true });
      return send(res, 200, r);
    }
    if (p === '/api/library/delete' && req.method === 'POST') {
      const L = require('./lib/library');
      const body = await readBody(req);
      const r = L.remove(body.sid);
      if (r.error) return send(res, 400, { error: r.error, friendly: true });
      return send(res, 200, r);
    }
    if (p === '/api/library/export') {
      const L = require('./lib/library');
      const body = req.method === 'POST' ? await readBody(req).catch(() => ({})) : {};
      const sids = body && Array.isArray(body.sids) && body.sids.length ? body.sids
        : (q('sids') ? String(q('sids')).split(',').filter(Boolean) : null);
      const pack = L.exportPack(sids);
      return send(res, 200, pack);
    }
    if (p === '/api/library/import' && req.method === 'POST') {
      const L = require('./lib/library');
      const body = await readBody(req);
      const r = L.importPack(body.pack, { write: body.write !== false });
      if (r.error) return send(res, 400, { error: r.error, friendly: true });
      return send(res, 200, r);
    }
    if (p === '/api/preview' && req.method === 'POST') {
      const body = await readBody(req);
      const P = pkg(PKG);
      const resolved = C.resolveDraft(P, body.draft || {});
      return send(res, 200, { ok: true, resolved });
    }
    if (p === '/api/inject' && req.method === 'POST') {
      const body = await readBody(req);
      const logs = [];
      // `write:false` is the safe "check everything, touch nothing" mode.
      // `dryRun` here means "write the server tables but leave the client bundle alone",
      // which is a half-applied state -- only use it when you know why.
      const result = inject(body.draft || {}, {
        packageRoot: PKG,
        inPlace: !!body.inPlace,
        write: body.write !== false,
        dryRun: !!body.dryRun,
        rebuildBundle: !body.dryRun,
        log: m => logs.push(m),
      });
      cache = { at: 0, pkg: null };   // force reload next time
      return send(res, 200, { ok: true, logs, written: result.written !== false, rebuilt: result.rebuilt !== false });
    }
    // diagnostic: current package summary as the injector sees it
    if (p === '/api/example') {
      const P = pkg(PKG);
      return send(res, 200, C.resolveDraft(P, {
        id: P.freeCardId(Math.max(P.maxCardId() + 1, 99992000)),
        clone: 10000182, crown: '【MOD】', name: '示例卡', arthurType: 1, cost: 1,
        arthur: {
          mode: 'custom',
          skill: {
            name: '术援／示例', kind: 'SORCERY', damageKind: 'MAGIC', target: 'ENEMY_ONE', displayRole: 1,
            blocks: [
              { kind: 'atkUp', params: { 0: '3', 1: 'INT', 3: '2000', 4: '200' }, roleTarget: 'SELF' },
              { kind: 'attack', params: { 0: '1000', 1: '20000', 5: 'INT', 7: 'ICE', 8: 'MAGIC' }, roleTarget: 'SELECT' },
              { kind: 'draw', params: { 0: '2' }, roleTarget: 'SELF' },
            ],
          },
        },
        normal: { mode: 'none' },
      }));
    }
    return send(res, 404, { error: 'not found: ' + p });
  } catch (e) {
    // 「用户输入不对」类错误（空技能、效果块没选效果…）给 400 + 人话，不打堆栈；
    // 其它未预料的错误才 500 + stack，方便排查。
    const friendly = !!(e && e.friendly);
    return send(res, friendly ? 400 : 500, {
      error: String(e && e.message ? e.message : e),
      friendly,
      stack: friendly ? undefined : (e && e.stack),
    });
  }
});

server.listen(args.port, '127.0.0.1', () => {
  console.log('cardcomposer UI:  http://127.0.0.1:' + args.port + '/');
  console.log('package:          ' + PKG);
  console.log('(Ctrl+C 退出)');
});
