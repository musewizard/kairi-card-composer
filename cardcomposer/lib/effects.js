'use strict';
/*
 * effects.js -- the card-effect vocabulary.
 *
 * This is the abstraction the composer is built on: every "thing a card can do" is a
 * declarative entry that knows
 *   - which opcode it maps to
 *   - which of the 10 parameters the user actually controls (the rest are fixed or blank)
 *   - how to write the Chinese description fragment
 *   - whether it acts on the enemy, on players, or on itself
 *
 * Everything here is grounded in the official data (tools/skill-library/out/effect-blocks.json
 * holds the mined real values) and in the server source cited per entry.
 *
 * Role block layout (skill_role_player.csv, combat_catalog.go:1238 parseCombatSkillRole):
 *   0 #ID=FunctionID  1 2D script  3 3D cut-in playlist  7 共通演出  8 機能(opcode)
 *   9 ターゲット  10 自身除く  11..19 attribute mask  20..29 Parameters[0..9]
 *   30 チェイン倍率  31 ヘイト上限
 */
const ATTR_CN = {
  FIRE: '火', ICE: '冰', WIND: '风', LIGHT: '光', DARK: '暗',
  FIRE_ICE: '火冰', FIRE_WIND: '火风', FIRE_LIGHT: '火光', FIRE_DARK: '火暗',
  ICE_WIND: '冰风', ICE_LIGHT: '冰光', ICE_DARK: '冰暗',
  WIND_LIGHT: '风光', WIND_DARK: '风暗', LIGHT_DARK: '光暗',
};
const PHYS_CN = { ATK: '物理', INT: '魔法' };
const KIND_CN = { ATK: '物理', INT: '魔法', MND: '魔法', MAX_HP: '最大血量', HP: '血量', DEF: '物理防御', MDEF: '魔法防御' };

/** Which element a card's damage uses -> the 3D cut-in playlist + 2D script. */
function artFor(element, damageKind) {
  const e = String(element || 'FIRE').toUpperCase();
  const multi = e.includes('_');
  const lower = e.toLowerCase();
  // 官方实测（全表 45001 条角色块）：
  //   单属性 物理 = pl_slash_<el>_a    单属性 魔法 = pl_magic_<el>_a   （5 个属性都存在）
  //   双属性 物理 = pl_slash_multi_c   双属性 魔法 = pl_magic_multi_c  （**没有 _a 版本**）
  //   2D 脚本与属性无关，只看物理/魔法：player_skill_slash_0a / player_skill_magic_0a
  const family = String(damageKind || '').toUpperCase() === 'PHYSICS' ? 'slash' : 'magic';
  return {
    script2d: 'player_skill_' + family + '_0a',
    playlist: multi ? ('pl_' + family + '_multi_c') : ('pl_' + family + '_' + lower + '_a'),
  };
}

/*
 * Parameter schema field kinds:
 *   'int'  free number          'enum' choose from values
 *   'fixed' always this value   'blank' always empty
 */
const FIXED = (v) => ({ kind: 'fixed', value: v });
const BLANK = () => ({ kind: 'blank', value: '' });

const EFFECTS = [
  // ------------------------------------------------------------------ damage
  {
    id: 'attack', opcode: 'ATTACK_AA', family: 'damage', side: 'enemy',
    name: '伤害',
    note: '显示值 = p0 + p1 × 等级 ÷ 1000',
    allowedTargets: ['ENEMY_ONE', 'ENEMY_ALL'],
    roleTargets: { ENEMY_ONE: 'SELECT', ENEMY_ALL: 'ENEMY_ALL' },
    params: {
      0: { kind: 'int', label: '基础威力', min: 0 },
      1: { kind: 'int', label: '每级威力', min: 0 },
      2: { kind: 'enum', label: '倍率', values: ['500', '1000', '1300', '1500', '1800', '2000'], default: '1000' },
      3: FIXED('0'),
      4: { kind: 'int', label: '攻击次数', min: 1, default: '1' },
      5: { kind: 'enum', label: '参照属性', values: ['ATK', 'INT'], default: 'ATK' },
      6: { kind: 'int', label: '会心率(0.1%)', default: '150' },
      7: { kind: 'enum', label: '伤害属性', values: Object.keys(ATTR_CN) },
      8: { kind: 'enum', label: '物理/魔法', values: ['PHYSICS', 'MAGIC'] },
      9: BLANK(),
    },
    chainRateDefault: 20,
    desc(p) {
      const t = (p.skillTarget === 'ENEMY_ALL') ? '敌全体' : '敌单体';
      const kind = p.params[8] === 'MAGIC' ? '魔法' : '物理';
      const el = ATTR_CN[p.params[7]] || p.params[7];
      let s = t + '/' + kind + '/{@v}点' + el + '属性伤害';
      const hits = Number(p.params[4]) || 1;
      if (hits > 1) {
        const pct = Math.round(Number(p.params[2]) / 10);
        s += '<br>' + kind + '攻击力' + pct + '%的' + hits + '次攻击';
      }
      return s;
    },
  },

  // ------------------------------------------------------------------ heal
  {
    id: 'heal', opcode: 'HEAL_FIXED', family: 'heal', side: 'player',
    name: '治疗',
    allowedTargets: ['SELF', 'FRIEND_ALL'],
    roleTargets: { SELF: 'SELF', FRIEND_ALL: 'FRIEND_ALL' },
    params: {
      0: { kind: 'int', label: '基础回复', min: 0 },
      1: { kind: 'int', label: '每级回复', min: 0 },
      2: { kind: 'enum', label: '倍率', values: ['500', '1000', '1300', '1500', '1800'], default: '1000' },
      3: FIXED('0'),
      4: { kind: 'enum', label: '参照属性', values: ['MND', 'MAX_HP'], default: 'MND' },
      5: BLANK(), 6: BLANK(), 7: BLANK(), 8: BLANK(), 9: BLANK(),
    },
    chainRateDefault: 20,
    desc(p) {
      const who = (p.roleTarget === 'SELF') ? '自身' : '己方全体';
      return who + '/恢复{@v}点血量';
    },
  },

  // ------------------------------------------------------------------ buffs (fixed)
  {
    id: 'atkUp', opcode: 'ATK_UP_FIXED', family: 'buffAtk', side: 'player',
    name: '提升伤害（固定值）',
    note: '加攻是【加法】族：连携只加固定点数，不是百分比',
    allowedTargets: ['SELF', 'FRIEND_ALL'],
    roleTargets: { SELF: 'SELF', FRIEND_ALL: 'FRIEND_ALL' },
    params: {
      0: { kind: 'int', label: '持续回合', min: 1, default: '3' },
      1: { kind: 'enum', label: '提升哪种伤害', values: ['ATK', 'INT'], default: 'ATK' },
      2: FIXED('1'),
      3: { kind: 'int', label: '基础值', min: 0 },
      4: { kind: 'int', label: '每级值', min: 0 },
      5: FIXED('0'), 6: BLANK(), 7: BLANK(), 8: BLANK(), 9: BLANK(),
    },
    chainRateDefault: 20,
    desc(p) {
      const who = p.roleTarget === 'SELF' ? '自身' : '己方全体';
      const dur = p.params[0];
      const what = p.params[1] === 'INT' ? '魔法伤害' : '物理伤害';
      return who + '/' + dur + '回合/提升{@v}点' + what;
    },
  },
  {
    id: 'defUp', opcode: 'DEF_UP_FIXED', family: 'buffDef', side: 'player',
    name: '提升防御（固定值）',
    allowedTargets: ['SELF', 'FRIEND_ALL'],
    roleTargets: { SELF: 'SELF', FRIEND_ALL: 'FRIEND_ALL' },
    params: {
      0: { kind: 'int', label: '持续回合', min: 1, default: '2' },
      1: { kind: 'enum', label: '提升哪种防御', values: ['ATK', 'INT'], default: 'ATK' },
      2: FIXED('1'),
      3: { kind: 'int', label: '基础值', min: 0 },
      4: { kind: 'int', label: '每级值', min: 0 },
      5: FIXED('0'), 6: BLANK(), 7: BLANK(), 8: BLANK(), 9: BLANK(),
    },
    chainRateDefault: 20,
    desc(p) {
      const who = p.roleTarget === 'SELF' ? '自身' : '己方全体';
      const what = p.params[1] === 'INT' ? '魔法防御' : '物理防御';
      return who + '/' + p.params[0] + '回合/提升{@v}点' + what;
    },
  },
  {
    id: 'atkDown', opcode: 'ATK_BREAK_FIXED', family: 'debuffAtk', side: 'enemy',
    name: '降低敌方伤害（固定值）',
    allowedTargets: ['ENEMY_ONE', 'ENEMY_ALL'],
    roleTargets: { ENEMY_ONE: 'SELECT', ENEMY_ALL: 'ENEMY_ALL' },
    params: {
      0: { kind: 'int', label: '持续回合', min: 1, default: '2' },
      1: { kind: 'enum', label: '降低哪种伤害', values: ['ATK', 'INT'], default: 'ATK' },
      2: FIXED('1'),
      3: { kind: 'int', label: '基础值', min: 0 },
      4: { kind: 'int', label: '每级值', min: 0 },
      5: FIXED('0'), 6: BLANK(), 7: BLANK(), 8: BLANK(), 9: BLANK(),
    },
    chainRateDefault: 20,
    desc(p) {
      const who = p.skillTarget === 'ENEMY_ALL' ? '敌全体' : '敌单体';
      const what = p.params[1] === 'INT' ? '魔法伤害' : '物理伤害';
      return who + '/' + p.params[0] + '回合/降低{@v}点' + what;
    },
  },
  {
    id: 'defDown', opcode: 'GUARD_BREAK_FIXED', family: 'debuffDef', side: 'enemy',
    name: '降低敌方防御（固定值）',
    allowedTargets: ['ENEMY_ONE', 'ENEMY_ALL'],
    roleTargets: { ENEMY_ONE: 'SELECT', ENEMY_ALL: 'ENEMY_ALL' },
    params: {
      0: { kind: 'int', label: '持续回合', min: 1, default: '2' },
      1: { kind: 'enum', label: '降低哪种防御', values: ['ATK', 'INT'], default: 'ATK' },
      2: FIXED('1'),
      3: { kind: 'int', label: '基础值', min: 0 },
      4: { kind: 'int', label: '每级值', min: 0 },
      5: FIXED('0'), 6: BLANK(), 7: BLANK(), 8: BLANK(), 9: BLANK(),
    },
    chainRateDefault: 20,
    desc(p) {
      const who = p.skillTarget === 'ENEMY_ALL' ? '敌全体' : '敌单体';
      const what = p.params[1] === 'INT' ? '魔法防御' : '物理防御';
      return who + '/' + p.params[0] + '回合/降低{@v}点' + what;
    },
  },

  // ------------------------------------------------------------------ buffs (percent of own stat)
  {
    id: 'atkUpPct', opcode: 'ATK_UP_BY_SELF_PARAM', family: 'buffAtk', side: 'player',
    name: '提升伤害（按自身属性%）',
    note: '威力基数 + 自身某属性 × 百分比',
    allowedTargets: ['SELF', 'FRIEND_ALL'],
    roleTargets: { SELF: 'SELF', FRIEND_ALL: 'FRIEND_ALL' },
    params: {
      0: { kind: 'int', label: '持续回合', min: 1, default: '2' },
      1: { kind: 'enum', label: '看自身哪个属性', values: ['ATK', 'INT'], default: 'ATK' },
      2: { kind: 'enum', label: '加成来源', values: ['HP', 'MAX_HP'], default: 'HP' },
      3: { kind: 'int', label: '基数', default: '0' },
      4: FIXED('0'),
      5: { kind: 'int', label: '百分比(%)', min: 0, default: '50' },
      6: FIXED('0'), 7: BLANK(), 8: BLANK(), 9: BLANK(),
    },
    chainRateDefault: 10,
    desc(p) {
      const who = p.roleTarget === 'SELF' ? '自身' : '己方全体';
      const what = p.params[1] === 'INT' ? '魔法伤害' : '物理伤害';
      const src = p.params[2] === 'MAX_HP' ? '最大血量' : '目前血量';
      return who + '/' + p.params[0] + '回合/提升{@v}点' + what + '<br>叠加' + src + p.params[5] + '%的威力';
    },
  },
  {
    id: 'defUpPct', opcode: 'DEF_UP_BY_SELF_PARAM', family: 'buffDef', side: 'player',
    name: '提升防御（按自身属性%）',
    allowedTargets: ['SELF', 'FRIEND_ALL'],
    roleTargets: { SELF: 'SELF', FRIEND_ALL: 'FRIEND_ALL' },
    params: {
      0: { kind: 'int', label: '持续回合', min: 1, default: '2' },
      1: { kind: 'enum', label: '看自身哪个属性', values: ['ATK', 'INT'], default: 'ATK' },
      2: { kind: 'enum', label: '加成来源', values: ['HP', 'MAX_HP'], default: 'HP' },
      3: { kind: 'int', label: '基数', default: '0' },
      4: FIXED('0'),
      5: { kind: 'int', label: '百分比(%)', min: 0, default: '50' },
      6: FIXED('0'), 7: BLANK(), 8: BLANK(), 9: BLANK(),
    },
    chainRateDefault: 10,
    desc(p) {
      const who = p.roleTarget === 'SELF' ? '自身' : '己方全体';
      const what = p.params[1] === 'INT' ? '魔法防御' : '物理防御';
      const src = p.params[2] === 'MAX_HP' ? '最大血量' : '目前血量';
      return who + '/' + p.params[0] + '回合/提升{@v}点' + what + '<br>叠加' + src + p.params[5] + '%的威力';
    },
  },
  {
    id: 'atkDownPct', opcode: 'ATK_BREAK_BY_SELF_PARAM', family: 'debuffAtk', side: 'enemy',
    name: '降低敌方伤害（按自身属性%）',
    allowedTargets: ['ENEMY_ONE', 'ENEMY_ALL'],
    roleTargets: { ENEMY_ONE: 'SELECT', ENEMY_ALL: 'ENEMY_ALL' },
    params: {
      0: { kind: 'int', label: '持续回合', min: 1, default: '2' },
      1: { kind: 'enum', label: '看自身哪个属性', values: ['ATK', 'INT'], default: 'ATK' },
      2: { kind: 'enum', label: '加成来源', values: ['HP', 'MAX_HP'], default: 'HP' },
      3: { kind: 'int', label: '基数', default: '0' },
      4: FIXED('0'),
      5: { kind: 'int', label: '百分比(%)', min: 0, default: '50' },
      6: FIXED('0'), 7: BLANK(), 8: BLANK(), 9: BLANK(),
    },
    chainRateDefault: 10,
    desc(p) {
      const who = p.skillTarget === 'ENEMY_ALL' ? '敌全体' : '敌单体';
      const what = p.params[1] === 'INT' ? '魔法伤害' : '物理伤害';
      const src = p.params[2] === 'MAX_HP' ? '最大血量' : '目前血量';
      return who + '/' + p.params[0] + '回合/降低{@v}点' + what + '<br>叠加' + src + p.params[5] + '%的威力';
    },
  },

  // ------------------------------------------------------------------ draw
  {
    id: 'draw', opcode: 'DEAL_BONUS', family: 'draw', side: 'player',
    name: '抽牌',
    note: '★ 属性掩码 9 位必须全 1，留空会静默失效（battle_engine_role_targets.go:6）',
    allowedTargets: ['SELF', 'FRIEND_ALL'],
    roleTargets: { SELF: 'SELF', FRIEND_ALL: 'FRIEND_ALL' },
    params: {
      0: { kind: 'enum', label: '抽几张', values: ['1', '2', '3', '4'], default: '2' },
      1: BLANK(), 2: BLANK(), 3: BLANK(), 4: BLANK(), 5: BLANK(), 6: BLANK(), 7: BLANK(), 8: BLANK(), 9: BLANK(),
    },
    chainRateDefault: 0,
    desc(p) {
      const who = p.roleTarget === 'SELF' ? '自身' : '己方全体';
      return who + '/抽牌+' + p.params[0];
    },
  },
  {
    id: 'drawPenalty', opcode: 'DEAL_PENALTY', family: 'draw', side: 'player',
    name: '减少抽牌',
    allowedTargets: ['SELF', 'FRIEND_ALL'],
    roleTargets: { SELF: 'SELF', FRIEND_ALL: 'FRIEND_ALL' },
    params: {
      0: { kind: 'enum', label: '少抽几张', values: ['1', '2', '3'], default: '1' },
      1: BLANK(), 2: BLANK(), 3: BLANK(), 4: BLANK(), 5: BLANK(), 6: BLANK(), 7: BLANK(), 8: BLANK(), 9: BLANK(),
    },
    chainRateDefault: 0,
    desc(p) {
      const who = p.roleTarget === 'SELF' ? '自身' : '己方全体';
      return who + '/抽牌-' + p.params[0];
    },
  },

  // ------------------------------------------------------------------ 圣剑解放（爆发槽）
  {
    id: 'burstUp', opcode: 'BURST_GAUGE_QUICK_UP', family: 'buffPct', side: 'player',
    name: '圣剑解放增加（爆发槽）',
    note: '官方最常见的效果之一；数值就是百分比，说明里引用本块第 1 个参数',
    allowedTargets: ['SELF', 'FRIEND_ALL'],
    roleTargets: { SELF: 'SELF', FRIEND_ALL: 'FRIEND_ALL' },
    params: {
      0: { kind: 'int', label: '增加量(%)', min: 0, default: '20' },
      1: { kind: 'int', label: '每级增加(%)', min: 0, default: '0' },
      2: BLANK(), 3: BLANK(), 4: BLANK(), 5: BLANK(), 6: BLANK(), 7: BLANK(), 8: BLANK(), 9: BLANK(),
    },
    chainRateDefault: 0,
    desc(p) {
      const who = p.roleTarget === 'SELF' ? '自身' : '己方全体';
      return who + '/圣剑解放增加{@v}%';
    },
  },
  // ------------------------------------------------------------------ 持续回复（每回合回血）
  {
    id: 'regen', opcode: 'REGENERATE_FIXED', family: 'heal', side: 'player',
    name: '持续回复（每回合回血）',
    note: '恢复量 = 基础回复 + 每级回复×等级/1000（服务端 fixedRegenerateRoleValue）',
    allowedTargets: ['SELF', 'FRIEND_ALL'],
    roleTargets: { SELF: 'SELF', FRIEND_ALL: 'FRIEND_ALL' },
    params: {
      0: { kind: 'int', label: '持续回合', min: 1, default: '3' },
      1: { kind: 'int', label: '基础回复', min: 0 },
      2: { kind: 'int', label: '每级回复', min: 0 },
      3: { kind: 'int', label: '系数(按属性)', min: 0, default: '0' },
      4: FIXED('0'),
      5: { kind: 'enum', label: '参照属性', values: ['MND', 'MDEF', 'ATK', 'INT', 'MAX_HP'], default: 'MND' },
      6: BLANK(), 7: BLANK(), 8: BLANK(), 9: BLANK(),
    },
    chainRateDefault: 20,
    desc(p) {
      const who = p.roleTarget === 'SELF' ? '自身' : '己方全体';
      // 官方说明多数不写具体数字（数值随属性和等级变），这里也不写，避免和游戏里显示的对不上
      const extra = Number(p.params[3] || 0) > 0 ? '（恢复量按' + (p.params[5] || 'MND') + '计算）' : '';
      return who + '/' + p.params[0] + '回合/每回合恢复血量' + extra;
    },
  },

  // ------------------------------------------------------------------ percent-rate buffs
  {
    id: 'critUp', opcode: 'CRITICAL_UP', family: 'buffPct', side: 'player',
    name: '提升暴击率',
    note: '官方一律把连携倍率留空（不吃连携）',
    allowedTargets: ['SELF', 'FRIEND_ALL'],
    roleTargets: { SELF: 'SELF', FRIEND_ALL: 'FRIEND_ALL' },
    params: {
      0: { kind: 'int', label: '持续回合', min: 1, default: '2' },
      1: { kind: 'int', label: '暴击率(0.1%)', min: 0, default: '300' },
      2: FIXED('0'), 3: BLANK(), 4: BLANK(), 5: BLANK(), 6: BLANK(), 7: BLANK(), 8: BLANK(), 9: BLANK(),
    },
    chainRateDefault: 0,
    desc(p) {
      const who = p.roleTarget === 'SELF' ? '自身' : '己方全体';
      return who + '/' + p.params[0] + '回合/提升' + (Number(p.params[1]) / 10) + '%暴击率';
    },
  },
  {
    id: 'attrDefUp', opcode: 'ATTR_DEF_UP', family: 'buffPct', side: 'player',
    name: '提升属性抗性',
    allowedTargets: ['SELF', 'FRIEND_ALL'],
    roleTargets: { SELF: 'SELF', FRIEND_ALL: 'FRIEND_ALL' },
    params: {
      0: { kind: 'int', label: '持续回合', min: 1, default: '2' },
      1: { kind: 'int', label: '抗性(0.1%)', min: 0, default: '0' },
      2: { kind: 'int', label: '每级(0.1%)', min: 0, default: '0' },
      3: FIXED('0'), 4: FIXED('0'),
      5: { kind: 'enum', label: '哪种属性', values: Object.keys(ATTR_CN) },
      6: BLANK(), 7: BLANK(), 8: BLANK(), 9: BLANK(),
    },
    chainRateDefault: 20,
    desc(p) {
      const who = p.roleTarget === 'SELF' ? '自身' : '己方全体';
      const el = ATTR_CN[p.params[5]] || p.params[5];
      return who + '/' + p.params[0] + '回合/提升{@v}点' + el + '属性抗性';
    },
  },
  {
    id: 'attrDefDown', opcode: 'ATTR_DEF_DOWN', family: 'buffPct', side: 'enemy',
    name: '降低敌方属性抗性',
    allowedTargets: ['ENEMY_ONE', 'ENEMY_ALL'],
    roleTargets: { ENEMY_ONE: 'SELECT', ENEMY_ALL: 'ENEMY_ALL' },
    params: {
      0: { kind: 'int', label: '持续回合', min: 1, default: '2' },
      1: { kind: 'int', label: '抗性(0.1%)', min: 0, default: '0' },
      2: { kind: 'int', label: '每级(0.1%)', min: 0, default: '0' },
      3: FIXED('0'), 4: FIXED('0'),
      5: { kind: 'enum', label: '哪种属性', values: Object.keys(ATTR_CN) },
      6: BLANK(), 7: BLANK(), 8: BLANK(), 9: BLANK(),
    },
    chainRateDefault: 20,
    desc(p) {
      const who = p.skillTarget === 'ENEMY_ALL' ? '敌全体' : '敌单体';
      const el = ATTR_CN[p.params[5]] || p.params[5];
      return who + '/' + p.params[0] + '回合/降低{@v}点' + el + '属性抗性';
    },
  },

  // ------------------------------------------------------------------ cover / taunt
  {
    id: 'cover', opcode: 'COVERING', family: 'cover', side: 'player',
    name: '嘲讽（把攻击吸引到自己身上）',
    note: 'p0=持续回合，p1=减伤%',
    allowedTargets: ['SELF'],
    roleTargets: { SELF: 'SELF' },
    params: {
      0: { kind: 'int', label: '持续回合', min: 1, default: '1' },
      1: { kind: 'int', label: '减免伤害(%)', min: 0, default: '300' },
      2: FIXED('0'), 3: FIXED('NULL'), 4: FIXED('ALL'),
      5: BLANK(), 6: BLANK(), 7: BLANK(), 8: BLANK(), 9: BLANK(),
    },
    chainRateDefault: 0,
    desc(p) {
      const red = Math.round(Number(p.params[1]) / 10);
      return '自身/' + p.params[0] + '回合/攻击向自身集中，减免' + red + '%伤害';
    },
  },

  // ------------------------------------------------------------------ DOT
  {
    id: 'burn', opcode: 'BURN', family: 'dot', side: 'enemy',
    name: '燃烧（持续伤害）',
    allowedTargets: ['ENEMY_ONE', 'ENEMY_ALL'],
    roleTargets: { ENEMY_ONE: 'SELECT', ENEMY_ALL: 'ENEMY_ALL' },
    params: {
      0: { kind: 'int', label: '持续回合', min: 1, default: '3' },
      1: { kind: 'int', label: '基准', default: '100' },
      2: FIXED('0'),
      3: { kind: 'int', label: '基础值', min: 0 },
      4: { kind: 'int', label: '每级值', min: 0 },
      5: { kind: 'int', label: '上限', default: '500' },
      6: FIXED('0'),
      7: { kind: 'enum', label: '参照属性', values: ['INT', 'ATK'], default: 'INT' },
      8: BLANK(), 9: BLANK(),
    },
    chainRateDefault: 20,
    desc(p) {
      const who = p.skillTarget === 'ENEMY_ALL' ? '敌全体' : '敌单体';
      return who + '/' + p.params[0] + '回合/付与{@v}点燃烧持续伤害';
    },
  },

  // ------------------------------------------------------------------ cleave / utility
  {
    id: 'piercing', opcode: 'ATK_OP_PIERCING', family: 'utility', side: 'enemy',
    name: '无视防御',
    note: '必须和「伤害」块一起用；放在伤害块前面。p0=百分比, p1=看物防还是魔防',
    allowedTargets: ['ENEMY_ONE', 'ENEMY_ALL'],
    roleTargets: { ENEMY_ONE: 'SELECT', ENEMY_ALL: 'ENEMY_ALL' },
    params: {
      0: { kind: 'int', label: '无视防御(%)', min: 0, max: 100, default: '50' },
      1: { kind: 'enum', label: '无视哪种防御', values: ['ATK', 'INT'], default: 'ATK' },
      2: BLANK(), 3: BLANK(), 4: BLANK(), 5: BLANK(), 6: BLANK(), 7: BLANK(), 8: BLANK(), 9: BLANK(),
    },
    chainRateDefault: 0,
    desc(p) {
      const what = p.params[1] === 'INT' ? '魔法防御' : '物理防御';
      return '无视' + p.params[0] + '%' + what;
    },
  },
  {
    id: 'drain', opcode: 'ATK_OP_DRAIN', family: 'utility', side: 'self',
    name: '吸血（按造成伤害回复）',
    note: '和「伤害」块一起用',
    allowedTargets: ['SELF'],
    roleTargets: { SELF: 'SELF' },
    params: {
      0: { kind: 'int', label: '回复伤害的(%)', min: 0, max: 100, default: '30' },
      1: BLANK(), 2: BLANK(), 3: BLANK(), 4: BLANK(), 5: BLANK(), 6: BLANK(), 7: BLANK(), 8: BLANK(), 9: BLANK(),
    },
    chainRateDefault: 0,
    desc(p) { return '按造成伤害的' + p.params[0] + '%回复自身血量'; },
  },
  {
    id: 'damageUp', opcode: 'DAMAGE_UP', family: 'utility', side: 'self',
    name: '提升全伤害',
    allowedTargets: ['SELF', 'FRIEND_ALL'],
    roleTargets: { SELF: 'SELF', FRIEND_ALL: 'FRIEND_ALL' },
    params: {
      0: { kind: 'int', label: '持续回合', min: 1, default: '2' },
      1: { kind: 'int', label: '提升(%)', min: 0, default: '20' },
      2: BLANK(), 3: BLANK(), 4: BLANK(), 5: BLANK(), 6: BLANK(), 7: BLANK(), 8: BLANK(), 9: BLANK(),
    },
    chainRateDefault: 0,
    desc(p) {
      const who = p.roleTarget === 'SELF' ? '自身' : '己方全体';
      return who + '/' + p.params[0] + '回合/提升' + p.params[1] + '%全伤害';
    },
  },
  {
    id: 'buffRelease', opcode: 'BUFF_RELEASE', family: 'utility', side: 'self',
    name: '解除敌方强化',
    allowedTargets: ['ENEMY_ONE', 'ENEMY_ALL'],
    roleTargets: { ENEMY_ONE: 'SELECT', ENEMY_ALL: 'ENEMY_ALL' },
    params: {
      0: { kind: 'int', label: '解除个数', min: 1, default: '1' },
      1: BLANK(), 2: BLANK(), 3: BLANK(), 4: BLANK(), 5: BLANK(), 6: BLANK(), 7: BLANK(), 8: BLANK(), 9: BLANK(),
    },
    chainRateDefault: 0,
    desc(p) { return '解除敌方全部强化状态'; },
  },
  {
    id: 'debuffRelease', opcode: 'DEBUFF_RELEASE', family: 'utility', side: 'player',
    name: '解除我方弱化',
    allowedTargets: ['SELF', 'FRIEND_ALL'],
    roleTargets: { SELF: 'SELF', FRIEND_ALL: 'FRIEND_ALL' },
    params: {
      0: { kind: 'int', label: '解除个数', min: 1, default: '1' },
      1: BLANK(), 2: BLANK(), 3: BLANK(), 4: BLANK(), 5: BLANK(), 6: BLANK(), 7: BLANK(), 8: BLANK(), 9: BLANK(),
    },
    chainRateDefault: 0,
    desc(p) {
      const who = p.roleTarget === 'SELF' ? '自身' : '己方全体';
      return who + '/解除全部弱化状态';
    },
  },
  {
    id: 'paramLimitBreak', opcode: 'PARAM_LIMIT_BREAK_FIXED', family: 'buffAtk', side: 'player',
    name: '提升伤害上限',
    allowedTargets: ['SELF', 'FRIEND_ALL'],
    roleTargets: { SELF: 'SELF', FRIEND_ALL: 'FRIEND_ALL' },
    params: {
      0: { kind: 'int', label: '持续回合', min: 1, default: '3' },
      1: { kind: 'enum', label: '提升哪种上限', values: ['ATK', 'INT'], default: 'ATK' },
      2: FIXED('1'),
      3: { kind: 'int', label: '基础上限值', min: 0 },
      4: { kind: 'int', label: '每级上限值', min: 0 },
      5: FIXED('0'), 6: BLANK(), 7: BLANK(), 8: BLANK(), 9: BLANK(),
    },
    chainRateDefault: 10,
    desc(p) {
      const who = p.roleTarget === 'SELF' ? '自身' : '己方全体';
      const what = p.params[1] === 'INT' ? '魔法' : '物理';
      return who + '/' + p.params[0] + '回合/' + what + '伤害上限提升{@v}';
    },
  },
  {
    id: 'enchant', opcode: 'ENCHANT', family: 'utility', side: 'player',
    name: '附加属性伤害',
    allowedTargets: ['SELF', 'FRIEND_ALL'],
    roleTargets: { SELF: 'SELF', FRIEND_ALL: 'FRIEND_ALL' },
    params: {
      0: { kind: 'int', label: '持续回合', min: 1, default: '2' },
      1: { kind: 'int', label: '基础值', min: 0 },
      2: { kind: 'enum', label: '倍率', values: ['1000', '1300'], default: '1000' },
      3: FIXED('0'),
      4: { kind: 'int', label: '每级值', min: 0 },
      5: { kind: 'enum', label: '附加属性', values: Object.keys(ATTR_CN) },
      6: BLANK(), 7: BLANK(), 8: BLANK(), 9: BLANK(),
    },
    chainRateDefault: 20,
    desc(p) {
      const who = p.roleTarget === 'SELF' ? '自身' : '己方全体';
      const el = ATTR_CN[p.params[5]] || p.params[5];
      return who + '/' + p.params[0] + '回合/付与{@v}点' + el + '属性追加伤害';
    },
  },
  {
    id: 'tranceUp', opcode: 'TRANCE_GAUGE_VALUE_UP', family: 'utility', side: 'player',
    name: '提升TRANCE槽',
    allowedTargets: ['SELF', 'FRIEND_ALL'],
    roleTargets: { SELF: 'SELF', FRIEND_ALL: 'FRIEND_ALL' },
    params: {
      0: { kind: 'int', label: '提升量', min: 0, default: '10' },
      1: BLANK(), 2: BLANK(), 3: BLANK(), 4: BLANK(), 5: BLANK(), 6: BLANK(), 7: BLANK(), 8: BLANK(), 9: BLANK(),
    },
    chainRateDefault: 0,
    desc(p) {
      const who = p.roleTarget === 'SELF' ? '自身' : '己方全体';
      return who + '/TRANCE槽提升' + p.params[0];
    },
  },
];

const byId = new Map(EFFECTS.map(e => [e.id, e]));
const byOpcode = new Map(EFFECTS.map(e => [e.opcode, e]));

/** Descriptions for the target prefix, matching official wording. */
const TARGET_CN = { ENEMY_ONE: '敌单体', ENEMY_ALL: '敌全体', SELF: '自身', FRIEND_ALL: '己方全体' };

module.exports = { EFFECTS, byId, byOpcode, ATTR_CN, PHYS_CN, KIND_CN, TARGET_CN, artFor };
