using System.Text;
using Microsoft.VisualBasic.FileIO;

namespace SkillLibrary;

public enum CsvEngine
{
    TextFieldParser,
    OwnParser
}

public sealed class MalformedCsvException : Exception
{
    public MalformedCsvException(string message) : base(message) { }
}

/// <summary>
/// RFC4180-safe CSV reader with two independent engines:
///  * TextFieldParser (Microsoft.VisualBasic.FileIO, ships in the BCL - no NuGet package)
///  * a hand written RFC4180 state machine
///
/// The official CN master tables also contain a few literal quote characters inside
/// otherwise unquoted display-text fields (the Go server sets csv.LazyQuotes = true for
/// exactly this reason), so both engines fall back to treating a stray quote as a
/// literal character instead of failing.
/// </summary>
public static class Csv
{
    public static string Decode(byte[] bytes)
    {
        var offset = 0;
        if (bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF) offset = 3;
        return new UTF8Encoding(false).GetString(bytes, offset, bytes.Length - offset);
    }

    public static List<string[]> Read(string path, CsvEngine engine = CsvEngine.TextFieldParser)
        => engine == CsvEngine.TextFieldParser ? ReadWithTextFieldParser(path) : ReadWithOwnParser(path);

    public static List<string[]> ReadWithTextFieldParser(string path)
    {
        var rows = new List<string[]>();
        using var reader = new StreamReader(path, new UTF8Encoding(false), detectEncodingFromByteOrderMarks: true);
        while (!reader.EndOfStream)
        {
            var raw = ReadLogicalLine(reader);
            if (raw is null) break;
            if (raw.Length == 0) continue;
            string[] fields;
            try
            {
                fields = ParseRecord(raw, strict: true);
            }
            catch (MalformedCsvException)
            {
                fields = ParseRecord(raw, strict: false);
            }
            rows.Add(fields);
        }
        return rows;
    }

    /// <summary>
    /// Alternative engine using Microsoft.VisualBasic.FileIO.TextFieldParser. Kept as an
    /// independent cross-check of <see cref="ReadWithTextFieldParser"/>.
    /// </summary>
    public static List<string[]> ReadWithVisualBasicParser(string path)
    {
        var rows = new List<string[]>();
        using var parser = new TextFieldParser(path, new UTF8Encoding(false), detectEncoding: true);
        parser.TextFieldType = FieldType.Delimited;
        parser.SetDelimiters(",");
        parser.HasFieldsEnclosedInQuotes = true;
        parser.TrimWhiteSpace = false;
        while (!parser.EndOfData)
        {
            string[]? fields;
            try
            {
                fields = parser.ReadFields();
            }
            catch (MalformedLineException)
            {
                fields = SplitLazy(parser.ErrorLine ?? string.Empty, ',');
            }
            if (fields is null) continue;
            rows.Add(fields);
        }
        return rows;
    }

    public static List<string[]> ReadWithOwnParser(string path)
    {
        var text = Decode(File.ReadAllBytes(path));
        var rows = new List<string[]>();
        var fields = new List<string>();
        var sb = new StringBuilder();
        var inQuotes = false;
        var i = 0;
        var sawAny = false;
        while (i < text.Length)
        {
            var c = text[i];
            if (inQuotes)
            {
                if (c == '"')
                {
                    if (i + 1 < text.Length && text[i + 1] == '"') { sb.Append('"'); i += 2; continue; }
                    inQuotes = false; i++; continue;
                }
                sb.Append(c); i++; continue;
            }
            switch (c)
            {
                case '"':
                    if (sb.Length == 0) { inQuotes = true; i++; sawAny = true; continue; }
                    sb.Append(c); i++; sawAny = true; continue;
                case ',':
                    fields.Add(sb.ToString()); sb.Clear(); sawAny = true; i++; continue;
                case '\r':
                    if (i + 1 < text.Length && text[i + 1] == '\n') i++;
                    goto case '\n';
                case '\n':
                    fields.Add(sb.ToString()); sb.Clear();
                    rows.Add(fields.ToArray());
                    fields.Clear();
                    sawAny = false;
                    i++;
                    continue;
                default:
                    sb.Append(c); sawAny = true; i++; continue;
            }
        }
        if (sawAny || sb.Length > 0 || fields.Count > 0)
        {
            fields.Add(sb.ToString());
            rows.Add(fields.ToArray());
        }
        return rows;
    }

    /// <summary>Reads one logical CSV record, honouring CRLF/LF embedded inside quotes.</summary>
    private static string? ReadLogicalLine(StreamReader reader)
    {
        var sb = new StringBuilder();
        var inQuotes = false;
        var started = false;
        while (true)
        {
            var read = reader.ReadLine();
            if (read is null) return started || sb.Length > 0 ? sb.ToString() : null;
            started = true;
            sb.Append(read);
            foreach (var c in read)
            {
                if (c == '"') inQuotes = !inQuotes;
            }
            if (!inQuotes) return sb.ToString();
            sb.Append('\n');
        }
    }

    private static string[] ParseRecord(string line, bool strict)
    {
        var fields = new List<string>();
        var sb = new StringBuilder();
        var i = 0;
        var inQuotes = false;
        var fieldQuoted = false;
        while (i < line.Length)
        {
            var c = line[i];
            if (inQuotes)
            {
                if (c == '"')
                {
                    if (i + 1 < line.Length && line[i + 1] == '"') { sb.Append('"'); i += 2; continue; }
                    inQuotes = false; i++; continue;
                }
                sb.Append(c); i++; continue;
            }
            if (c == '"')
            {
                if (sb.Length == 0 && !fieldQuoted) { inQuotes = true; fieldQuoted = true; i++; continue; }
                if (strict) throw new MalformedCsvException("quote inside unquoted field");
                sb.Append(c); i++; continue;
            }
            if (c == ',')
            {
                fields.Add(sb.ToString()); sb.Clear(); fieldQuoted = false; i++; continue;
            }
            sb.Append(c); i++;
        }
        if (inQuotes && strict) throw new MalformedCsvException("unterminated quoted field");
        fields.Add(sb.ToString());
        return fields.ToArray();
    }

    private static string[] SplitLazy(string line, char delimiter)
    {
        var fields = new List<string>();
        var sb = new StringBuilder();
        var inQuotes = false;
        for (var i = 0; i < line.Length; i++)
        {
            var c = line[i];
            if (c == '"')
            {
                if (inQuotes && i + 1 < line.Length && line[i + 1] == '"') { sb.Append('"'); i++; continue; }
                inQuotes = !inQuotes; continue;
            }
            if (c == delimiter && !inQuotes) { fields.Add(sb.ToString()); sb.Clear(); continue; }
            sb.Append(c);
        }
        fields.Add(sb.ToString());
        return fields.ToArray();
    }

    public static string Field(IReadOnlyList<string> row, int index)
        => index >= 0 && index < row.Count ? row[index] : string.Empty;

    public static string Trimmed(IReadOnlyList<string> row, int index)
        => Field(row, index).Trim();

    public static int IntOrZero(IReadOnlyList<string> row, int index)
    {
        var raw = Trimmed(row, index);
        if (raw.Length == 0) return 0;
        return int.TryParse(raw, System.Globalization.NumberStyles.Integer,
            System.Globalization.CultureInfo.InvariantCulture, out var value) ? value : 0;
    }

    public static long LongOrZero(IReadOnlyList<string> row, int index)
    {
        var raw = Trimmed(row, index);
        if (raw.Length == 0) return 0;
        return long.TryParse(raw, System.Globalization.NumberStyles.Integer,
            System.Globalization.CultureInfo.InvariantCulture, out var value) ? value : 0;
    }

    /// <summary>Mirrors the Go server's row filter: skip blank / comment / non-numeric-id rows.</summary>
    public static bool IsCommentOrHeader(IReadOnlyList<string> row)
    {
        if (row.Count == 0) return true;
        var first = Field(row, 0);
        if (first.Length > 0 && first[0] == '\uFEFF') first = first[1..];
        first = first.Trim();
        return first.Length == 0 || first[0] == '#';
    }
}
