namespace SkillLibrary;

/// <summary>
/// Loads the CN602 battle master tables. Column layouts mirror the Go server's
/// parseCombatSkill / parseCombatSkillRole / readCombatParameterRules / parseCombatCard.
/// </summary>
public static class CatalogLoader
{
    /// <summary>Cards below this id are rarity placeholder stubs, not real card references.</summary>
    public const int RealCardMinId = 1_000_000;

    public static Catalog Load(string packageRoot, Action<string>? log = null)
    {
        void Say(string message) => log?.Invoke(message);

        var catalog = new Catalog();
        var battleMaster = Path.Combine(packageRoot, "resource-set", "_local", "control", "server", "cn602-battle-master");
        var cardMaster = Path.Combine(packageRoot, "resource-set", "_local", "control", "server", "cn602-card-master");

        var skillPlayerPath = Path.Combine(battleMaster, "skill_player.csv");
        var skillRolePlayerPath = Path.Combine(battleMaster, "skill_role_player.csv");
        var paramRulePath = Path.Combine(battleMaster, "skill_role_param_rule.csv");
        var cardPath = Path.Combine(cardMaster, "card.csv");

        foreach (var path in new[] { skillPlayerPath, skillRolePlayerPath, paramRulePath, cardPath })
        {
            if (!File.Exists(path)) throw new FileNotFoundException($"required master table missing: {path}", path);
        }

        // ---- skill_player.csv -------------------------------------------------
        foreach (var row in Csv.Read(skillPlayerPath))
        {
            if (Csv.IsCommentOrHeader(row)) continue;
            if (!IsDecimal(Csv.Trimmed(row, 0))) continue;
            var skill = new SkillDefinition
            {
                Id = Csv.IntOrZero(row, 0),
                Name = Csv.Field(row, 1),
                SubName = Csv.Field(row, 2),
                Description = Csv.Field(row, 3),
                DisplayParamNumber = Csv.IntOrZero(row, 4),
                DisplayRole = Csv.IntOrZero(row, 5),
                DisplayMultiplier = Csv.IntOrZero(row, 6),
                DisplayType = Csv.Field(row, 7),
                Kind = Csv.Field(row, 10),
                Attribute = Csv.Field(row, 11),
                Job = Csv.Field(row, 12),
                DamageKind = Csv.Field(row, 13),
                Cost = Csv.IntOrZero(row, 14),
                PriorityPve = Csv.IntOrZero(row, 15),
                Rank = Csv.Field(row, 17),
                HateRatio = Csv.IntOrZero(row, 18),
                Target = Csv.Field(row, 19),
                HandSelectCount = Csv.IntOrZero(row, 20),
                HandAttribute = Csv.Field(row, 21),
                HandKind = Csv.Field(row, 22),
                HandMinCost = Csv.IntOrZero(row, 23),
                HandMaxCost = Csv.IntOrZero(row, 24),
                FunctionId = Csv.IntOrZero(row, 49),
            };
            // Faithful reproduction of parseCombatSkill's fallback.
            if (skill.FunctionId == 0) skill.FunctionId = skill.Id;
            catalog.Skills.Add(skill);
            catalog.SkillRows++;
        }

        // ---- skill_role_player.csv -------------------------------------------
        foreach (var row in Csv.Read(skillRolePlayerPath))
        {
            if (Csv.IsCommentOrHeader(row)) continue;
            if (!IsDecimal(Csv.Trimmed(row, 0))) continue;
            var functionId = Csv.IntOrZero(row, 0);
            if (!catalog.RolesByFunction.TryGetValue(functionId, out var list))
            {
                list = new List<SkillRole>();
                catalog.RolesByFunction[functionId] = list;
            }
            var role = new SkillRole
            {
                FunctionId = functionId,
                RoleIndex = list.Count, // CSV appearance order == execution order
                Opcode = Csv.Trimmed(row, 8),
                Target = Csv.Trimmed(row, 9),
                ChainRate = Csv.IntOrZero(row, 30),
                HateLimit = Csv.IntOrZero(row, 31),
            };
            var mask = new char[9];
            for (var i = 0; i < 9; i++) mask[i] = Csv.IntOrZero(row, 11 + i) > 0 ? '1' : '0';
            role.Attributes = new string(mask);
            for (var i = 0; i < 10; i++) role.Parameters[i] = Csv.Field(row, 20 + i);
            list.Add(role);
            catalog.RoleRows++;
            if (row.Length > catalog.MaxRoleFieldWidth) catalog.MaxRoleFieldWidth = row.Length;
        }

        foreach (var pair in catalog.RolesByFunction)
        {
            if (pair.Value.Count > catalog.MaxRolesPerFunction) catalog.MaxRolesPerFunction = pair.Value.Count;
        }

        // ---- skill_role_param_rule.csv ---------------------------------------
        foreach (var row in Csv.Read(paramRulePath))
        {
            var function = Csv.Trimmed(row, 0).TrimStart('\uFEFF');
            if (function.Length == 0 || function[0] == '#') continue;
            var rule = new ParamRule { Function = function };
            var declared = 0;
            var nonEmpty = 0;
            for (var i = 0; i < 10; i++)
            {
                var type = Csv.Trimmed(row, 3 + i);
                rule.Types[i] = type;
                if (3 + i < row.Length) declared++;
                if (type.Length > 0) nonEmpty++;
            }
            rule.DeclaredTypes = Math.Max(declared, nonEmpty);
            catalog.ParamRules[function] = rule;
            catalog.ParamRuleRows++;
        }

        // ---- card.csv (skill-slot reverse index) ------------------------------
        foreach (var row in Csv.Read(cardPath))
        {
            if (Csv.IsCommentOrHeader(row)) continue;
            if (!IsDecimal(Csv.Trimmed(row, 0))) continue;
            var card = new CardDefinition { Id = Csv.IntOrZero(row, 0) };
            // Cards 1..8 are placeholder rows (rarity-only stubs); real cards start at 10,000,000.
            if (card.Id < RealCardMinId) continue;
            // col26 normal skill, col27 arthur skill, col28..31 support skills,
            // col32 call skill, col33 passive skill (Go parseCombatCard).
            foreach (var index in new[] { 26, 27, 28, 29, 30, 31, 32, 33 })
            {
                var raw = Csv.Trimmed(row, index);
                if (raw.Length == 0 || !IsDecimal(raw)) continue;
                var value = int.Parse(raw, System.Globalization.CultureInfo.InvariantCulture);
                if (value != 0) card.SkillSlots.Add(value);
            }
            if (!catalog.Cards.TryGetValue(card.Id, out var list))
            {
                list = new List<CardDefinition>();
                catalog.Cards[card.Id] = list;
            }
            list.Add(card);
            catalog.CardRows++;
        }

        Say($"skill_player.csv        rows={catalog.SkillRows}");
        Say($"skill_role_player.csv   rows={catalog.RoleRows}  role-sets={catalog.RolesByFunction.Count}  max blocks/set={catalog.MaxRolesPerFunction}  max field width={catalog.MaxRoleFieldWidth}");
        Say($"skill_role_param_rule   rows={catalog.ParamRuleRows}");
        Say($"card.csv                rows={catalog.CardRows} (real cards, id >= {RealCardMinId})");
        return catalog;
    }

    private static bool IsDecimal(string value)
    {
        if (value.Length == 0) return false;
        foreach (var c in value)
        {
            if (c < '0' || c > '9') return false;
        }
        return true;
    }
}
