'use strict';
/*
 * values.js -- 「游戏里说明文字上的那个数字」 ↔ 「CSV 里的原始参数」 互相换算。
 *
 * 为什么需要它：CSV 里存的是**放大过的原始值**（例如加攻块 p3=3246000 实际是
 * 「+3246 点」），而游戏卡面/说明里显示的是**满级（level_max）算出来的数**。
 * 实测：用户那张卡 Lv1、上限 80，说明里写 `{11}点伤害`，游戏显示 14999 —— 正好等于
 *   p0 + trunc(p1×80/1000) = 9639 + 67000×80/1000。
 * 所以工具里应该直接让人填「Lv1 值 / 满级值」这种人话数字，由本模块反解回原始参数。
 *
 * 公式全部照抄服务端（internal/multiplayer/battle_engine_math.go）：
 *   ATTACK_AA / HEAL_FIXED     固定部分 = p0 + p1×等级/1000        （attackRolePower:107 / fixedHealRoleValue:19）
 *   REGENERATE_FIXED / DOT     固定部分 = p1 + p2×等级/1000        （fixedRegenerateRoleValue:93）
 *   固定值增益/减益            值       = ((p3 + p4×等级)×p2)/1000 + p5×等级  （fixedBuffRoleSegments:198）
 * 客户端卡面说明显示的就是这里的「固定部分」（倍率×自身属性的那部分另算，跟说明文字无关）。
 */

const i = (v) => { const n = parseInt(String(v === undefined || v === null ? '0' : v).trim(), 10); return Number.isFinite(n) ? n : 0; };
const trunc = Math.trunc;

/** 各效果的「数值类型」与它用到的参数位置。 */
const VALUE_SHAPE = {
  attack: { kind: 'pair', base: 0, grow: 1 },                 // p0 + p1×L/1000
  heal: { kind: 'pair', base: 0, grow: 1 },                   // 同上（固定部分）
  burn: { kind: 'pair', base: 1, grow: 2 },                   // p1 + p2×L/1000（DOT 族）
  regen: { kind: 'pair', base: 1, grow: 2 },                  // 持续回复：同样是 p1 + p2×L/1000
  burstUp: { kind: 'pairLinear', base: 0, grow: 1 },          // 圣剑解放：p0 + p1×等级（不除 1000）
  atkUp: { kind: 'fixedBuff', base: 3, grow: 4, scale: 2, extra: 5 },
  defUp: { kind: 'fixedBuff', base: 3, grow: 4, scale: 2, extra: 5 },
  atkDown: { kind: 'fixedBuff', base: 3, grow: 4, scale: 2, extra: 5 },
  defDown: { kind: 'fixedBuff', base: 3, grow: 4, scale: 2, extra: 5 },
  paramLimitBreak: { kind: 'fixedBuff', base: 3, grow: 4, scale: 2, extra: 5 },
  // 下面这些在游戏里显示的是「百分比 / 张数 / 回合」，不随卡等级线性成长
  draw: { kind: 'count', at: 0 },
  drawPenalty: { kind: 'count', at: 0 },
  buffRelease: { kind: 'count', at: 0 },
  debuffRelease: { kind: 'count', at: 0 },
  atkUpPct: { kind: 'percent', at: 5 },
  defUpPct: { kind: 'percent', at: 5 },
  atkDownPct: { kind: 'percent', at: 5 },
};

function shapeOf(effectId) { return VALUE_SHAPE[effectId] || { kind: 'raw' }; }

/** 游戏说明里显示的数字（level 传 level_max 就是「满级值」）。 */
function valueAt(effectId, params, level) {
  const s = shapeOf(effectId);
  const p = (k) => i(params && params[k]);
  switch (s.kind) {
    case 'pair': return p(s.base) + trunc(p(s.grow) * level / 1000);
    case 'pairLinear': return p(s.base) + p(s.grow) * level;
    case 'fixedBuff': return trunc((p(s.base) + p(s.grow) * level) * p(s.scale) / 1000) + trunc(p(s.extra) * level * 100 / 100);
    case 'count': return p(s.at);
    case 'percent': return p(s.at);
    default: return null;                       // raw：没有单一「数值」，别乱显示
  }
}

/**
 * 由「Lv1 值 + 满级值」反解原始参数。
 * 返回 { params, achieved:{lv1,lvmax}, ok }；ok=false 表示四舍五入后跟目标差超过 1。
 */
function solveFromValues(effectId, v1, vmax, levelMax, templateParams) {
  const s = shapeOf(effectId);
  const out = Object.assign({}, templateParams || {});
  const put = (idx, v) => { out[idx] = String(v); };
  const L = Math.max(2, i(levelMax) || 1);
  let grow, base;
  if (s.kind === 'pair') {
    // value(L) = base + trunc(grow×L/1000)
    grow = Math.round((vmax - v1) * 1000 / (L - 1));
    base = v1 - trunc(grow / 1000);
    put(s.grow, grow); put(s.base, base);
  } else if (s.kind === 'pairLinear') {
    // value(L) = base + grow×L
    grow = Math.round((vmax - v1) / (L - 1));
    base = v1 - grow;
    put(s.grow, grow); put(s.base, base);
  } else if (s.kind === 'fixedBuff') {
    // value(L) = trunc((base + grow×L) × scale / 1000) + extra×L
    const scale = i(out[s.scale]) || 1;
    const extra = i(out[s.extra]);
    const target1 = v1 - extra * 1;
    const targetM = vmax - extra * L;
    grow = Math.round((targetM - target1) * 1000 / ((L - 1) * scale));
    // 让 Lv1 精确落在 v1 上：base + grow 的目标是 target1×1000/scale
    base = Math.round(target1 * 1000 / scale) - grow;
    put(s.grow, grow); put(s.base, base);
  } else if (s.kind === 'count' || s.kind === 'percent') {
    put(s.at, String(v1));                      // 不随等级变化：两个框应当填一样的数
    grow = 0; base = v1;
  } else {
    return { params: out, achieved: null, ok: false, reason: '这个效果没有「数值」可换算' };
  }
  const achieved = { lv1: valueAt(effectId, out, 1), lvmax: valueAt(effectId, out, L) };
  const ok = Math.abs(achieved.lv1 - v1) <= 1 && Math.abs(achieved.lvmax - vmax) <= 1;
  return { params: out, achieved, ok, raw: { base, grow } };
}

/** 给界面看的一句话：'Lv1 1959 → 满级 2859'（raw 为 null 时返回空）。 */
function describe(effectId, params, levelMax) {
  const v1 = valueAt(effectId, params, 1);
  const vm = valueAt(effectId, params, Math.max(1, i(levelMax)));
  if (v1 === null || vm === null) return '';
  return 'Lv1 ' + v1 + ' → 满级 ' + vm;
}

module.exports = { VALUE_SHAPE, shapeOf, valueAt, solveFromValues, describe };
