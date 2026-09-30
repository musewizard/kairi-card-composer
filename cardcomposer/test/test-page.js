#!/usr/bin/env node
/*
 * test-page.js -- 网页界面「能不能正常跑起来」的冒烟测试（不需要真浏览器）。
 *
 * 为什么要有它：界面是单文件 HTML，里面几千行 JS，一旦有未定义的变量（例如
 * 2026-09-23 那次把 `window.VALUES` 写成了 `values`），整页 boot 就会当场抛错：
 * 顶栏出现「连不上后台服务（xxx is not defined）」、卡牌列表空白、点什么都报错。
 * 这种错误 `node --check` 查不出来（语法没问题），只有真正执行一遍才会暴露。
 *
 * 做法：用最小 DOM 桩 + **真实后台数据**（从正在跑的服务拉 /api/state、/api/palette、
 * /api/cards，以及 /values.js）在 vm 里把脚本跑一遍，然后断言：
 *   - 没有抛出未捕获错误、没有显示"连不上后台"的红条
 *   - 卡牌列表真的渲染出了单元格
 *   - 数值换算模块（window.VALUES）加载成功、效果数值配置下发成功
 */
'use strict';
const vm = require('vm');
const BASE = process.env.CARDCOMPOSER_BASE || 'http://127.0.0.1:8788';

let bad = 0;
const ok = (c, m, d) => { console.log((c ? '  [OK]   ' : '  [FAIL] ') + m + (d ? '  ' + d : '')); if (!c) bad++; };

// ---------------------------------------------------------------- 最小 DOM 桩
// 2D context 桩：自定义卡面要 drawImage / getImageData / toDataURL，不需要真的像素，
// 但要能算出「传上去的字节数对不对」，所以 getImageData 返回真长度的数组。
function makeCtx(el) {
  return {
    drawn: 0, flipped: 0,
    fillStyle: '', strokeStyle: '', font: '', textAlign: '', lineWidth: 1,
    imageSmoothingEnabled: false, imageSmoothingQuality: '',
    setTransform() { }, clearRect() { }, fillRect() { }, strokeRect() { },
    beginPath() { }, moveTo() { }, lineTo() { }, stroke() { }, fillText() { },
    measureText() { return { width: 0 }; }, save() { }, restore() { },
    translate() { }, scale(x, y) { if (x === 1 && y === -1) this.flipped++; },
    drawImage() { this.drawn++; },
    // 每个像素都填「翻没翻过」——测试靠这个判断页面有没有给纹理做竖直翻转
    getImageData(x, y, w, h) {
      const a = new Uint8ClampedArray(Math.max(4, (w | 0) * (h | 0) * 4));
      a.fill(this.flipped ? 1 : 0);
      return { data: a };
    },
  };
}
// select 桩：真浏览器里 select 会自动选中第一个 option（包括 optgroup 里的），
// 桩也得这样，否则「读 sel.value」的代码在测试里拿到空字符串，测出来的是假 bug。
function syncSelect(sel) {
  if (sel.value) return;
  const find = (list) => {
    for (const c of list) {
      if (c.tagName === 'OPTION') return c;
      const g = find(c.childNodes || []);
      if (g) return g;
    }
    return null;
  };
  const first = find(sel.childNodes || []);
  if (first) sel.value = first.value;
}
function makeEl(tag) {
  const kids = [];
  const el = {
    tagName: String(tag || 'div').toUpperCase(), nodeType: 1,
    childNodes: kids, children: kids, style: {}, dataset: {}, options: [], files: [],
    value: '', textContent: '', title: '', disabled: false, checked: false, src: '', href: '',
    classList: { add() { }, remove() { }, toggle() { }, contains() { return false; } },
    append(...n) { for (const x of n) { kids.push(x); if (x && typeof x === 'object') x.parentNode = el; } if (el.tagName === 'SELECT') syncSelect(el); },
    appendChild(n) { kids.push(n); if (n && typeof n === 'object') n.parentNode = el; return n; },
    insertBefore(n) { kids.push(n); if (n && typeof n === 'object') n.parentNode = el; return n; },
    remove() {
      const p = el.parentNode;
      if (p && p.childNodes) { const i = p.childNodes.indexOf(el); if (i >= 0) p.childNodes.splice(i, 1); }
      el.parentNode = null;
    }, contains() { return true; }, focus() { }, blur() { },
    setAttribute(k, v) { el[k] = v; }, getAttribute(k) { return el[k] === undefined ? null : el[k]; }, removeAttribute(k) { delete el[k]; },
    addEventListener() { }, removeEventListener() { }, dispatchEvent() { return true; },
    querySelector() { return null; },
    // 只支持 `.类名` 这一种选择器（页面里只需要它）—— 但必须是真遍历，
    // 否则「变体里不许把效果块删到 0 个」这种守卫在测试里测不出来。
    querySelectorAll(sel) {
      const s = String(sel || '');
      const cls = s.startsWith('.') ? s.slice(1) : null;
      const tag = cls ? null : s.toUpperCase();
      const out = [];
      const walk = (n) => {
        for (const c of (n.childNodes || [])) {
          if (c.nodeType === 1) {
            const hit = cls ? String(c.class || '').split(/\s+/).indexOf(cls) >= 0 : (c.tagName === tag);
            if (hit) out.push(c);
          }
          walk(c);
        }
      };
      walk(el);
      return out;
    },
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; },
    scrollIntoView() { }, closest() { return null; },
    getContext() { return (el._ctx = el._ctx || makeCtx(el)); },
    // PNG 分支：把「有没有翻过」编进 base64，测试能验 chr51 不被翻转
    toDataURL() { return 'data:image/png;base64,' + Buffer.from([el._ctx && el._ctx.flipped ? 1 : 0]).toString('base64'); },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._html || ''; },
    set(v) { el._html = v; if (!v) kids.length = 0; },
  });
  Object.defineProperty(el, 'firstChild', { get() { return kids[0] || null; } });
  return el;
}
function makeDoc() {
  const byId = new Map();
  const doc = {
    body: makeEl('body'),
    documentElement: makeEl('html'),
    getElementById(id) { if (!byId.has(id)) byId.set(id, makeEl('div')); return byId.get(id); },
    createElement(tag) { return makeEl(tag); },
    createTextNode(text) { const e = makeEl('text'); e.textContent = String(text); return e; },
    addEventListener() { }, removeEventListener() { },
    querySelector() { return null; }, querySelectorAll() { return []; },
  };
  doc.body.contains = () => true;
  return doc;
}

// ---------------------------------------------------------------- 真实数据
(async () => {
  const get = async (p) => {
    const r = await fetch(BASE + p);
    if (!r.ok) throw new Error('GET ' + p + ' -> ' + r.status);
    return r;
  };
  const html = await (await get('/')).text();
  const stateSrc = await (await get('/api/state')).json();
  const palette = await (await get('/api/palette')).json();
  const cards = await (await get('/api/cards')).json();
  const valuesSrc = await (await get('/values.js')).text();

  const script = /<script>([\s\S]*?)<\/script>/.exec(html);
  ok(!!script && script[1].length > 5000, '取到页面内联脚本', script ? script[1].length + ' 字节' : '(没有)');
  ok(/<script src="\/values\.js"><\/script>/.test(html), '页面引了 /values.js（数值换算模块）');

  const doc = makeDoc();
  const errors = [];
  const announced = [];
  const posted = [];                  // POST 上去的东西（自定义卡面要检查这个）
  const flags = { confirm: false };
  const route = {
    '/api/state': stateSrc, '/api/palette': palette, '/api/cards': cards,
    '/api/art-list': { cards: [] },
  };
  for (const p of ['/api/decompile']) route[p] = null;      // 下面填真实数据
  try {
    const rr = await fetch(BASE + '/api/decompile?cardId=99992001');
    if (rr.ok) route['/api/decompile'] = await rr.json();
  } catch (e) { /* 没有这张卡就算了，弹窗会显示"查不到" */ }
  const sandbox = {
    console: { log() { }, warn(...a) { announced.push(a.join(' ')); }, error(...a) { errors.push(a.join(' ')); }, info() { } },
    document: doc,
    location: { href: BASE + '/', protocol: 'http:', host: '127.0.0.1:8788', port: '8788', reload() { } },
    navigator: { userAgent: 'node-smoke-test', clipboard: { writeText: async () => { } } },
    alert(msg) { announced.push('alert: ' + msg); },
    confirm() { return flags.confirm; }, prompt() { return null; },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() { },
    fetch: async (path, opts) => {
      if (opts && opts.body) posted.push({ path: String(path), body: JSON.parse(String(opts.body)) });
      const bare = String(path).split('?')[0];
      // 卡面相关的查询走真后台（它们只是读文件，很便宜）
      if (/^\/api\/art\/(targets|candidates)/.test(bare)) {
        const r = await fetch(BASE + path);
        const j = await r.json();
        return { ok: r.ok, status: r.status, json: async () => j, text: async () => JSON.stringify(j) };
      }
      const data = route[path] || route[bare];
      if (data === undefined) return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
      return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
    },
    Promise, JSON, Math, Date, Number, String, Boolean, Array, Object, RegExp, Error, Map, Set, isNaN, parseInt, parseFloat,
    encodeURIComponent, decodeURIComponent, URLSearchParams, TextEncoder,
    Uint8Array, Uint8ClampedArray, Buffer,
    btoa(s) { return Buffer.from(String(s), 'latin1').toString('base64'); },
    URL: { createObjectURL() { return 'blob:test/1'; }, revokeObjectURL() { } },
    // 卡牌库要把「用户导入的原图」存成 dataURL（导出分享用），所以页面会用到 FileReader
    FileReader: class {
      readAsDataURL(file) {
        this.result = 'data:' + ((file && file.type) || 'image/png') + ';base64,' + Buffer.from('fake-image-bytes').toString('base64');
        if (this.onload) setTimeout(() => this.onload(), 0);
      }
    },
    Blob: class { constructor(parts) { this.parts = parts; } },
    Image: class { constructor() { this.width = 0; this.height = 0; } set src(v) { this._src = v; this.width = 1400; this.height = 1050; if (this.onload) setTimeout(() => this.onload(), 0); } get src() { return this._src; } },
    // <audio>：配音试听会 set src + play()（桩里只要不抛就行）
    Audio: class { constructor() { this.src = ''; } play() { return Promise.resolve(); } pause() { } },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  // 先执行 /values.js（就是浏览器里的顺序），再执行页面脚本
  try { vm.runInContext(valuesSrc, sandbox, { filename: 'values.js' }); }
  catch (e) { ok(false, '/values.js 执行失败', e.message); }
  ok(!!(sandbox.window.VALUES && typeof sandbox.window.VALUES.valueAt === 'function'),
    'window.VALUES 就绪（页面靠它做人话数值换算）');

  let threw = null;
  try { vm.runInContext(script[1], sandbox, { filename: 'index.html' }); }
  catch (e) { threw = e; }
  ok(!threw, '页面脚本执行没有当场抛错', threw ? threw.message : '');

  // boot 是异步的，等它跑完
  await new Promise(r => setTimeout(r, 400));

  const banner = doc.getElementById('connBanner');
  const pkgPath = doc.getElementById('pkgPath');
  ok(banner.style.display === 'none' || banner.style.display === '',
    '没有显示「连不上后台」红条（boot 成功）', 'banner=' + JSON.stringify(banner.style.display) + ' pkg=' + JSON.stringify(pkgPath.textContent));
  ok(!/加载失败|is not defined/.test(String(pkgPath.textContent || '')),
    '顶栏没有报错文字', JSON.stringify(pkgPath.textContent));
  const list = doc.getElementById('cardList');
  ok(list.childNodes.length > 0, '卡牌列表渲染出了单元格', list.childNodes.length + ' 个');
  const idHint = doc.getElementById('idHint');
  ok(/最大卡牌 ID/.test(String(idHint.textContent || '')), 'ID 提示已填', JSON.stringify(idHint.textContent).slice(0, 60));
  ok(errors.length === 0, '没有 console.error', errors.slice(0, 3).join(' | '));

  // 数值换算在页面里真的能用（模拟一次：把效果块的参数换算成 Lv1/满级）
  const V = sandbox.window.VALUES;
  const atk = V.valueAt('attack', { 0: '9639', 1: '67000' }, 80);
  ok(atk === 14999, '页面里的 VALUES.valueAt 算得对（+67000/级 → 满级 14999）', String(atk));

  // ---- 「导入已有技能」这条路也要真跑一遍（弹窗 → 查 → 填入效果块）
  const walk = (node, out) => {
    out.push(node);
    for (const k of (node.childNodes || [])) walk(k, out);
    return out;
  };
  const textOf = (n) => String(n.textContent || (n.childNodes || []).map(c => c.textContent || '').join('') || '');
  const findAll = (pred) => walk(doc.body, []).filter(pred);
  const btnImport = doc.getElementById('btnImportSkill');
  let importErr = null;
  try { btnImport.onclick(); } catch (e) { importErr = e; }
  ok(!importErr, '点「导入已有技能」能打开弹窗', importErr ? importErr.message : '');
  const modalBoxes = findAll(n => (n.childNodes || []).length >= 0 && n.tagName === 'DIV');
  const input = findAll(n => n.tagName === 'INPUT' && /卡牌 ID 或 技能 ID/.test(String(n.placeholder || '')))[0];
  ok(!!input, '弹窗里有输入框');
  const searchBtn = findAll(n => n.tagName === 'BUTTON' && textOf(n) === '查')[0];
  ok(!!searchBtn, '弹窗里有「查」按钮');
  if (input && searchBtn) {
    input.value = '99992001';
    try { searchBtn.onclick(); } catch (e) { importErr = e; }
    await new Promise(r => setTimeout(r, 200));
    ok(!importErr, '查询没有抛错', importErr ? importErr.message : '');
    const fillBtn = findAll(n => n.tagName === 'BUTTON' && textOf(n) === '填入效果块')[0];
    ok(!!fillBtn, '查到了技能，出现「填入效果块」按钮');
    if (fillBtn) {
      ok(fillBtn.disabled !== true, '「填入效果块」已启用（说明查到了可导入的技能）');
      const before = doc.getElementById('blocks').childNodes.length;
      try { fillBtn.onclick(); } catch (e) { importErr = e; }
      ok(!importErr, '填入效果块没有抛错', importErr ? importErr.message : '');
      ok(doc.getElementById('blocks').childNodes.length >= 3,
        '效果块被填进了编辑区', doc.getElementById('blocks').childNodes.length + ' 个（之前 ' + before + '）');
      ok(String(doc.getElementById('arthurDesc').value || '').indexOf('{') >= 0,
        '原技能的说明（带占位符）也填进了说明框', JSON.stringify(String(doc.getElementById('arthurDesc').value || '').slice(0, 40)));
    }
  }
  await new Promise(r => setTimeout(r, 100));
  ok(errors.length === 0, '全程没有 console.error', errors.slice(0, 3).join(' | '));

  // ---- 「自定义卡面」：开弹窗 → 检测 → 加密包告警 → 换 ID → 塞图 → 干跑 → 真写
  const deepText = (n) => String(n.textContent || '') + ' ' + (n.childNodes || []).map(deepText).join(' ');
  const waitFor = async (fn, ms) => {          // 前端有异步请求，别用固定 sleep 赌时间
    const until = Date.now() + (ms || 5000);
    for (;;) { const v = fn(); if (v) return v; if (Date.now() > until) return null; await new Promise(r => setTimeout(r, 60)); }
  };
  ok(/id="btnCustomArt"/.test(html), '页面上有「🖼 自定义卡面」按钮');
  ok(/function openCustomArt\(/.test(script[1]), '脚本里有自定义卡面的实现');
  ok(/Live2D 动态卡面/.test(html) && /关掉它的动态卡面/.test(script[1]),
    '页面上写了 Live2D 动态卡面的事（并且有开关）—— 之前说「没有 live2d」是错的，已改');
  doc.getElementById('pictId').value = '10152034';        // 用户现在这张卡（chr10 在加密包里）
  const btnArt = doc.getElementById('btnCustomArt');
  ok(typeof btnArt.onclick === 'function', '「自定义卡面」按钮绑上了点击事件');
  let artErr = null;
  try { btnArt.onclick(); } catch (e) { artErr = e; }
  ok(!artErr, '点「自定义卡面」没有抛错', artErr ? artErr.message : '');
  await new Promise(r => setTimeout(r, 600));
  const modalArt = findAll(n => n.class === 'modal').pop();
  ok(!!modalArt, '自定义卡面弹窗开起来了');
  const artText1 = modalArt ? deepText(modalArt) : '';
  ok(/卡面大图/.test(artText1) && /卡面小图/.test(artText1) && /放大立绘/.test(artText1),
    '弹窗里列了三张图（卡面大图 / 卡面小图 / 放大立绘）');
  ok(/CN 加密包/.test(artText1), '卡面大图改不了时明确说了「CN 加密包」（不闷着不说）');
  ok(/整套都能改/.test(artText1) || /整套都能改/.test(deepText(findAll(n => n.class === 'cropnote')[0] || modalArt)),
    '给了「换成整套都能改的卡面 ID」的出路');
  const useBtn = await waitFor(() => findAll(n => n.tagName === 'BUTTON' && textOf(n) === '用这个 ID')[0], 8000);
  ok(!!useBtn, '候选列表里有「用这个 ID」按钮');
  ok(await waitFor(() => /Live2D 状态|动态卡面|都不是 Live2D/.test(deepText(modalArt)), 8000) !== null,
    '弹窗里查出了这个卡面 ID 的 Live2D 状态');
  if (useBtn) {
    try { useBtn.onclick(); } catch (e) { artErr = e; }
    await new Promise(r => setTimeout(r, 600));
    ok(!artErr, '换卡面 ID 没有抛错', artErr ? artErr.message : '');
    const artText2 = modalArt ? deepText(modalArt) : '';
    ok(/能改「卡面大图」/.test(artText2), '换成可改的 ID 后说「能改卡面大图」了');
    ok(/裁剪比例/.test(artText2), '出现了「裁剪比例」选择');
    // 塞一张假图进去（走真实的 loadFile 路径）
    const fileInput = findAll(n => n.tagName === 'INPUT' && String(n.type) === 'file')[0];
    ok(!!fileInput, '弹窗里有选图片的输入框');
    if (fileInput) {
      fileInput.files = [{ type: 'image/png', name: 'test.png' }];
      try { fileInput.onchange(); } catch (e) { artErr = e; }
      await new Promise(r => setTimeout(r, 120));
      ok(!artErr, '选图片 / 载入图片没有抛错', artErr ? artErr.message : '');
      ok(/test\.png/.test(deepText(modalArt)), '图片名显示出来了（说明真的载入了）');
    }
    // 干跑
    const dryB = findAll(n => n.tagName === 'BUTTON' && textOf(n) === '干跑（不写盘）')[0];
    ok(!!dryB, '弹窗里有「干跑（不写盘）」按钮');
    if (dryB) {
      try { dryB.onclick(); } catch (e) { artErr = e; }
      await new Promise(r => setTimeout(r, 500));
      ok(!artErr, '干跑没有抛错', artErr ? artErr.message : '');
    }
    const post = posted.filter(p => p.path === '/api/art/apply').pop();
    ok(!!post, '干跑真的把裁剪结果发给了后台');
    if (post) {
      const b = post.body;
      ok(b.write === false, '干跑带的是 write:false（一个字节都不写）', String(b.write));
      ok(typeof b.pictId === 'number' && b.pictId > 0, '带上了卡面 ID', String(b.pictId));
      const i10 = b.images && b.images.chr10;
      ok(!!i10 && i10.w === 512 && i10.h === 512, '卡面大图按游戏原始尺寸 512×512 裁',
        i10 ? (i10.w + '×' + i10.h) : '(没有 chr10)');
      if (i10) ok(Buffer.from(String(i10.rgbaBase64), 'base64').length === 512 * 512 * 4,
        '卡面大图传的是原始 RGBA（字节数 = 512×512×4）',
        Buffer.from(String(i10.rgbaBase64), 'base64').length + ' 字节');
      const i20 = b.images && b.images.chr20;
      ok(!!i20 && i20.w === 256 && i20.h === 256, '小图按 256×256 裁', i20 ? (i20.w + '×' + i20.h) : '(没有 chr20)');
      // 方向：网页发的是「显示方向」，纹理上下颠倒的存储约定由后台 artwrite 翻（那边有单测）
      if (i10) ok(Buffer.from(String(i10.rgbaBase64), 'base64')[0] === 0,
        'chr10 发的是显示方向的像素（翻转交给后台做）');
      const i51 = b.images && b.images.chr51;
      ok(!!i51 && i51.w > 0 && Buffer.from(String(i51.rgbaBase64), 'base64').length === i51.w * i51.h * 4,
        '放大立绘按「裁剪区原分辨率」的 RGBA 传（服务端先抠背景再装框）', i51 ? (i51.w + 'x' + i51.h + ' → ' + JSON.stringify(i51.target)) : '(没有 chr51)');
      ok(!!i51 && i51.fit === 'contain' && !!i51.target, '放大立绘标了「装进去（contain）」+ 目标尺寸');
      // 卡面缩略图（160×160 的 webp，单独取景）
      ok(!!b.thumb && b.thumb.w === 160 && Buffer.from(String(b.thumb.rgbaBase64), 'base64').length === 160 * 160 * 4,
        '★ 卡面缩略图按 160×160 原始 RGBA 一起传上去了');
      ok(typeof b.cardId === 'number' && b.cardId > 0, '带了卡号（缩略图按卡号存）', String(b.cardId));
      ok(b.removeBg === true, '★ 带上了「把背景抠成透明」（官方卡面就是透明的，不抠圆形图标位有白方块）');
    }
    // 真写（confirm 在桩里默认返回 false，先验「不确认就不写」）
    const applyB = findAll(n => n.tagName === 'BUTTON' && textOf(n) === '裁剪并写入卡包')[0];
    ok(!!applyB, '弹窗里有「裁剪并写入卡包」按钮');
    if (applyB) {
      const before = posted.filter(p => p.path === '/api/art/apply').length;
      try { applyB.onclick(); } catch (e) { artErr = e; }
      await new Promise(r => setTimeout(r, 150));
      ok(posted.filter(p => p.path === '/api/art/apply').length === before,
        '没点「确认」时不会真写（confirm=false 就退出）');
      flags.confirm = true;
      try { applyB.onclick(); } catch (e) { artErr = e; }
      await new Promise(r => setTimeout(r, 500));
      ok(!artErr, '确认后写入没有抛错', artErr ? artErr.message : '');
      const post2 = posted.filter(p => p.path === '/api/art/apply').pop();
      ok(post2 && post2.body.write === true, '确认后带的是 write:true');
      ok(/已写入卡包/.test(deepText(modalArt)), '报告里说了「已写入卡包」');
      ok(String(doc.getElementById('pictId').value) === String(post2 && post2.body.pictId),
        '写完后左边的 PictID 跟着换成了新 ID', String(doc.getElementById('pictId').value));
    }
    // ---- 「新建一个全新卡面 ID」：按钮 + 上传内容（POST 被桩拦住，不会真建）
    const newB = findAll(n => n.tagName === 'BUTTON' && /新建卡面 ID/.test(textOf(n)))[0];
    ok(!!newB, '弹窗里有「新建卡面 ID」按钮');
    ok(!!findAll(n => n.tagName === 'BUTTON' && /删掉我建的卡面 ID/.test(textOf(n)))[0],
      '弹窗里有「删掉我建的卡面 ID」按钮（删错了能反悔）');
    ok(/卡面缩略图（160×160，单独取景）/.test(deepText(modalArt)),
      '弹窗里写了「缩略图要单独取景」（脸/头位置不固定，不能只是缩一缩）');
    ok(/全新的卡面 ID/.test(deepText(modalArt)), '弹窗里说明「全新的卡面 ID（不碰任何现有卡）」');
    if (newB) {
      const beforeN = posted.filter(p => p.path === '/api/art/new-pict').length;
      flags.confirm = true;
      try { newB.onclick(); } catch (e) { artErr = e; }
      await waitFor(() => posted.filter(p => p.path === '/api/art/new-pict').length > beforeN, 5000);
      const np = posted.filter(p => p.path === '/api/art/new-pict').pop();
      ok(!!np && np.body.write === true, '点按钮会把新卡面的三张图 POST 给后台（write:true）');
      if (np) {
        const im = np.body.images || {};
        ok(im.chr10 && im.chr10.w === 512 && Buffer.from(String(im.chr10.rgbaBase64), 'base64').length === 512 * 512 * 4,
          '卡面大图按 512×512 原始 RGBA 上传');
        ok(im.chr20 && im.chr20.w === 256 && Buffer.from(String(im.chr20.rgbaBase64), 'base64').length === 256 * 256 * 4,
          '小图按 256×256 原始 RGBA 上传');
        ok(im.chr51 && im.chr51.target && im.chr51.target.w === 1280 && im.chr51.target.h === 1024 && im.chr51.fit === 'contain',
          '★ 新卡面 ID 的放大立绘目标是官方主流 1280×1024（5:4）且用 contain 装框（不被客户端挤变形、也不裁人物）',
          im.chr51 ? JSON.stringify(im.chr51.target) + ' fit=' + im.chr51.fit : '(没有 chr51)');
        ok(np.body.removeBg === true, '新建卡面 ID 时带上了「抠背景」开关');
        ok(!!np.body.thumb && np.body.thumb.w === 160 && Buffer.from(String(np.body.thumb.rgbaBase64), 'base64').length === 160 * 160 * 4,
          '新建卡面 ID 时也把缩略图（160×160）一起传了');
      }
      await new Promise(r => setTimeout(r, 200));
    }
  }
  await new Promise(r => setTimeout(r, 100));
  ok(errors.length === 0, '自定义卡面全程没有 console.error', errors.slice(0, 3).join(' | '));

  // ---- ★ 回归：条件变体里不许把效果块删到 0 个（用户 2026-09-23 遇到的报错就是这个）
  sandbox.addVariant();                       // 加一个条件变体（页面自带一个 attack 块）
  const variantsHost = doc.getElementById('variants');
  const variantWrap = variantsHost.childNodes[variantsHost.childNodes.length - 1];
  let innerHost = null;
  const seekInner = (n) => {
    for (const c of (n.childNodes || [])) { if (c._isVariantBlocks) { innerHost = c; return; } seekInner(c); }
  };
  seekInner(variantWrap);
  ok(!!innerHost, '变体的块容器带了标记（守卫靠它判断）');
  const innerBlocks = innerHost ? innerHost.querySelectorAll('.blk') : [];
  ok(innerBlocks.length === 1, '新加的条件变体里有 1 个效果块', innerBlocks.length + ' 个');
  const insideVariant = (node) => { let p = node; while (p) { if (p === innerHost) return true; p = p.parentNode; } return false; };
  const blockHost = innerBlocks[0];
  const blockBtns = blockHost ? blockHost.querySelectorAll('button') : [];
  const delInVariant = blockBtns[0];
  ok(!!delInVariant, '找得到变体里那个块的「删除」按钮', blockBtns.length + ' 个按钮');
  if (delInVariant && innerHost) {
    const before = innerHost.querySelectorAll('.blk').length;
    let delErr = null;
    try { delInVariant.onclick(); } catch (e) { delErr = e; }
    ok(!delErr, '点它没有抛错', delErr ? delErr.message : '');
    ok(innerHost.querySelectorAll('.blk').length === before,
      '★ 删最后一个效果块被拦住了（不会留下空变体 ⇒ 不会报「一个效果块都没有」）',
      innerHost.querySelectorAll('.blk').length + ' 个');
    ok(announced.some(a => /至少要留一个效果块/.test(String(a))), '并且弹了提示告诉用户该怎么办',      String(announced.filter(a => /效果块/.test(String(a))).slice(-1)[0] || '').slice(0, 60));
    const addInside = findAll(n => n.tagName === 'BUTTON' && textOf(n) === '+ 加效果块').filter(insideVariant)[0];
    if (addInside) {
      addInside.onclick();
      const two = innerHost.querySelectorAll('.blk').length;
      delInVariant.onclick();
      ok(innerHost.querySelectorAll('.blk').length === two - 1, '有两个块时删除是允许的',
        two + ' 个 → ' + innerHost.querySelectorAll('.blk').length + ' 个');
    }
  }

  // ---- ★ 台词 / 配音（card.csv 第 67 / 82 列）：页面要能填、能清空、能被 collectDraft 带上
  console.log('\n=== 台词与配音 ===');
  ok(!!doc.getElementById('serifText'), '页面有「台词」输入框');
  ok(!!doc.getElementById('voiceId'), '页面有「配音 ID」输入框');
  ok(!!doc.getElementById('btnPickVoice'), '页面有「借用别的配音…」按钮');
  doc.getElementById('serifText').value = '第一行<br>第二行';
  doc.getElementById('voiceId').value = '600740010';
  const d1 = sandbox.collectDraft();
  ok(d1.serif === '第一行<br>第二行', 'collectDraft 带上台词（<br> 原样保留）', JSON.stringify(d1.serif));
  ok(d1.voiceId === '600740010', 'collectDraft 带上配音 ID', JSON.stringify(d1.voiceId));
  ok(!!doc.getElementById('btnAuditionVoice'), '页面有「▶ 试听」按钮（配音能先听再选）');
  ok(typeof sandbox.auditionVoice === 'function', '页面有 auditionVoice()');
  sandbox.auditionVoice('600740010');           // 会设 <audio>.src 并 play()（桩里 play 不存在 → 走 catch）
  await new Promise(r => setTimeout(r, 30));
  ok(errors.length === 0, '试听调用没有抛错', errors.slice(0, 2).join(' | '));
  doc.getElementById('serifText').value = '';
  doc.getElementById('voiceId').value = '';
  const d2 = sandbox.collectDraft();
  ok(d2.serif === '' && d2.voiceId === '', '清空后送的是空串（能做出「没台词的卡」）',
    JSON.stringify({ serif: d2.serif, voiceId: d2.voiceId }));

  // ---- ★ 通常技自动生成规则（2026-09-25 用户定）：不管覚醒技几段，只取第 1 段并弱化
  console.log('\n=== 通常技：只取第 1 段 ===');
  {
    const blocksHost = doc.getElementById('blocks');
    blocksHost.innerHTML = '';
    const mk = (kind, params) => { const w = sandbox.addBlock ? sandbox.addBlock(blocksHost) : null; return w; };
    // 直接塞三段效果块（用页面自己的读块回调）
    const specs = [
      { kind: 'atkUp', params: { 0: '3', 1: 'INT', 3: '2000', 4: '200' }, roleTarget: 'SELF', chainRate: 20 },
      { kind: 'attack', params: { 0: '1000', 1: '20000', 2: '1000' }, chainRate: 20 },
      { kind: 'draw', params: { 0: '2' }, roleTarget: 'SELF' },
    ];
    if (typeof sandbox.renderBlocks === 'function') sandbox.renderBlocks(specs);
    else {
      blocksHost.innerHTML = '';
      for (const s of specs) {
        const d = doc.createElement('div'); d.className = 'blk'; d._read = () => JSON.parse(JSON.stringify(s));
        blocksHost.appendChild(d);
      }
    }
    doc.getElementById('arthurName').value = '测试觉醒技';
    doc.getElementById('arthurDesc').value = '';            // 说明留空 → 工具自动生成
    doc.getElementById('normalMode').value = 'weaken';
    doc.getElementById('weakenScale').value = '0.6';
    const dn = sandbox.collectDraft();
    const nb = (dn.normal && dn.normal.skill && dn.normal.skill.blocks) || [];
    ok(nb.length === 1, '★ 覚醒技 3 段 → 通常技只有 1 段', nb.length + ' 段');
    ok(nb[0] && nb[0].kind === 'atkUp', '取的是第 1 段（不是伤害那段）', nb[0] && nb[0].kind);
    ok(nb[0] && nb[0].params[3] === '1200' && nb[0].params[4] === '120', '第 1 段数值弱化 ×0.6', nb[0] ? nb[0].params[3] + '/' + nb[0].params[4] : '-');
    ok((dn.normal.skill.variants || []).length === 0, '通常技不带条件变体');
    ok(dn.normal.skill.description === undefined, '★ 不继承覚醒技的说明（让服务端按这 1 段重新生成）', String(dn.normal.skill.description));
    doc.getElementById('weakenScale').value = '0.3';
    const dn2 = sandbox.collectDraft();
    ok(dn2.normal.skill.blocks[0].params[3] === '600', '弱化系数改成 0.3 立刻生效', dn2.normal.skill.blocks[0].params[3]);
    doc.getElementById('arthurDesc').value = '手填的说明';
    const dn3 = sandbox.collectDraft();
    ok(dn3.arthur.skill.description === '手填的说明', '覚醒技仍然用你手填的说明', String(dn3.arthur.skill.description));
    ok(dn3.normal.skill.description === undefined, '但通常技不会跟着抄过去', String(dn3.normal.skill.description));
    doc.getElementById('arthurDesc').value = '';
    doc.getElementById('normalMode').value = 'weaken';
    if (typeof sandbox.renderBlocks === 'function') sandbox.renderBlocks([]);
    else blocksHost.innerHTML = '';
    doc.getElementById('normalMode').value = 'weaken';
  }

  // ---- ★ 卡牌库：按钮、方案快照、导出/导入接口
  console.log('\n=== 卡牌库（方案记忆 / 分享）===');
  ok(!!doc.getElementById('btnLibrary'), '顶栏有「卡牌库」按钮');
  ok(typeof sandbox.currentPreset === 'function', '页面有 currentPreset()（把当前表单打成一条方案）');
  ok(typeof sandbox.applyPreset === 'function', '页面有 applyPreset()（把一条方案恢复进表单）');
  doc.getElementById('crown').value = '【MOD】';
  doc.getElementById('name').value = '库测试卡';
  doc.getElementById('cardId').value = '99993009';
  doc.getElementById('serifText').value = '库里的台词';
  doc.getElementById('voiceId').value = '600040010';
  const preset = sandbox.currentPreset({ note: 'unit' });
  ok(preset.draft && preset.draft.name === '库测试卡' && preset.draft.serif === '库里的台词',
    '方案里是完整配方（名字/台词都在）', JSON.stringify({ name: preset.draft && preset.draft.name, serif: preset.draft && preset.draft.serif }));
  ok(preset.cardId === 99993009 && preset.title === '【MOD】库测试卡', '方案带卡号和标题', JSON.stringify({ cardId: preset.cardId, title: preset.title }));
  // 恢复：把名字改掉再 applyPreset，应该整份回到方案里的样子
  doc.getElementById('name').value = '被改掉了';
  doc.getElementById('serifText').value = '';
  doc.getElementById('voiceId').value = '';
  await sandbox.applyPreset(preset, { silent: true });        // applyPreset 是 async（要先把克隆源查回来）
  ok(doc.getElementById('name').value === '库测试卡' && doc.getElementById('serifText').value === '库里的台词' &&
     doc.getElementById('voiceId').value === '600040010', 'applyPreset 把名字/台词/配音都恢复回来',
    JSON.stringify({ n: doc.getElementById('name').value, s: doc.getElementById('serifText').value, v: doc.getElementById('voiceId').value }));
  const libBtn = doc.getElementById('btnLibrary');
  const libModalText = () => { const m = findAll(n => n.class === 'modal').pop(); return m ? deepText(m) : ''; };
  let libErr = null;
  try { libBtn.onclick(); } catch (e) { libErr = e; }
  await new Promise(r => setTimeout(r, 60));
  ok(!libErr, '点「卡牌库」不抛错', libErr ? libErr.message : '');
  ok(libModalText().includes('卡牌库'), '弹出的窗口里有卡牌库内容', libModalText().slice(0, 40));
  ok(libModalText().includes('导入别人的文件'), '窗口里有「导入别人的文件」（用户要的分享功能）');
  ok(libModalText().includes('导出全部'), '窗口里有「导出全部」');
  ok(errors.length === 0, '台词/卡牌库这一段没有 console.error', errors.slice(0, 3).join(' | '));

  console.log('\n' + (bad === 0 ? '=== PAGE SMOKE TEST PASSED ===' : '=== ' + bad + ' FAILURE(S) ==='));
  process.exit(bad === 0 ? 0 : 1);
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
