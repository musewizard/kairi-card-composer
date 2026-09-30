'use strict';
/*
 * conventions.js -- 「照官方数据的写法」写每一列。
 *
 * 为什么需要它：造卡工具会把技能的**展示用列**留空，而官方数据里这些列是有值的。
 * 实测（45001 条角色块 / 20408 条技能行）能确定两类问题：
 *
 *   ① 角色块第 5 列（服务端叫 HitPosition，官方写 'TARGET'/'ROOT'）——早期版本把它
 *      写到了**第 7 列**，第 7 列官方是空的（或电影文件名）。客户端按第 5 列定位打击特效。
 *   ② 角色块第 31 列（HateLimit）：官方攻击块写 10000、增益块留空；早期版本一律写
 *      1000000，等于把所有块的仇恨上限都拉满。
 *   ③ 技能行第 4/5/7/9/15/16/17/18 列（DisplayRole / 效果分类 / RANK / HateRatio…）
 *      官方都有值，工具全留空。其中 RANK 与「卡组技能点」体系有关，客户端要用。
 *
 * 这里不靠猜：所有取值都是**从当前包里统计出来的众数**（mode），按
 *   角色块: 按 opcode 分组
 *   技能行: 按 kind / (kind,RANK) / (稀有度,技能位) 分组
 * 所以换包、换版本以后自动跟着官方数据走。
 */

function tallyMode(pairs) {
  const m = new Map();
  for (const v of pairs) m.set(v, (m.get(v) || 0) + 1);
  let best = '', bestN = -1;
  for (const [v, n] of m.entries()) if (n > bestN) { best = v; bestN = n; }
  return best;
}
/** 众数，但空串只在「空串本来就是多数」时才胜出（用于 HitPosition：优先非空）。 */
function tallyModeNonEmpty(pairs) {
  const nonEmpty = pairs.filter(v => v !== '');
  return nonEmpty.length ? tallyMode(nonEmpty) : '';
}

const RANKS = ['RANK1', 'RANK2', 'RANK3', 'RANK4', 'RANK5'];

/**
 * 从包里统计官方写法。只看「官方行」：技能 id 不以 99 开头的行（99xxxxxx 是导入卡，
 * 也是各种 MOD 卡所在的区段），这样工具自己造过的卡不会污染众数。
 */
function build(pkg) {
  const roles = pkg.roles.dataRows();
  const skills = pkg.skills.dataRows();

  // ---- 角色块：按 opcode 统计「展示列」的官方写法
  const roleByOp = new Map();
  for (const r of roles) {
    const op = r[8];
    if (!op) continue;
    if (/^99/.test(r[0])) continue;
    if (!roleByOp.has(op)) roleByOp.set(op, { col4: [], col5: [], col7: [], col30: [], col31: [] });
    const b = roleByOp.get(op);
    b.col4.push(r[4] || '');
    b.col5.push(r[5] || '');
    b.col7.push(r[7] || '');
    b.col30.push(r[30] || '');
    b.col31.push(r[31] || '');
  }
  const rolePres = {};
  for (const [op, b] of roleByOp.entries()) {
    rolePres[op] = {
      // 用「包含空串」的众数：官方最常见的那一种写法就是我们要抄的
      hitEffect: tallyMode(b.col4),
      hitPosition: tallyMode(b.col5),
      col7: tallyMode(b.col7),
      chainRate: tallyMode(b.col30),
      hateLimit: tallyMode(b.col31),
    };
  }

  // ---- 技能行：官方行（id 不以 99 开头）
  const off = skills.filter(s => !/^99/.test(s[0]));
  const skillPres = {
    col4: tallyMode(off.map(s => s[4] || '')),
    col5: tallyMode(off.map(s => s[5] || '')),
    col9: tallyMode(off.map(s => s[9] || '')),
    col18: tallyMode(off.map(s => s[18] || '')),
  };
  // 效果分类(col7) 按 kind
  const byKind = new Map();
  for (const s of off) {
    const k = s[10] || '';
    if (!byKind.has(k)) byKind.set(k, []);
    byKind.get(k).push(s[7] || '');
  }
  const catByKind = {};
  for (const [k, arr] of byKind.entries()) catByKind[k] = tallyMode(arr);
  // (kind, RANK) → col15/col16
  const codeByKindRank = {};
  for (const s of off) {
    const key = (s[10] || '') + '|' + (s[17] || '');
    if (!codeByKindRank[key]) codeByKindRank[key] = { c15: [], c16: [] };
    codeByKindRank[key].c15.push(s[15] || '');
    codeByKindRank[key].c16.push(s[16] || '');
  }
  const code = {};
  for (const [k, v] of Object.entries(codeByKindRank)) code[k] = { col15: tallyMode(v.c15), col16: tallyMode(v.c16) };

  // ---- (稀有度, 技能位) → RANK：官方规律（通常技 / 覚醒技）
  //   实测：MR/EXR 通常=RANK3 覚醒=RANK5；UR 通常=RANK2 覚醒=RANK4；
  //        SR 通常=RANK2 覚醒=RANK3；N/HN/R 都是 RANK1。这里从数据里直接统计。
  const rankByRaritySlot = {};
  for (const c of pkg.cards.dataRows()) {
    if (/^99/.test(c[0])) continue;
    const tpl = pkg.tplById.get(Number(c[0]));
    if (!tpl) continue;
    for (const [col, slot] of [[26, 'normal'], [27, 'arthur']]) {
      const s = skills.find(x => x[0] === (c[col] || '').trim());
      if (!s) continue;
      const key = tpl.rarity_rank + '|' + slot;
      if (!rankByRaritySlot[key]) rankByRaritySlot[key] = [];
      rankByRaritySlot[key].push(s[17] || '');
    }
  }
  const rankTable = {};
  for (const [k, arr] of Object.entries(rankByRaritySlot)) rankTable[k] = tallyMode(arr);

  // ---- 说明里的 {N} 指向「块内第几个参数」：官方实测 18610/20918 指向 p0（第 1 个）。
  //   客户端把「这个效果的数值」挂在每块的第一个参数上，所以说明必须引用它，
  //   引用别的列会显示成原始数字（例如 ATK_UP_FIXED 的 p3=3246000 会变成一串乱码）。
  //   这里按 opcode 统计官方实际引用的列，作为每种效果的显示参数。
  const rolesByFunc = new Map();
  for (const r of roles) {
    if (!rolesByFunc.has(r[0])) rolesByFunc.set(r[0], []);
    rolesByFunc.get(r[0]).push(r);
  }
  const dispByOp = new Map();
  for (const s of off) {
    const desc = String(s[3] || '');
    if (desc.indexOf('{') < 0) continue;
    const rr = rolesByFunc.get(String(s[49] || s[0])) || [];
    for (const mm of desc.matchAll(/\{(\d+)\}/g)) {
      const idx = Number(mm[1]) - 1;
      const block = Math.floor(idx / 10);
      const prm = idx % 10;
      const op = rr[block] && rr[block][8];
      if (!op) continue;
      if (!dispByOp.has(op)) dispByOp.set(op, []);
      dispByOp.get(op).push(String(prm));
    }
  }
  const displayParam = {};
  for (const [op, arr] of dispByOp.entries()) displayParam[op] = Number(tallyMode(arr));

  return {
    rolePres, skillPres, catByKind, code, rankTable, displayParam,
    /** 角色块展示列（找不到就返回空串，等于跟以前一样） */
    role(opcode) { return rolePres[opcode] || { hitEffect: '', hitPosition: '', col7: '', chainRate: '', hateLimit: '' }; },
    skillCat(kind) { return catByKind[kind] || ''; },
    skillCode(kind, rank) { return code[kind + '|' + rank] || { col15: '', col16: '' }; },
    /** 说明里的数值应该引用块内第几个参数（官方众数；没有数据时默认 0）。 */
    displayParamOf(opcode) {
      return Object.prototype.hasOwnProperty.call(displayParam, opcode) ? displayParam[opcode] : 0;
    },
    /**
     * ★★ 第 5 列 DisplayRole = 「卡面上显示哪一个块的数值」（1 基）。
     * 服务端 battle_engine_display_power.go:36 就是用它取 `roles[DisplayRole-1]` 算卡面数字，
     * 取不到就返回 0 —— 客户端就会显示 0000000。
     * 官方规律（实测 7746 个技能）：**有伤害块就指向第一个 ATTACK_AA，没有就指向第 1 块**。
     * 例：块序 [ATK_OP_PIERCING, ATTACK_AA] → DisplayRole=2（col4=11）。
     */
    displayRoleOf(roleRows) {
      const idx = (roleRows || []).findIndex(r => r && r[8] === 'ATTACK_AA');
      return idx >= 0 ? idx + 1 : 1;
    },
    /** 第 4 列 = (DisplayRole-1)*10 + 1（官方实测：1/11/21/31/41）。 */
    col4ForDisplayRole(dr) { return String((Number(dr) - 1) * 10 + 1); },
    /** 稀有度 + 技能位 → RANK。数据里没有就按稀有度推。 */
    rank(rarity, slot) {
      const direct = rankTable[Number(rarity) + '|' + slot];
      if (direct) return direct;
      const base = Number(rarity) >= 6 ? 3 : (Number(rarity) >= 4 ? 2 : 1);
      const idx = Math.min(RANKS.length - 1, (base - 1) + (slot === 'arthur' ? 2 : 0));
      return RANKS[idx];
    },
  };
}

const cache = new WeakMap();
/** 每个包只统计一次（统计 6 万行，别在预览里反复算）。 */
function forPackage(pkg) {
  if (!cache.has(pkg)) cache.set(pkg, build(pkg));
  return cache.get(pkg);
}

module.exports = { build, forPackage, RANKS };
