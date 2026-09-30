// Remove the two smoke-test cards from the real package and reseal.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const PKG = (process.env.KAIRI_PKG || require('../lib/tools').findPackage());
const TOOLS = '<发行包目录>\\tools';
const REMOVE = [99992000, 99992001];

function parseCsvLine(line) {
  const out = []; let sb = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { sb += '"'; i++; } else q = false; } else sb += c; }
    else { if (c === '"') q = true; else if (c === ',') { out.push(sb); sb = ''; } else sb += c; }
  }
  out.push(sb); return out;
}
function stripRows(file, ids, keyIndex = 0) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const nl = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const set = new Set(ids.map(String));
  const kept = []; let dropped = 0;
  for (const l of lines) {
    if (l && !l.startsWith('#')) {
      const f = parseCsvLine(l);
      if (set.has(f[keyIndex])) { dropped++; continue; }
    }
    kept.push(l);
  }
  fs.writeFileSync(file, kept.join(nl) + nl, 'utf8');
  return dropped;
}

const srv = path.join(PKG, 'resource-set', '_local', 'control', 'server');
// 1/6. the skill + role rows those cards own
const skillIds = new Set();
for (const id of REMOVE) {
  const lines = fs.readFileSync(path.join(srv, 'cn602-card-master', 'card.csv'), 'utf8').replace(/\r\n/g, '\n').split('\n');
  for (const l of lines) {
    if (!l || l.startsWith('#')) continue;
    const f = parseCsvLine(l);
    if (f[0] !== String(id)) continue;
    for (const c of [26, 27, 28, 29, 30, 31, 32, 33]) if (f[c] && f[c] !== '0') skillIds.add(f[c]);
  }
}
// the FunctionIDs those skills point at
const funcIds = new Set();
{
  const lines = fs.readFileSync(path.join(srv, 'cn602-battle-master', 'skill_player.csv'), 'utf8').replace(/\r\n/g, '\n').split('\n');
  for (const l of lines) {
    if (!l || l.startsWith('#')) continue;
    const f = parseCsvLine(l);
    if (!skillIds.has(f[0])) continue;
    const fid = (f[49] || '').trim() || f[0];
    funcIds.add(fid);
  }
}
console.log('cards to remove     : ' + REMOVE.join(', '));
console.log('skills to remove    : ' + [...skillIds].join(', '));
console.log('function ids to drop: ' + [...funcIds].join(', '));

const dCard = stripRows(path.join(srv, 'cn602-card-master', 'card.csv'), REMOVE);
const dSkill = stripRows(path.join(srv, 'cn602-battle-master', 'skill_player.csv'), [...skillIds]);
const dRole = stripRows(path.join(srv, 'cn602-battle-master', 'skill_role_player.csv'), [...funcIds]);
console.log('dropped rows: card=' + dCard + ' skill=' + dSkill + ' role=' + dRole);

// 3/4. master: templates + deck_rank
const masterPath = path.join(srv, 'cn602-card-runtime-master.json');
const master = JSON.parse(fs.readFileSync(masterPath, 'utf8'));
const beforeTpl = master.card_templates.length;
master.card_templates = master.card_templates.filter(t => !REMOVE.includes(t.card_id));
for (const id of REMOVE) delete master.deck_rank_policy.cards[String(id)];
console.log('templates: ' + beforeTpl + ' -> ' + master.card_templates.length);

// keep the admin coverage consistent with the new template count
const adminPath = path.join(srv, 'cn602-admin-assets', 'manifest.json');
const admin = JSON.parse(fs.readFileSync(adminPath, 'utf8'));
const cc = admin.catalog_image_coverage.card;
const tplCount = master.card_templates.length;
console.log('admin entry_count: ' + cc.entry_count + ' -> ' + tplCount);
cc.entry_count = tplCount;
cc.resolved_source_count = tplCount - cc.source_gap_count;
if (admin.exported) admin.exported.card = tplCount;

fs.writeFileSync(masterPath, JSON.stringify(master, null, 2) + '\n', 'utf8');
fs.writeFileSync(adminPath, JSON.stringify(admin, null, 2) + '\n', 'utf8');

// 5. thumbnails
for (const id of REMOVE) {
  const p = path.join(srv, 'cn602-admin-assets', 'card', id + '.webp');
  if (fs.existsSync(p)) { fs.unlinkSync(p); console.log('deleted thumbnail ' + id + '.webp'); }
}
console.log('done (still need: rebuild container.dat + reseal)');
