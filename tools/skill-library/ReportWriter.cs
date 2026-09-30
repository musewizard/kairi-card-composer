using System.Text;

namespace SkillLibrary;

public static class ReportWriter
{
    public static void Write(
        string path,
        Catalog catalog,
        IReadOnlyList<Program.OpcodeView> ordered,
        IReadOnlyDictionary<string, Program.OpcodeView> all,
        string generatedUtc)
    {
        var sb = new StringBuilder(512 * 1024);
        var unregistered = ordered.Where(x => !x.Registered).ToList();
        var usedUnregistered = unregistered.Where(x => x.CardsUsingOpcode.Count > 0).ToList();
        var unusedUnregistered = unregistered.Where(x => x.CardsUsingOpcode.Count == 0).ToList();
        var missing = RegisteredOpcodes.Names.Where(n => !all.ContainsKey(n)).OrderBy(n => n, StringComparer.Ordinal).ToList();
        var totalExamplesAll = ordered.Sum(o => o.AllExamples.Count);
        var totalExamplesEmitted = ordered.Sum(o => Math.Min(o.AllExamples.Count, 60));

        sb.AppendLine("# 技能积木库 (skill library) — 角色块 / 操作码报告");
        sb.AppendLine();
        sb.AppendLine($"- generated_utc: `{generatedUtc}`");
        sb.AppendLine($"- 服务端白名单操作码数量: **{RegisteredOpcodes.Names.Length}**");
        sb.AppendLine($"- 数据中出现的操作码总数: **{ordered.Count}**");
        sb.AppendLine($"- 未注册操作码数量: **{unregistered.Count}**");
        sb.AppendLine($"- `skill_player.csv` 数据行: **{catalog.SkillRows}**");
        sb.AppendLine($"- `skill_role_player.csv` 数据行: **{catalog.RoleRows}**");
        sb.AppendLine($"- 角色集 (distinct FunctionID) 数量: **{catalog.RolesByFunction.Count}**");
        sb.AppendLine($"- 单个角色集最大角色块数: **{catalog.MaxRolesPerFunction}**");
        sb.AppendLine($"- `card.csv` 数据行: **{catalog.CardRows}**");
        sb.AppendLine($"- `skill_role_param_rule.csv` 功能行: **{catalog.ParamRuleRows}**");
        sb.AppendLine($"- 全部不同参数组总数: **{totalExamplesAll}**（写入 JSON 的上限 60/opcode 后为 **{totalExamplesEmitted}**）");
        sb.AppendLine();

        // ---------------- summary table -----------------------------------------
        sb.AppendLine("## 1. 操作码一览表");
        sb.AppendLine();
        sb.AppendLine("| # | 操作码 | 注册 | 真实出现次数 | 不同参数组数 | 参数组数上限 | 参数类型契约 | 源技能数 | 使用该操作码的卡数 |");
        sb.AppendLine("|---:|---|---|---:|---:|---:|---|---:|---:|");
        var rank = 0;
        foreach (var op in ordered)
        {
            rank++;
            sb.AppendLine($"| {rank} | `{op.Name}` | {(op.Registered ? "✅" : "❌")} | {op.RoleOccurrences} | {op.DistinctParamSets.Count} | {op.MaxRolesPerSet} | `{Contract(op)}` | {op.SkillIds.Count} | {op.CardsUsingOpcode.Count} |");
        }
        sb.AppendLine();

        // ---------------- per-opcode details ------------------------------------
        sb.AppendLine("## 2. 每个操作码的细节");
        sb.AppendLine();
        foreach (var op in ordered)
        {
            var targets = op.Targets.Count == 0
                ? "(无)"
                : string.Join(", ", op.Targets.OrderBy(x => x, StringComparer.Ordinal).Select(x => x.Length == 0 ? "(空)" : "`" + x + "`"));
            sb.AppendLine($"### `{op.Name}`");
            sb.AppendLine();
            sb.AppendLine($"- 注册状态: {(op.Registered ? "✅ 已注册 (服务端白名单)" : "❌ **未注册**")}");
            sb.AppendLine($"- 真实出现次数 (角色块行数): **{op.RoleOccurrences}**");
            sb.AppendLine($"- 不同参数组数 (opcode+target+attributes+10 params+chain_rate+hate_limit): **{op.DistinctParamSets.Count}**");
            sb.AppendLine($"- 参数组数上限 (含该操作码的 FunctionID 中最大角色块数): **{op.MaxRolesPerSet}**");
            sb.AppendLine($"- 真实使用过的 target 值集合 ({op.Targets.Count}): {targets}");
            sb.AppendLine($"- 参数类型契约: `{Contract(op)}`");
            sb.AppendLine($"- 关联 FunctionID 数: {op.FunctionIds.Count} / 引用该操作码的技能数: {op.SkillIds.Count}");
            sb.AppendLine($"- 使用该操作码的卡牌数: {op.CardsUsingOpcode.Count}" +
                          (op.CardsUsingOpcode.Count > 0
                              ? $" (示例: {string.Join(", ", op.CardsUsingOpcode.OrderBy(x => x).Take(5))})"
                              : string.Empty));
            sb.AppendLine();

            if (op.AllExamples.Count == 0)
            {
                sb.AppendLine("_没有角色块实例（仅存在于参数规则表或白名单中）。_");
                sb.AppendLine();
                continue;
            }
            sb.AppendLine($"最有代表性的 3 个例子（按出现次数降序；该操作码共 {op.AllExamples.Count} 个不同参数组）:");
            sb.AppendLine();
            sb.AppendLine("| # | 出现次数 | target | attrs | params[1..10] | chain | hate | 来源技能 | 来源 FunctionID | 样本卡 |");
            sb.AppendLine("|---:|---:|---|---|---|---:|---:|---|---|---|");
            for (var i = 0; i < op.TopExamples.Count; i++)
            {
                var ex = op.TopExamples[i];
                var skillLabel = ex.SkillId == 0
                    ? "(无对应技能行)"
                    : $"{Escape(ex.SkillName)}" + (ex.SkillSubName.Length == 0 ? string.Empty : $" / {Escape(ex.SkillSubName)}") + $" (#{ex.SkillId})";
                var cards = ex.SampleCardIds.Count == 0 ? "-" : string.Join(", ", ex.SampleCardIds);
                sb.AppendLine($"| {i + 1} | {ex.Occurrences} | `{ex.Target}` | `{ex.Attributes}` | {Params(ex.Parameters)} | {ex.ChainRate} | {ex.HateLimit} | {skillLabel} | {ex.FunctionId} | {cards} |");
            }
            sb.AppendLine();
        }

        // ---------------- anomalies ---------------------------------------------
        sb.AppendLine("## 3. 未注册操作码 / 数据异常");
        sb.AppendLine();
        sb.AppendLine($"数据中出现的未注册操作码共 **{unregistered.Count}** 个。");
        sb.AppendLine();
        sb.AppendLine($"### 3.1 被现有卡牌使用的未注册操作码 ({usedUnregistered.Count}) — 数据异常");
        sb.AppendLine();
        if (usedUnregistered.Count == 0)
        {
            sb.AppendLine("无。所有被卡牌使用的操作码都在服务端白名单内。");
        }
        else
        {
            sb.AppendLine("| 操作码 | 角色块出现次数 | 引用技能数 | 涉及卡数 | 样本卡 |");
            sb.AppendLine("|---|---:|---:|---:|---|");
            foreach (var op in usedUnregistered)
            {
                sb.AppendLine($"| `{op.Name}` | {op.RoleOccurrences} | {op.SkillIds.Count} | {op.CardsUsingOpcode.Count} | {string.Join(", ", op.CardsUsingOpcode.OrderBy(x => x).Take(5))} |");
            }
        }
        sb.AppendLine();
        sb.AppendLine($"### 3.2 未出现在任何卡牌上的未注册操作码 ({unusedUnregistered.Count})");
        sb.AppendLine();
        if (unusedUnregistered.Count == 0)
        {
            sb.AppendLine("无。");
        }
        else
        {
            sb.AppendLine("| 操作码 | 角色块出现次数 | 引用技能数 |");
            sb.AppendLine("|---|---:|---:|");
            foreach (var op in unusedUnregistered)
            {
                sb.AppendLine($"| `{op.Name}` | {op.RoleOccurrences} | {op.SkillIds.Count} |");
            }
        }
        sb.AppendLine();

        sb.AppendLine("## 4. 白名单里但数据中从未出现的操作码");
        sb.AppendLine();
        sb.AppendLine($"共 **{missing.Count}** 个。");
        sb.AppendLine();
        if (missing.Count > 0)
        {
            foreach (var name in missing) sb.AppendLine($"- `{name}`");
        }
        else
        {
            sb.AppendLine("无。白名单里的 69 个操作码都在数据中出现过。");
        }
        sb.AppendLine();

        File.WriteAllText(path, sb.ToString(), new UTF8Encoding(false));
    }

    private static string Contract(Program.OpcodeView op)
    {
        if (!op.HasParamRule) return "(无参数规则行)";
        return string.Join(",", op.ParamRuleTypeList);
    }

    private static string Params(IReadOnlyList<string> parameters)
    {
        var parts = new List<string>(10);
        for (var i = 0; i < 10; i++)
        {
            var value = i < parameters.Count ? parameters[i] : string.Empty;
            parts.Add(value.Length == 0 ? "`·`" : "`" + value.Replace("`", "'") + "`");
        }
        return string.Join(" ", parts);
    }

    private static string Escape(string value)
        => value.Replace("|", "\\|").Replace("\r", " ").Replace("\n", " ");
}
