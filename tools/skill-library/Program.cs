using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace SkillLibrary;

public static class Program
{
    private const int MaxExamplesPerOpcode = 60;
    private const int MaxSampleCardIds = 5;

    public sealed class ExampleView
    {
        public string[] Parameters = new string[10];
        public string Target = "";
        public string Attributes = "";
        public int ChainRate;
        public int HateLimit;
        public int FunctionId;
        public int SkillId;
        public string SkillName = "";
        public string SkillSubName = "";
        public int Occurrences;
        public List<int> SampleCardIds = new();
    }

    public sealed class OpcodeView
    {
        public string Name = "";
        public bool Registered;
        public bool HasParamRule;
        public string[] ParamRuleTypeList = new string[10];
        public int RoleOccurrences;
        public readonly HashSet<string> DistinctParamSets = new(StringComparer.Ordinal);
        public readonly HashSet<string> Targets = new(StringComparer.Ordinal);
        public readonly HashSet<int> FunctionIds = new();
        public readonly HashSet<int> SkillIds = new();
        public readonly HashSet<int> CardsUsingOpcode = new();
        public int MaxRolesPerSet;
        public readonly List<ExampleView> AllExamples = new();
        public List<ExampleView> TopExamples = new();
    }

    private sealed class ExampleGroup
    {
        public string[] Parameters = new string[10];
        public string Target = "";
        public string Attributes = "";
        public int ChainRate;
        public int HateLimit;
        public readonly HashSet<int> FunctionIds = new();
        public readonly HashSet<int> SkillIds = new();
        public readonly List<int> SampleCardIds = new();
        public int Occurrences => SkillIds.Count;
    }

    public static int Main(string[] rawArgs)
    {
        var args = rawArgs.Where(a => a.Length > 0).ToArray();
        if (args.Length == 0 || args[0] is "-h" or "--help")
        {
            Console.Error.WriteLine("usage: SkillLibrary.exe <packageRoot>");
            Console.Error.WriteLine(@"  e.g. SkillLibrary.exe <游戏包目录>");
            return 2;
        }

        var packageRoot = Path.GetFullPath(args[0]);
        if (!Directory.Exists(packageRoot))
        {
            Console.Error.WriteLine($"package root not found: {packageRoot}");
            return 2;
        }

        var outDir = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "out"));
        Directory.CreateDirectory(outDir);

        Console.WriteLine($"packageRoot = {packageRoot}");
        Console.WriteLine($"outputDir   = {outDir}");

        var catalog = CatalogLoader.Load(packageRoot, Console.WriteLine);

        // ---- reverse indexes ---------------------------------------------------
        var functionSkillIds = new Dictionary<int, HashSet<int>>();
        foreach (var skill in catalog.Skills)
        {
            if (!functionSkillIds.TryGetValue(skill.FunctionId, out var set))
            {
                set = new HashSet<int>();
                functionSkillIds[skill.FunctionId] = set;
            }
            set.Add(skill.Id);
        }

        var skillById = new Dictionary<int, SkillDefinition>();
        foreach (var skill in catalog.Skills) skillById[skill.Id] = skill;

        var cardsByFunctionId = new Dictionary<int, List<int>>();
        foreach (var pair in catalog.Cards)
        {
            foreach (var card in pair.Value)
            {
                foreach (var slot in card.SkillSlots)
                {
                    if (!cardsByFunctionId.TryGetValue(slot, out var list))
                    {
                        list = new List<int>();
                        cardsByFunctionId[slot] = list;
                    }
                    if (!list.Contains(card.Id)) list.Add(card.Id);
                }
            }
        }

        // ---- aggregate role blocks into opcode blocks ---------------------------
        var opcodes = new Dictionary<string, OpcodeView>(StringComparer.Ordinal);
        var groups = new Dictionary<string, Dictionary<string, ExampleGroup>>(StringComparer.Ordinal);

        OpcodeView Bucket(string opcode)
        {
            if (!opcodes.TryGetValue(opcode, out var bucket))
            {
                bucket = new OpcodeView { Name = opcode, Registered = RegisteredOpcodes.Set.Contains(opcode) };
                opcodes[opcode] = bucket;
                groups[opcode] = new Dictionary<string, ExampleGroup>(StringComparer.Ordinal);
            }
            return bucket;
        }

        foreach (var pair in catalog.RolesByFunction)
        {
            var functionId = pair.Key;
            var blocks = pair.Value;
            foreach (var block in blocks)
            {
                if (block.Opcode.Length == 0) continue; // blank function cell carries no opcode
                var bucket = Bucket(block.Opcode);
                bucket.RoleOccurrences++;
                bucket.FunctionIds.Add(functionId);
                bucket.Targets.Add(block.Target);
                if (blocks.Count > bucket.MaxRolesPerSet) bucket.MaxRolesPerSet = blocks.Count;

                if (functionSkillIds.TryGetValue(functionId, out var skillIds))
                {
                    foreach (var skillId in skillIds) bucket.SkillIds.Add(skillId);
                }
                if (cardsByFunctionId.TryGetValue(functionId, out var cardIds))
                {
                    foreach (var cardId in cardIds) bucket.CardsUsingOpcode.Add(cardId);
                }

                var key = DedupKey(block);
                bucket.DistinctParamSets.Add(key);
                var bucketGroups = groups[block.Opcode];
                if (!bucketGroups.TryGetValue(key, out var group))
                {
                    group = new ExampleGroup
                    {
                        Parameters = (string[])block.Parameters.Clone(),
                        Target = block.Target,
                        Attributes = block.Attributes,
                        ChainRate = block.ChainRate,
                        HateLimit = block.HateLimit,
                    };
                    bucketGroups[key] = group;
                }
                group.FunctionIds.Add(functionId);
                if (functionSkillIds.TryGetValue(functionId, out var ids))
                {
                    foreach (var id in ids) group.SkillIds.Add(id);
                }
                AddSampleCards(group.SampleCardIds, functionId, cardsByFunctionId);
            }
        }

        // ---- parameter rule contracts ------------------------------------------
        foreach (var pair in catalog.ParamRules)
        {
            var bucket = Bucket(pair.Key);
            bucket.HasParamRule = true;
            bucket.ParamRuleTypeList = (string[])pair.Value.Types.Clone();
        }

        // ---- build per-opcode example views ------------------------------------
        foreach (var pair in opcodes)
        {
            var bucket = pair.Value;
            var ordered = groups[pair.Key].Values
                .Select(g => new ExampleView
                {
                    Parameters = g.Parameters,
                    Target = g.Target,
                    Attributes = g.Attributes,
                    ChainRate = g.ChainRate,
                    HateLimit = g.HateLimit,
                    FunctionId = g.FunctionIds.Count == 0 ? 0 : g.FunctionIds.Min(),
                    SkillId = g.SkillIds.Count == 0 ? 0 : g.SkillIds.Min(),
                    Occurrences = g.Occurrences,
                    SampleCardIds = g.SampleCardIds.OrderBy(x => x).Take(MaxSampleCardIds).ToList(),
                })
                .OrderByDescending(e => e.Occurrences)
                .ThenBy(e => e.FunctionId)
                .ThenBy(e => e.SkillId)
                .ToList();

            foreach (var example in ordered)
            {
                if (skillById.TryGetValue(example.SkillId, out var skill))
                {
                    example.SkillName = skill.Name;
                    example.SkillSubName = skill.SubName;
                }
            }
            bucket.AllExamples.AddRange(ordered);
            bucket.TopExamples = ordered.Take(3).ToList();
        }

        // ---- deterministic ordering ---------------------------------------------
        static int CompareAggregate(OpcodeView a, OpcodeView b)
        {
            var byRegistered = b.Registered.CompareTo(a.Registered);
            if (byRegistered != 0) return byRegistered;
            var byOccurrences = b.RoleOccurrences.CompareTo(a.RoleOccurrences);
            if (byOccurrences != 0) return byOccurrences;
            return string.CompareOrdinal(a.Name, b.Name);
        }

        var orderedOpcodes = opcodes.Values.OrderBy(x => x, Comparer<OpcodeView>.Create(CompareAggregate)).ToList();

        // ---- emit skill-library.json -------------------------------------------
        var jsonOptions = new JsonWriterOptions { Indented = true, Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
        var generatedUtc = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ", System.Globalization.CultureInfo.InvariantCulture);

        var exampleTotal = 0;
        var cappedOpcodes = new List<string>();
        var libraryPath = Path.Combine(outDir, "skill-library.json");
        using (var stream = File.Create(libraryPath))
        using (var writer = new Utf8JsonWriter(stream, jsonOptions))
        {
            writer.WriteStartObject();
            writer.WriteNumber("schema_version", 1);
            writer.WriteString("generated_utc", generatedUtc);
            writer.WriteStartArray("opcodes");
            foreach (var bucket in orderedOpcodes)
            {
                writer.WriteStartObject();
                writer.WriteString("name", bucket.Name);
                writer.WriteBoolean("registered", bucket.Registered);
                writer.WriteStartArray("param_rule_types");
                for (var i = 0; i < 10; i++)
                {
                    writer.WriteStringValue(bucket.HasParamRule ? bucket.ParamRuleTypeList[i] : "");
                }
                writer.WriteEndArray();
                writer.WriteNumber("role_occurrences", bucket.RoleOccurrences);
                writer.WriteNumber("distinct_param_sets", bucket.DistinctParamSets.Count);
                writer.WriteStartArray("examples");

                var selected = bucket.AllExamples.Take(MaxExamplesPerOpcode).ToList();
                if (bucket.AllExamples.Count > MaxExamplesPerOpcode) cappedOpcodes.Add($"{bucket.Name}({bucket.AllExamples.Count}->{selected.Count})");
                foreach (var example in selected)
                {
                    exampleTotal++;
                    writer.WriteStartObject();
                    writer.WriteStartArray("params");
                    foreach (var parameter in example.Parameters) writer.WriteStringValue(parameter);
                    writer.WriteEndArray();
                    writer.WriteString("target", example.Target);
                    writer.WriteString("attributes", example.Attributes);
                    writer.WriteNumber("chain_rate", example.ChainRate);
                    writer.WriteNumber("hate_limit", example.HateLimit);
                    writer.WriteNumber("source_function_id", example.FunctionId);
                    writer.WriteNumber("source_skill_id", example.SkillId);
                    writer.WriteString("source_skill_name", example.SkillName);
                    writer.WriteString("source_sub_name", example.SkillSubName);
                    skillById.TryGetValue(example.SkillId, out var skill);
                    writer.WriteString("source_description", skill?.Description ?? "");
                    writer.WriteString("source_job", skill?.Job ?? "");
                    writer.WriteString("source_attribute", skill?.Attribute ?? "");
                    writer.WriteString("source_damage_kind", skill?.DamageKind ?? "");
                    writer.WriteNumber("source_cost", skill?.Cost ?? 0);
                    writer.WriteNumber("occurrences", example.Occurrences);
                    writer.WriteStartArray("sample_card_ids");
                    foreach (var cardId in example.SampleCardIds) writer.WriteNumberValue(cardId);
                    writer.WriteEndArray();
                    writer.WriteEndObject();
                }
                writer.WriteEndArray();
                writer.WriteEndObject();
            }
            writer.WriteEndArray();
            writer.WriteEndObject();
        }

        // ---- emit skill-index.json ---------------------------------------------
        var indexPath = Path.Combine(outDir, "skill-index.json");
        using (var stream = File.Create(indexPath))
        using (var writer = new Utf8JsonWriter(stream, jsonOptions))
        {
            writer.WriteStartObject();
            writer.WriteNumber("schema_version", 1);
            writer.WriteStartArray("skills");
            foreach (var skill in catalog.Skills.OrderBy(s => s.Id))
            {
                catalog.RolesByFunction.TryGetValue(skill.FunctionId, out var blocks);
                writer.WriteStartObject();
                writer.WriteNumber("id", skill.Id);
                writer.WriteString("name", skill.Name);
                writer.WriteString("sub_name", skill.SubName);
                writer.WriteString("kind", skill.Kind);
                writer.WriteString("attribute", skill.Attribute);
                writer.WriteString("job", skill.Job);
                writer.WriteString("damage_kind", skill.DamageKind);
                writer.WriteNumber("cost", skill.Cost);
                writer.WriteString("target", skill.Target);
                writer.WriteNumber("display_role", skill.DisplayRole);
                writer.WriteNumber("function_id", skill.FunctionId);
                writer.WriteNumber("role_count", blocks?.Count ?? 0);
                writer.WriteString("description", skill.Description);
                writer.WriteEndObject();
            }
            writer.WriteEndArray();
            writer.WriteEndObject();
        }

        // ---- emit skill-roles.json ---------------------------------------------
        var rolesPath = Path.Combine(outDir, "skill-roles.json");
        using (var stream = File.Create(rolesPath))
        using (var writer = new Utf8JsonWriter(stream, jsonOptions))
        {
            writer.WriteStartObject();
            writer.WriteNumber("schema_version", 1);
            writer.WriteStartObject("roles_by_function");
            foreach (var pair in catalog.RolesByFunction.OrderBy(p => p.Key))
            {
                writer.WriteStartArray(pair.Key.ToString(System.Globalization.CultureInfo.InvariantCulture));
                foreach (var block in pair.Value)
                {
                    writer.WriteStartObject();
                    writer.WriteString("opcode", block.Opcode);
                    writer.WriteString("target", block.Target);
                    writer.WriteString("attributes", block.Attributes);
                    writer.WriteStartArray("params");
                    foreach (var parameter in block.Parameters) writer.WriteStringValue(parameter);
                    writer.WriteEndArray();
                    writer.WriteNumber("chain_rate", block.ChainRate);
                    writer.WriteNumber("hate_limit", block.HateLimit);
                    writer.WriteEndObject();
                }
                writer.WriteEndArray();
            }
            writer.WriteEndObject();
            writer.WriteEndObject();
        }

        // ---- emit skill-library.md ---------------------------------------------
        var markdownPath = Path.Combine(outDir, "skill-library.md");
        ReportWriter.Write(markdownPath, catalog, orderedOpcodes, opcodes, generatedUtc);

        // ---- console metrics ----------------------------------------------------
        var unregistered = orderedOpcodes.Where(x => !x.Registered).ToList();
        var usedUnregistered = unregistered.Where(x => x.CardsUsingOpcode.Count > 0).ToList();
        var unusedUnregistered = unregistered.Where(x => x.CardsUsingOpcode.Count == 0).ToList();

        Console.WriteLine();
        Console.WriteLine("================================================================");
        Console.WriteLine($"whitelist size                  = {RegisteredOpcodes.Names.Length}");
        Console.WriteLine($"opcodes total (seen in data)    = {opcodes.Count}");
        Console.WriteLine($"opcodes unregistered            = {unregistered.Count}");
        Console.WriteLine($"unregistered list               = {(unregistered.Count == 0 ? "(none)" : string.Join(", ", unregistered.Select(x => x.Name)))}");
        Console.WriteLine($"role sets (distinct FunctionID) = {catalog.RolesByFunction.Count}");
        Console.WriteLine($"max role blocks in one set      = {catalog.MaxRolesPerFunction}");
        Console.WriteLine($"examples in skill-library.json  = {exampleTotal}");
        Console.WriteLine($"opcodes whose examples were capped at {MaxExamplesPerOpcode} = {cappedOpcodes.Count}");
        if (cappedOpcodes.Count > 0) Console.WriteLine($"   capped: {string.Join(", ", cappedOpcodes)}");
        Console.WriteLine("================================================================");

        Console.WriteLine();
        Console.WriteLine("--- unregistered opcodes actually used by cards (data anomaly) ---");
        if (usedUnregistered.Count == 0) Console.WriteLine("(none)");
        foreach (var bucket in usedUnregistered)
        {
            Console.WriteLine($"  {bucket.Name}: role_occurrences={bucket.RoleOccurrences} skills={bucket.SkillIds.Count} cards={bucket.CardsUsingOpcode.Count} sample=[{string.Join(",", bucket.CardsUsingOpcode.OrderBy(x => x).Take(5))}]");
        }

        Console.WriteLine();
        Console.WriteLine("--- unregistered opcodes NOT used by any card ---");
        if (unusedUnregistered.Count == 0) Console.WriteLine("(none)");
        foreach (var bucket in unusedUnregistered)
        {
            Console.WriteLine($"  {bucket.Name}: role_occurrences={bucket.RoleOccurrences} skills={bucket.SkillIds.Count}");
        }

        Console.WriteLine();
        Console.WriteLine("--- whitelist opcodes never seen in the data ---");
        var missing = RegisteredOpcodes.Names.Where(n => !opcodes.ContainsKey(n)).OrderBy(n => n, StringComparer.Ordinal).ToList();
        Console.WriteLine(missing.Count == 0 ? "(none)" : string.Join(", ", missing));

        Console.WriteLine();
        foreach (var path in new[] { libraryPath, indexPath, rolesPath, markdownPath })
        {
            Console.WriteLine($"WROTE {path} ({new FileInfo(path).Length} bytes)");
        }
        return 0;
    }

    private static void AddSampleCards(List<int> target, int functionId, Dictionary<int, List<int>> cardsByFunctionId)
    {
        if (target.Count >= MaxSampleCardIds) return;
        if (!cardsByFunctionId.TryGetValue(functionId, out var cards)) return;
        foreach (var cardId in cards.OrderBy(x => x))
        {
            if (target.Count >= MaxSampleCardIds) return;
            if (!target.Contains(cardId)) target.Add(cardId);
        }
    }

    private static string DedupKey(SkillRole block)
    {
        var sb = new StringBuilder(160);
        sb.Append(block.Opcode).Append('\u0001')
          .Append(block.Target).Append('\u0001')
          .Append(block.Attributes).Append('\u0001');
        for (var i = 0; i < 10; i++) sb.Append(block.Parameters[i]).Append('\u0001');
        sb.Append(block.ChainRate).Append('\u0001').Append(block.HateLimit);
        return sb.ToString();
    }
}
