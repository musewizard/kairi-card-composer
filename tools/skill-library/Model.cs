namespace SkillLibrary;

public sealed class SkillDefinition
{
    public int Id;
    public string Name = "";
    public string SubName = "";
    public string Description = "";
    public int DisplayParamNumber;
    public int DisplayRole;
    public int DisplayMultiplier;
    public string DisplayType = "";
    public string Kind = "";
    public string Attribute = "";
    public string Job = "";
    public string DamageKind = "";
    public int Cost;
    public int PriorityPve;
    public string Rank = "";
    public int HateRatio;
    public string Target = "";
    public int HandSelectCount;
    public string HandAttribute = "";
    public string HandKind = "";
    public int HandMinCost;
    public int HandMaxCost;
    public int FunctionId;
}

public sealed class SkillRole
{
    public int FunctionId;
    public int RoleIndex;
    public string Opcode = "";
    public string Target = "";
    public string Attributes = "000000000";
    public string[] Parameters = new string[10];
    public int ChainRate;
    public int HateLimit;
    public int SourceSkillId;
}

public sealed class ParamRule
{
    public string Function = "";
    public string[] Types = new string[10];
    public int DeclaredTypes;
}

public sealed class CardDefinition
{
    public int Id;
    public List<int> SkillSlots = new();
}

public sealed class Catalog
{
    public List<SkillDefinition> Skills = new();
    public Dictionary<int, List<SkillRole>> RolesByFunction = new();
    public Dictionary<string, ParamRule> ParamRules = new(StringComparer.Ordinal);
    public Dictionary<int, List<CardDefinition>> Cards = new();
    public int SkillRows;
    public int RoleRows;
    public int CardRows;
    public int ParamRuleRows;
    public int MaxRolesPerFunction;
    public int MaxRoleFieldWidth;
}
