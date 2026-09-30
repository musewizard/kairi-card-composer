// Exercise every endpoint of the composer server.
const BASE = 'http://127.0.0.1:8788';
let bad = 0;
const ok = (c, m, d) => { console.log((c ? '  [OK]   ' : '  [FAIL] ') + m + (d ? '  ' + d : '')); if (!c) bad++; };

async function get(p) {
  const r = await fetch(BASE + p);
  const j = await r.json();
  if (!r.ok) throw new Error(p + ' -> ' + (j.error || r.status));
  return j;
}
async function post(p, body) {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(p + ' -> ' + (j.error || r.status));
  return j;
}

(async () => {
  console.log('=== GET / (UI) ===');
  const html = await (await fetch(BASE + '/')).text();
  ok(html.includes('效果拼接器'), 'index.html served');
  ok(html.includes('/api/preview'), 'UI references the preview endpoint');

  console.log('\n=== GET /api/state ===');
  const st = await get('/api/state');
  ok(st.cardCount > 8000, 'card count', String(st.cardCount));
  ok(st.nextCardId > st.maxCardId, 'nextCardId > maxCardId', st.nextCardId + ' > ' + st.maxCardId);
  ok(st.effects >= 24, 'effect palette size（≥24 就算过，加了新效果不该报错）', String(st.effects));

  console.log('\n=== GET /api/cards ===');
  const cs = await get('/api/cards');
  ok(cs.cards.length === st.cardCount, 'card list length matches', String(cs.cards.length));
  const c182 = cs.cards.find(c => c.id === 10000182);
  ok(!!c182 && c182.job === '盗贼', 'clone source is a thief card', JSON.stringify(c182 && { id: c182.id, job: c182.job, rarity: c182.rarity }));

  console.log('\n=== GET /api/clone?id=10000182 ===');
  const src = await get('/api/clone?id=10000182');
  ok(src.parameterInitial.hp === 65, 'initial hp from the live table', String(src.parameterInitial.hp));
  ok(src.arthurType === 3, 'arthur_type = 3 (thief)', String(src.arthurType));

  console.log('\n=== GET /api/palette ===');
  const pal = await get('/api/palette');
  ok(pal.effects.length >= 24, 'effects（≥24）', String(pal.effects.length));
  ok(pal.conditions.length === 22, 'conditions (server whitelist)', String(pal.conditions.length));
  const draw = pal.effects.find(e => e.id === 'draw');
  ok(draw.params['0'].observed.some(o => o.value === '2'), 'draw offers a real observed value 2');
  const atk = pal.effects.find(e => e.id === 'attack');
  ok(atk.allowedTargets.length === 2, 'attack targets = 敌单体/敌全体');

  console.log('\n=== POST /api/preview (composed draft) ===');
  const draft = {
    id: st.nextCardId, clone: 10000182, crown: '【MOD】', name: '接口测试卡',
    rarityRank: 7, arthurType: 1, cost: 1, levelMax: 80, fameMax: 100, loveMax: 10000,
    pictId: 10152034, experienceTableId: 107, premiumRarity: false,
    parameterInitial: { hp: 2000, attack: 700, magic: 700, mind: 350 },
    parameterMaximum: { hp: 6000, attack: 2000, magic: 2000, mind: 1000 },
    element: 'ICE',
    arthur: {
      mode: 'custom',
      skill: {
        name: '术援／接口测试', kind: 'SORCERY', element: 'ICE', damageKind: 'MAGIC',
        target: 'ENEMY_ONE', displayRole: 1, cost: 1,
        blocks: [
          { kind: 'atkUp', params: { 0: '3', 1: 'INT', 3: '2000', 4: '200' }, roleTarget: 'SELF', chainRate: 20 },
          { kind: 'attack', params: { 0: '1000', 1: '20000', 5: 'INT', 7: 'ICE', 8: 'MAGIC' }, roleTarget: 'SELECT', chainRate: 20 },
          { kind: 'draw', params: { 0: '2' }, roleTarget: 'SELF', chainRate: 0 },
        ],
        variants: [{
          skillTarget: 'ENEMY_ALL', condition: 'DECK_COMBO_COUNT', conditionValues: { min: 3, max: 0 }, priority: 1,
          blocks: [{ kind: 'attack', params: { 0: '1000', 1: '20000', 5: 'INT', 7: 'ICE', 8: 'MAGIC' }, roleTarget: 'ENEMY_ALL', chainRate: 20 }],
        }],
      },
    },
    normal: {
      mode: 'custom',
      skill: {
        name: '术冰／接口测试·弱', kind: 'SORCERY', element: 'ICE', job: 'THIEF', damageKind: 'MAGIC',
        target: 'ENEMY_ONE', displayRole: 1, cost: 1,
        blocks: [{ kind: 'attack', params: { 0: '600', 1: '12000', 5: 'INT', 7: 'ICE', 8: 'MAGIC' }, roleTarget: 'SELECT', chainRate: 20 }],
        variants: [],
      },
    },
  };
  const pv = await post('/api/preview', { draft });
  const R = pv.resolved;
  ok(R.jobCn === '佣兵', 'job resolved to 佣兵', R.jobCn);
  ok(R.derivedLv1.hp === 2003, 'derived Lv1 hp = 2003 (2000 + 300/100)', String(R.derivedLv1.hp));
  ok(R.slots.arthur.description.includes('｜'), 'arthur description uses the ｜ separator', R.slots.arthur.description);
  ok(R.slots.arthur.description.includes('抽牌+2'), 'description ends with the draw tip');
  ok(R.slots.arthur.placeholderProblems.length === 0, 'no placeholder problems');
  ok(R.slots.arthur.blocks.length === 3, 'three blocks compiled');
  ok(R.slots.arthur.variants.length === 1, 'one conditional variant');
  ok(R.slots.arthur.variants[0].skillTarget === 'ENEMY_ALL', '★ variant switches to 敌全体');
  ok(R.slots.arthur.variants[0].conditionText === '【3连携以上】', 'variant condition text', R.slots.arthur.variants[0].conditionText);

  console.log('\n=== POST /api/inject write:false (must NOT touch the package) ===');
  const stateBefore = await get('/api/state');
  const inj = await post('/api/inject', { draft, write: false });
  ok(inj.ok && inj.written === false, 'write:false reported nothing written');
  ok(inj.logs.some(l => l.includes('未写盘')), 'logs confirm the package was untouched');
  const stateAfter = await get('/api/state');
  ok(stateAfter.cardCount === stateBefore.cardCount && stateAfter.templateCount === stateBefore.templateCount,
    'card/template counts unchanged after write:false',
    stateBefore.cardCount + '->' + stateAfter.cardCount + ' / ' + stateBefore.templateCount + '->' + stateAfter.templateCount);
  process.stdout.write('  (last log) ' + (inj.logs[inj.logs.length - 1] || '') + '\n');

  console.log('\n=== negative case: a card with no 通常技 must be refused ===');
  try {
    await post('/api/inject', { draft: Object.assign({}, draft, { normal: { mode: 'none' } }), write: false });
    ok(false, 'empty 通常技 was accepted (should have been refused)');
  } catch (e) {
    ok(/通常技不能为空/.test(e.message), 'empty 通常技 is refused with a clear message', e.message.slice(0, 46));
  }

  // ---- ★ 回归（用户 2026-09-23 实测的报错）：空技能以前会炸成
  //      "Cannot read properties of undefined (reading 'kind')"，现在必须是 400 + 人话
  console.log('\n=== 回归：空技能 / 空变体 ===');
  const previewPost = async (d) => {
    const r = await fetch(BASE + '/api/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draft: d }) });
    return { status: r.status, j: await r.json() };
  };
  const emptyBlocks = Object.assign({}, draft, {
    arthur: { mode: 'custom', skill: Object.assign({}, draft.arthur.skill, { blocks: [], variants: [] }) },
  });
  const r1 = await previewPost(emptyBlocks);
  ok(r1.status === 400, '覚醒技一个效果块都没有 → HTTP 400（不再是 500）', 'HTTP ' + r1.status);
  ok(/至少要留一个效果块/.test(String(r1.j.error)) && r1.j.friendly === true, '给的是人话，而且没有堆栈',
    String(r1.j.error).slice(0, 40) + ' / stack=' + (r1.j.stack ? '有' : '没有'));
  ok(!/reading 'kind'/.test(String(r1.j.error)), '★ 不再是那个 TypeError', String(r1.j.error).slice(0, 46));

  const weirdMode = Object.assign({}, draft, { normal: { mode: 'weaken' } });   // 缺 skill 的旧式写法
  const r2 = await previewPost(weirdMode);
  ok(r2.status === 400 && /通常技/.test(String(r2.j.error)), '「通常技」缺块时也是 400 + 指出是哪个技能',
    'HTTP ' + r2.status + ' ' + String(r2.j.error).slice(0, 40));

  const emptyVariant = Object.assign({}, draft, {
    arthur: { mode: 'custom', skill: Object.assign({}, draft.arthur.skill, {
      variants: [{ skillTarget: 'ENEMY_ALL', condition: 'TURN', conditionValues: { min: 1, max: 3 }, priority: 1, blocks: [] }] }) },
  });
  const r3 = await previewPost(emptyVariant);
  const s3 = r3.j && r3.j.resolved && r3.j.resolved.slots && r3.j.resolved.slots.arthur;
  ok(r3.status === 200 && !!s3, '空的条件变体被丢掉，预览照常成功（不连坐）', 'HTTP ' + r3.status);
  ok(!!s3 && s3.skippedVariants === 1, '并且告诉界面「丢掉了 1 个空变体」', String(s3 && s3.skippedVariants));

  // ---- 台词 / 配音 的数据源
  console.log('\n=== GET /api/voices（配音表：按配音 ID 聚合）===');
  const vv = await get('/api/voices');
  ok(Array.isArray(vv.voices) && vv.voices.length > 800, '配音 ID 数量', String(vv.voices.length));
  ok(vv.voices[0].cards >= vv.voices[vv.voices.length - 1].cards, '按「用的人多」排序',
    vv.voices[0].voiceId + '(' + vv.voices[0].cards + '张) … ' + vv.voices[vv.voices.length - 1].voiceId + '(' + vv.voices[vv.voices.length - 1].cards + '张)');
  const v182 = vv.voices.find(v => v.voiceId === '600740010');
  ok(!!v182 && v182.cards >= 1 && !!v182.sample, '克隆源那张卡的配音在里面（带样例卡名）',
    v182 ? (v182.cards + ' 张卡 · 例：' + v182.sample) : '(没有)');
  ok(vv.voices.filter(v => !/^\d+$/.test(v.voiceId)).length === vv.invalid,
    '官方表里那几条错数据（把台词填进配音列）被单独标了出来（页面上会警告）', String(vv.invalid));
  ok(vv.voices.every(v => !/^0+$/.test(v.voiceId)), '空/全 0 的不列出来');
  ok(vv.voices.filter(v => v.numeric).length > 1000, '绝大多数是纯数字 ID', String(vv.voices.filter(v => v.numeric).length));
  ok(vv.withAudio > 8000 && vv.withAudio <= vv.count, '★ 合进了「包里真实存在的配音音频」（CueSheet_Card_*.cpk 里的 <ID>.acb）',
    vv.count + ' 个 ID，其中 ' + vv.withAudio + ' 个有音频');
  ok(vv.free > 5000, '★ 其中有很多「没有任何官方卡在用」的空闲档（借来最放心）', String(vv.free));
  ok(vv.voices.some(v => v.free === true && v.hasAudio === true), '空闲档带 free/hasAudio 标记',
    JSON.stringify((vv.voices.find(v => v.free) || {}).voiceId));
  ok(vv.voices[0].hasAudio !== false, '有音频的排在前面', String(vv.voices[0].cards) + ' 张卡用 ' + vv.voices[0].voiceId);
  ok(typeof vv.decoder === 'boolean', '列表里带上「有没有解码器」（页面据此决定要不要显示试听）', String(vv.decoder));
  const s182 = await get('/api/clone?id=10000182');
  ok(s182.voiceId === '600740010' && typeof s182.serif === 'string' && s182.serif.length > 5,
    '/api/clone 也把台词和配音一起给页面（套用克隆源时能带进来）',
    (s182.voiceId || '') + ' / ' + String(s182.serif).slice(0, 18));

  // ---- 卡牌库：真存一条 → 列表能看到 → 导出 → 导入（去重）→ 删掉（自己收拾干净）
  console.log('\n=== /api/library（方案库：存/列/导出/导入/删）===');
  const lib0 = await get('/api/library');
  ok(!!lib0.file && Array.isArray(lib0.presets), '列表接口给了库文件路径 + 方案数组', lib0.file);
  const before = lib0.presets.length;
  const mkPreset = (name) => ({ cardId: 99993001, clone: 10000182, title: '【测试】' + name,
    draft: { id: 99993001, clone: 10000182, crown: '【测试】', name, serif: '测试台词', voiceId: '600740010',
      pictId: 10152034, rarityRank: 7, arthurType: 1, cost: 1, levelMax: 80, fameMax: 100, loveMax: 10000,
      parameterInitial: { hp: 1, attack: 1, magic: 1, mind: 1 }, parameterMaximum: { hp: 2, attack: 2, magic: 2, mind: 2 },
      element: 'ICE', arthur: { mode: 'custom', skill: { name: 'x', kind: 'SORCERY', blocks: [{ kind: 'attack', params: { 0: '1' }, roleTarget: 'SELECT', chainRate: 20 }], variants: [] } },
      normal: { mode: 'weaken' } } });
  const saved = await post('/api/library/save', { preset: mkPreset('接口测试卡') });
  ok(saved.ok && (saved.action === 'added' || saved.action === 'updated'), '存一条进库', JSON.stringify(saved.action));
  const lib1 = await get('/api/library');
  ok(lib1.presets.length === before + (saved.action === 'added' ? 1 : 0), '列表里能看到它（新增时）',
    before + ' → ' + lib1.presets.length);
  const mine = lib1.presets.find(p => p.sid === saved.sid);
  ok(!!mine && mine.hasSerif === true && mine.voiceId === '600740010', '摘要里有「有台词 / 配音 ID」',
    mine ? (mine.title + ' ' + mine.voiceId) : '(没有)');
  const pack = await post('/api/library/export', { sids: [saved.sid] });
  ok(pack.format === 'kairisei-card-preset' && pack.count === 1 && pack.presets[0].draft.serif === '测试台词',
    '导出这一条（含台词）', pack.format + ' ×' + pack.count);
  const impDry = await post('/api/library/import', { pack, write: false });
  ok(impDry.ok && impDry.duplicates.length === 1 && impDry.added.length === 0,
    '把导出的包再导入 → 认出是重复（不会堆两份）', JSON.stringify({ dup: impDry.duplicates.length, added: impDry.added.length }));
  const del = await post('/api/library/delete', { sid: saved.sid });
  ok(del.ok && del.total === before, '删掉自己刚存的那条，库回到原样（不留垃圾）', before + ' → ' + del.total);

  // ---- 配音音频（试听）：只读接口
  console.log('\n=== 配音音频：/api/voice-audit · /api/voice-info · /api/voice-audio/<id> ===');
  const va = await get('/api/voice-audit');
  ok(va.ok && va.voiceCount > 8000, '配音总索引（CPK 里的音频文件数）', String(va.voiceCount));
  ok(va.cpks.every(c => c.names === c.awbs), '每个 CPK 名字数==AFS2 数', va.cpks.slice(0, 2).map(c => c.cpk + ':' + c.names).join(' '));
  const vi = await get('/api/voice-info?id=600740010');
  ok(vi.ok && vi.cpk && vi.bytes > 4096, '查单个配音在哪个 CPK、多大', vi.cpk + ' ' + vi.bytes + ' 字节');
  ok(vi.info && vi.info.ok && /HCA/.test(String(vi.info.encoding)), '里面是 CRI HCA', String(vi.info && vi.info.encoding));
  const ar = await fetch(BASE + '/api/voice-audio/600740010?force=1');
  const ab = Buffer.from(await ar.arrayBuffer());
  ok(ar.ok && (ar.headers.get('content-type') || '').includes('audio/wav'), '试听接口返回 audio/wav', 'HTTP ' + ar.status + ' ' + ar.headers.get('content-type'));
  ok(ab.length > 10000 && ab.toString('latin1', 0, 4) === 'RIFF' && ab.toString('latin1', 8, 12) === 'WAVE', 'body 是真的 WAV', ab.length + ' 字节');
  ok(ab.readUInt32LE(24) === 22050 && ab.readUInt16LE(22) === 1, 'WAV 是 22050Hz 单声道（游戏里就是这个规格）',
    ab.readUInt32LE(24) + 'Hz ' + ab.readUInt16LE(22) + 'ch');
  const nf = await fetch(BASE + '/api/voice-audio/000000000');
  ok(nf.status === 404, '不存在的配音 ID → 404（不是 500）', 'HTTP ' + nf.status);

  console.log('\n' + (bad === 0 ? '=== SERVER API TEST PASSED ===' : '=== ' + bad + ' FAILURE(S) ==='));
  process.exit(bad === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL: ' + e.message); process.exit(1); });
