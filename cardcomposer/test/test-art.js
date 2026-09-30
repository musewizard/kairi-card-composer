// Verify the new image routes + art list actually work.
const BASE = 'http://127.0.0.1:8788';
let bad = 0;
const ok = (c, m, d) => { console.log((c ? '  [OK]   ' : '  [FAIL] ') + m + (d ? '  ' + d : '')); if (!c) bad++; };

(async () => {
  console.log('=== UI loads ===');
  const html = await (await fetch(BASE + '/')).text();
  ok(html.includes('thumbgrid'), 'UI has the thumbnail grid');
  ok(html.includes('btnPickArt'), 'UI has the art picker button');
  ok(html.includes('/api/art-list'), 'UI calls the art list endpoint');

  console.log('\n=== /api/art-list ===');
  const t0 = Date.now();
  const al = await (await fetch(BASE + '/api/art-list')).json();
  console.log('  (took ' + (Date.now() - t0) + ' ms)');
  ok(Array.isArray(al.cards) && al.cards.length > 8000, 'art list has cards', String(al.cards.length));
  ok(al.largeCount > 4000, 'large art count', String(al.largeCount));
  const withLarge = al.cards.filter(c => c.hasLarge).length;
  ok(withLarge > 3000, 'cards whose PictID has an enlarged art', String(withLarge));

  console.log('\n=== GET /thumb/<id> (card thumbnail) ===');
  const s1 = await fetch(BASE + '/thumb/10000182');
  ok(s1.ok, 'thumbnail responds 200', String(s1.status));
  ok((s1.headers.get('content-type') || '').includes('image/webp'), 'served as webp', s1.headers.get('content-type'));
  const b1 = Buffer.from(await s1.arrayBuffer());
  ok(b1.length > 1000 && b1.slice(8, 12).toString('ascii') === 'WEBP', 'body is a real WEBP', b1.length + ' bytes');

  console.log('\n=== GET /art/<pictId> (chr51 enlarged art) ===');
  const s2 = await fetch(BASE + '/art/10000182');
  ok(s2.ok, 'enlarged art responds 200', String(s2.status));
  const b2 = Buffer.from(await s2.arrayBuffer());
  ok(b2.length > 1000 && b2.slice(1, 4).toString('ascii') === 'PNG', 'body is a real PNG', b2.length + ' bytes');

  console.log('\n=== path traversal must be neutralised ===');
  const s3 = await fetch(BASE + '/thumb/..%2f..%2f..%2fresource-set.json');
  ok(!s3.ok || (s3.headers.get('content-type') || '').includes('image/'),
    'a traversal attempt does not leak a JSON file', 'status=' + s3.status);

  console.log('\n=== artCardId is honoured by the injector ===');
  const st = await (await fetch(BASE + '/api/state')).json();
  const draft = {
    id: st.nextCardId, clone: 10000182, artCardId: 10274039,
    crown: '【MOD】', name: '立绘来源测试', rarityRank: 7, arthurType: 1, cost: 1,
    levelMax: 80, fameMax: 100, loveMax: 10000, pictId: 10152034, experienceTableId: 107,
    premiumRarity: false,
    parameterInitial: { hp: 2000, attack: 700, magic: 700, mind: 350 },
    parameterMaximum: { hp: 6000, attack: 2000, magic: 2000, mind: 1000 },
    element: 'ICE',
    arthur: { mode: 'custom', skill: { name: '测试', kind: 'SORCERY', damageKind: 'MAGIC',
      target: 'ENEMY_ONE', displayRole: 1,
      blocks: [{ kind: 'attack', params: { 0: '100', 1: '0', 5: 'INT', 7: 'ICE', 8: 'MAGIC' }, roleTarget: 'SELECT' }],
      variants: [] } },
    normal: { mode: 'custom', skill: { name: '测试弱', kind: 'SORCERY', damageKind: 'MAGIC',
      target: 'ENEMY_ONE', displayRole: 1, job: 'THIEF',
      blocks: [{ kind: 'attack', params: { 0: '60', 1: '0', 5: 'INT', 7: 'ICE', 8: 'MAGIC' }, roleTarget: 'SELECT' }],
      variants: [] } },
  };
  const r = await fetch(BASE + '/api/inject', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ draft, write: false }) });
  const j = await r.json();
  ok(r.ok && j.written === false, 'write:false still ok with artCardId');
  ok((j.logs || []).some(l => /未写盘/.test(l)), 'nothing written');
  // the log that would name the art source is only emitted when it actually copies
  process.stdout.write('  (logs tail) ' + (j.logs || []).slice(-1)[0] + '\n');

  // ---- 方向：bundle 纹理是上下颠倒存的（实测：导出 chr10 看到的是翻过来的画，
  //      官方 160×160 缩略图和 chr51 立绘都是正的），所以写盘前要竖直翻一次。
  console.log('\n=== 纹理方向（竖直翻转）===');
  const W = require('../lib/artwrite');
  const fs = require('fs');
  const PKG = require('../lib/pkg').DEFAULT_PACKAGE_ROOT ||
    (process.env.KAIRI_PKG || require('../lib/tools').findPackage());
  const px = Buffer.from([1, 0, 0, 255, 2, 0, 0, 255, 3, 0, 0, 255, 4, 0, 0, 255]);   // 2×2：上排 1,2 下排 3,4
  const fv = W.flipRgbaVertical(px, 2, 2);
  ok(fv[0] === 3 && fv[4] === 4 && fv[8] === 1 && fv[12] === 2,
    'flipRgbaVertical：上下两行对调（行内左右不动）', [fv[0], fv[4], fv[8], fv[12]].join(','));
  ok(px[0] === 1 && px[12] === 4, 'flipRgbaVertical 不改原 buffer');

  const origWrite = fs.writeFileSync;
  let captured = null;
  fs.writeFileSync = (p, data, ...rest) => {
    if (/art-chr10-.*\.rgba$/.test(String(p))) captured = Buffer.from(data);
    return origWrite(p, data, ...rest);
  };
  try {
    // 这两条只测「翻转」，所以关掉卡面预补偿（预补偿另有断言）
    W.applyArt(PKG, 91000953, { chr10: { rgbaBase64: px.toString('base64'), w: 2, h: 2 } }, { write: false, compensateCardFace: false });
    ok(!!captured && captured[0] === 3,
      'applyArt 默认把给它的「显示方向」像素翻成存储方向', captured ? captured.slice(0, 4).join(',') : '(没抓到)');
    captured = null;
    W.applyArt(PKG, 91000953, { chr10: { rgbaBase64: px.toString('base64'), w: 2, h: 2 } }, { write: false, flipY: false, compensateCardFace: false });
    ok(!!captured && captured[0] === 1,
      'flipY:false 时原样写（给已经是存储方向的像素用）', captured ? captured.slice(0, 4).join(',') : '(没抓到)');
  } finally { fs.writeFileSync = origWrite; }

  // ---- 卡面预补偿：客户端把正方形卡面贴进竖的 cut-in 面板会纵向多放大 ~1.4 倍
  //      （客户端脚本 player_skillcutin 的 `CardMod card_id 10 0` + 两张截图实测 sy/sx≈1.42），
  //      所以写 chr10 前先纵向压 1/1.4、上下留透明；chr20（图标）不动。
  console.log('\n=== 卡面预补偿（写 chr10 前纵向压 1.4 倍，游戏面板再拉回来）===');
  const G = 8;                                   // 8×8 灰度图：每行一个亮度值
  const grid = Buffer.alloc(G * G * 4);
  for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) { const o = (y * G + x) * 4; grid[o] = 10 + y * 10; grid[o + 3] = 255; }
  const comp = W.compressVerticalCentered(grid, G, G, W.CARD_FACE_PANEL_STRETCH);
  const rowA = (b, y) => b[(y * G) * 4 + 3] === 0 ? -1 : b[(y * G) * 4];
  ok(W.CARD_FACE_PANEL_STRETCH > 1.3 && W.CARD_FACE_PANEL_STRETCH < 1.5, '补偿系数在实测范围 1.35~1.43', String(W.CARD_FACE_PANEL_STRETCH));
  ok(rowA(comp, 0) === -1 && rowA(comp, G - 1) === -1, '压缩后上下各留一条全透明（不裁用户内容）',
    [0, 1, G - 2, G - 1].map((y) => rowA(comp, y)).join(','));
  const mid = [2, 3, 4, 5].map((y) => rowA(comp, y));
  ok(mid.every((v) => v > 10 && v < 90) && mid[0] < mid[3], '中间仍有内容（按面积加权重采样，所以是插值出来的值）', mid.join(','));
  const back = W.expandVerticalCentered(comp, G, G, W.CARD_FACE_PANEL_STRETCH);
  ok(rowA(back, 0) !== -1 && rowA(back, G - 1) !== -1, 'expandVerticalCentered 把自然比例还原回来（缩略图用）',
    [0, 1, G - 2, G - 1].map((y) => rowA(back, y)).join(','));
  // applyArt 里默认会自动补：8×8 的图写进 chr10，存储方向（翻过）后上下应各有一条透明
  const origWrite2 = fs.writeFileSync;
  let cap10 = null, cap20 = null;
  fs.writeFileSync = (p, data, ...rest) => {
    const s = String(p);
    if (/art-chr10-.*\.rgba$/.test(s)) cap10 = Buffer.from(data);
    if (/art-chr20-.*\.rgba$/.test(s)) cap20 = Buffer.from(data);
    return origWrite2(p, data, ...rest);
  };
  try {
    W.applyArt(PKG, 91000953, { chr10: { rgbaBase64: grid.toString('base64'), w: G, h: G } }, { write: false });
    ok(!!cap10 && cap10[(0 * G) * 4 + 3] === 0 && cap10[((G - 1) * G) * 4 + 3] === 0,
      'applyArt 默认对 chr10 做预补偿（存储方向下也是上下透明）', cap10 ? [rowA(cap10, 0), rowA(cap10, G - 1)].join(',') : '(没抓到)');
    cap10 = null;
    W.applyArt(PKG, 91000953, { chr10: { rgbaBase64: grid.toString('base64'), w: G, h: G } }, { write: false, compensateCardFace: false });
    ok(!!cap10 && cap10[(0 * G) * 4 + 3] === 255 && cap10[((G - 1) * G) * 4 + 3] === 255,
      'compensateCardFace:false 时保持原样（用户不满意可以关掉）', cap10 ? [rowA(cap10, 0), rowA(cap10, G - 1)].join(',') : '(没抓到)');
    W.applyArt(PKG, 91000953, { chr20: { rgbaBase64: grid.toString('base64'), w: G, h: G } }, { write: false });
    ok(!!cap20 && cap20[(0 * G) * 4 + 3] === 255 && cap20[((G - 1) * G) * 4 + 3] === 255,
      'chr20（图标）不做预补偿：小方框里本来就是自然比例', cap20 ? [rowA(cap20, 0), rowA(cap20, G - 1)].join(',') : '(没抓到)');
  } finally { fs.writeFileSync = origWrite2; }

  console.log('\n' + (bad === 0 ? '=== ART / THUMBNAIL TESTS PASSED ===' : '=== ' + bad + ' FAILURE(S) ==='));
  process.exit(bad === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL: ' + e.message); process.exit(1); });
