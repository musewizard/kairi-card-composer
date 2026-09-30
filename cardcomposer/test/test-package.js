const WORK_ROOT = process.env.KAIRI_ROOT || require('../lib/tools').ROOT;
// Test the package-location feature: identity, validation, browsing, and selecting.
const BASE = 'http://127.0.0.1:8788';
const REAL = (process.env.KAIRI_PKG || require('../lib/tools').findPackage());
let bad = 0;
const ok = (c, m, d) => { console.log((c ? '  [OK]   ' : '  [FAIL] ') + m + (d ? '  ' + d : '')); if (!c) bad++; };
const q = (p) => BASE + '/api/package/check?path=' + encodeURIComponent(p);
const br = (p) => BASE + '/api/package/browse?path=' + encodeURIComponent(p);

(async () => {
  console.log('=== UI has the package box ===');
  const html = await (await fetch(BASE + '/')).text();
  ok(html.includes('id="pkgBox"'), 'current package is shown in the header');
  ok(html.includes('/api/package/select'), 'UI can switch packages');

  console.log('\n=== GET /api/state shows package identity ===');
  const st = await (await fetch(BASE + '/api/state')).json();
  console.log('  package : ' + st.package);
  const info = st.packageInfo;
  ok(info && info.ok === true, 'package validates');
  ok(info.cards > 8000, 'card row count', String(info.cards));
  ok(info.templates > 8000, 'template count', String(info.templates));
  ok(/^[0-9a-f]{16}$/.test(info.fingerprint || ''), 'card.csv fingerprint exposed', info.fingerprint);
  ok(info.containerBytes > 1e6, 'container.dat size', String(info.containerBytes));
  ok(!!info.cardCsvMtime, 'card.csv mtime exposed', info.cardCsvMtime);
  ok(info.deployment && info.deployment.validation_only === true, 'deployment.validation_only surfaced');

  console.log('\n=== check: a good package ===');
  const good = await (await fetch(q(REAL))).json();
  ok(good.ok === true, 'the real package passes', good.root);

  console.log('\n=== check: bad paths are rejected with a reason ===');
  const cases = [
    ['D:\\definitely-not-here-12345', /不存在/],
    [(process.env.KAIRI_ROOT || require('../lib/tools').ROOT), /缺少/],
    [(WORK_ROOT + '\\HANDOFF.md'), /不是目录/],
  ];
  for (const [p, re] of cases) {
    const r = await (await fetch(q(p))).json();
    ok(r.ok === false && re.test(r.reason || ''), 'rejected: ' + p, r.reason);
  }

  console.log('\n=== browse: candidates are marked ===');
  const b = await (await fetch(br('<发行包目录>\\mod'))).json();
  ok(b.ok === true && Array.isArray(b.dirs), 'browse works', b.path);
  const cand = b.dirs.filter(d => d.candidate);
  ok(cand.length >= 1, 'found at least one package-like directory', cand.map(d => d.name).join(','));
  ok(!!b.parent, 'parent link provided', b.parent);
  const root = await (await fetch(br('D:\\'))).json();
  ok(root.ok === true && root.parent === null, 'drive root has no parent');

  console.log('\n=== selecting a bad package must fail loudly ===');
  const sel = await fetch(BASE + '/api/package/select', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: (process.env.KAIRI_ROOT || require('../lib/tools').ROOT) }) });
  const selj = await sel.json();
  ok(sel.status === 400 && /不是可用的服务端包/.test(selj.error || ''), 'bad package refused', selj.error);

  console.log('\n=== selecting the same (valid) package is a no-op that succeeds ===');
  const sel2 = await fetch(BASE + '/api/package/select', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: REAL }) });
  const sel2j = await sel2.json();
  ok(sel2.status === 200 && sel2j.ok === true, 'valid package selected');
  const st2 = await (await fetch(BASE + '/api/state')).json();
  ok(st2.package === good.root, 'state reflects the selected package', st2.package);
  ok(st2.cardCount === st.cardCount, 'card count unchanged after reselect');

  console.log('\n=== images still work after the package switch ===');
  const s1 = await fetch(BASE + '/thumb/10000182');
  ok(s1.ok, 'thumbnail still served', String(s1.status));

  console.log('\n' + (bad === 0 ? '=== PACKAGE LOCATION TESTS PASSED ===' : '=== ' + bad + ' FAILURE(S) ==='));
  process.exit(bad === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL: ' + e.message); process.exit(1); });
