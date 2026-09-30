using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using AssetsTools.NET;
using AssetsTools.NET.Extra;
using AssetsTools.NET.Texture;

namespace BundleTool
{
    internal static class Program
    {
        private const int TextAssetTypeId = 49;

        private static int Main(string[] args)
        {
            if (args.Length < 2)
            {
                Console.Error.WriteLine("usage:");
                Console.Error.WriteLine("  BundleTool list      <bundle>");
                Console.Error.WriteLine("  BundleTool dump      <bundle> <textAssetName> <outFile>");
                Console.Error.WriteLine("  BundleTool replace   <bundle> <textAssetName> <inFile> <outBundle>");
                Console.Error.WriteLine("  BundleTool roundtrip <bundle> <outBundle>");
                Console.Error.WriteLine("  BundleTool verify    <bundle> <serverResourceSetRoot>");
                return 2;
            }

            string command = args[0].ToLowerInvariant();
            string bundlePath = Path.GetFullPath(args[1]);
            if (!File.Exists(bundlePath))
            {
                Console.Error.WriteLine("bundle not found: " + bundlePath);
                return 2;
            }

            switch (command)
            {
                case "list": return List(bundlePath);
                case "dump": return Dump(bundlePath, args);
                case "replace": return Replace(bundlePath, args);
                case "replace-many": return ReplaceMany(bundlePath, args);
                case "roundtrip": return Roundtrip(bundlePath, args);
                case "verify": return Verify(bundlePath, args);
                case "list-textures": return ListTextures(bundlePath, args);
                case "texture-info": return TextureInfo(bundlePath, args);
                case "export-texture": return ExportTexture(bundlePath, args);
                case "import-texture": return ImportTexture(bundlePath, args);
                case "probe-assets": return ProbeAssets(bundlePath, args);
                case "make-card-bundle": return MakeCardBundle(bundlePath, args);
                default:
                    Console.Error.WriteLine("unknown command: " + command);
                    return 2;
            }
        }

        // ---------------------------------------------------------- textures
        // 卡面是 Unity Texture2D（TypeId 28），躺在 patch\main_c\image\*.dat 里。
        // 这三个命令让「导入自己的图当卡面」成为可能：列出 → 导出（核对）→ 导入。
        // 导入时把格式统一成 **RGBA32**（未压缩）：AssetsTools.NET.Texture 只能编码未压缩格式，
        // 原来的 PVRTC/ETC/ASTC 解不开也编不回去；RGBA32 是 Unity 5.3 一定支持的老格式。
        private const int Texture2DTypeId = 28;

        private static TextureFile ReadTexture(AssetsManager manager, AssetsFileInstance inst, AssetFileInfo info)
        {
            var bf = manager.GetBaseField(inst, info);
            var tf = new TextureFile();
            return TextureFile.ReadTextureFile(bf);
        }

        private static string TextureFormatName(int id)
        {
            try { return ((TextureFormat)id).ToString(); } catch { return "?"; }
        }

        // ---------------------------------------------------------------- probe-assets
        // 侦察用：列出包里每个资源（pathId/TypeId/名字），并把 AssetBundle 资源(TypeId 142) 的
        // m_Container 映射（容器路径 → pathId）打出来 —— 造新卡面包时要照着改这个。
        private const int AssetBundleTypeId = 142;

        private static int ProbeAssets(string bundlePath, string[] args)
        {
            var manager = new AssetsManager();
            try
            {
                BundleFileInstance bun;
                AssetsFileInstance inst;
                try
                {
                    bun = manager.LoadBundleFile(bundlePath, true);
                    inst = manager.LoadAssetsFileFromBundle(bun, 0, false);
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine("BUNDLE UNREADABLE（加密包？）: " + ex.GetType().Name + " " + ex.Message);
                    return 3;
                }
                var dirInfo = bun.file.BlockAndDirInfo.DirectoryInfos[0];
                Console.WriteLine("cab_name: " + dirInfo.Name);
                foreach (var info in inst.file.AssetInfos)
                {
                    string name = "";
                    try { name = manager.GetBaseField(inst, info)["m_Name"].AsString; } catch { }
                    Console.WriteLine(string.Format("  pathId={0,-8} typeId={1,-6} {2}", info.PathId, info.TypeId, name));
                    if (info.TypeId != AssetBundleTypeId) continue;
                    var bf = manager.GetBaseField(inst, info);
                    var container = bf["m_Container"];
                    if (container == null) { Console.WriteLine("    (no m_Container)"); continue; }
                    if (args.Length > 2 && args[2] == "--tree")
                    {
                        PrintFieldTree(bf, "  ", 0, 5);
                        continue;
                    }
                    int i = 0;
                    foreach (var entry in container["Array"].Children)
                    {
                        string path = null;
                        long pid = -1;
                        try
                        {
                            path = entry["first"].AsString;
                            pid = entry["second"]["asset"]["m_PathID"].AsLong;
                        }
                        catch (Exception ex) { Console.WriteLine("    (entry parse failed: " + ex.Message + ")"); break; }
                        Console.WriteLine(string.Format("    [{0}] {1}  -> pathId {2}", i++, path, pid));
                        if (i >= 400) { Console.WriteLine("    …（更多省略）"); break; }
                    }
                }
                return 0;
            }
            finally { manager.UnloadAllBundleFiles(); }
        }

        // ---------------------------------------------------------------- make-card-bundle
        // 从**模板明文包**复制并改造成「新卡面 ID 的包」：
        //   make-card-bundle <srcBundle> <outBundle> <newCabName> <specFile>
        // specFile 每行： <模板里的纹理名>\t<新纹理名>\t<新容器路径>\t<rawRgba文件>\t<宽>\t<高>
        // 做的事：改 m_Name、写像素（RGBA32、单 mip）、按 pathId 改 m_Container 里的容器路径、
        // 换一个新的 cab 名，最后重新读回来验证（名字/容器路径/像素）。
        private static int MakeCardBundle(string bundlePath, string[] args)
        {
            if (args.Length < 5)
            {
                Console.Error.WriteLine("usage: BundleTool make-card-bundle <srcBundle> <outBundle> <newCabName> <specFile>");
                return 2;
            }
            string outBundle = Path.GetFullPath(args[2]);
            string newCabName = args[3];
            string specFile = Path.GetFullPath(args[4]);
            if (!File.Exists(specFile)) { Console.Error.WriteLine("spec not found: " + specFile); return 2; }
            if (string.Equals(bundlePath, outBundle, StringComparison.OrdinalIgnoreCase)) { Console.Error.WriteLine("refusing to overwrite the source bundle"); return 2; }

            var specs = new List<CardBundleSpec>();
            foreach (var rawLine in File.ReadAllLines(specFile))
            {
                var line = rawLine.Trim();
                if (line.Length == 0 || line.StartsWith("#")) continue;
                var parts = line.Split('\t');
                if (parts.Length != 6) { Console.Error.WriteLine("bad spec line: " + line); return 2; }
                var spec = new CardBundleSpec
                {
                    oldName = parts[0],
                    newName = parts[1],
                    containerPath = parts[2],
                    rawFile = parts[3],
                    width = int.Parse(parts[4]),
                    height = int.Parse(parts[5]),
                };
                if (!File.Exists(spec.rawFile)) { Console.Error.WriteLine("raw not found: " + spec.rawFile); return 2; }
                spec.bgra = RgbaFileToBgra(spec.rawFile, spec.width, spec.height);
                if (spec.bgra == null) return 2;
                specs.Add(spec);
            }
            if (specs.Count == 0) { Console.Error.WriteLine("empty spec"); return 2; }

            var manager = new AssetsManager();
            var done = new List<string>();
            try
            {
                BundleFileInstance bun;
                AssetsFileInstance inst;
                try
                {
                    bun = manager.LoadBundleFile(bundlePath, true);
                    inst = manager.LoadAssetsFileFromBundle(bun, 0, false);
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine("BUNDLE UNREADABLE（加密包？）: " + ex.GetType().Name + " " + ex.Message);
                    return 3;
                }

                // 1) 目标纹理：改名 + 换像素
                var assetReplacers = new List<AssetsReplacer>();
                var byPathId = new Dictionary<long, CardBundleSpec>();
                foreach (var info in inst.file.AssetInfos)
                {
                    if (info.TypeId != Texture2DTypeId) continue;
                    var bf = manager.GetBaseField(inst, info);
                    string name = bf["m_Name"].AsString;
                    var spec = specs.FirstOrDefault(s => s.oldName == name);
                    if (spec == null) continue;
                    var tf = TextureFile.ReadTextureFile(bf);
                    Console.WriteLine(string.Format("target : {0} -> {1}   ({2}x{3} -> {4}x{5})",
                        name, spec.newName, tf.m_Width, tf.m_Height, spec.width, spec.height));
                    bf["m_Name"].AsString = spec.newName;
                    tf.m_Name = spec.newName;              // WriteTo 会把 m_Name 一起写回去，必须两个都改
                    tf.m_Width = spec.width;
                    tf.m_Height = spec.height;
                    tf.m_TextureFormat = (int)TextureFormat.RGBA32;
                    tf.m_MipCount = 1;
                    tf.m_MipMap = false;
                    tf.SetTextureData(spec.bgra, spec.width, spec.height);
                    tf.WriteTo(bf);
                    assetReplacers.Add(new AssetsReplacerFromMemory(inst.file, info, bf));
                    byPathId[info.PathId] = spec;
                }
                if (byPathId.Count != specs.Count)
                {
                    Console.Error.WriteLine(string.Format("matched {0} of {1} textures", byPathId.Count, specs.Count));
                    return 1;
                }

                // 2) AssetBundle 的容器表：把对应 pathId 的容器路径改成新的
                int containerFixed = 0;
                foreach (var info in inst.file.AssetInfos)
                {
                    if (info.TypeId != AssetBundleTypeId) continue;
                    var bf = manager.GetBaseField(inst, info);
                    foreach (var entry in bf["m_Container"]["Array"].Children)
                    {
                        long pid;
                        try { pid = entry["second"]["asset"]["m_PathID"].AsLong; } catch { continue; }
                        if (!byPathId.TryGetValue(pid, out var spec)) continue;
                        Console.WriteLine(string.Format("container: {0} -> {1}", entry["first"].AsString, spec.containerPath));
                        entry["first"].AsString = spec.containerPath;
                        containerFixed++;
                    }
                    assetReplacers.Add(new AssetsReplacerFromMemory(inst.file, info, bf));
                    break;
                }
                if (containerFixed == 0) Console.WriteLine("warning: no container entry was updated (check m_Container layout)");

                // 3) 写新包（换 cab 名）
                byte[] newAssets;
                using (var ms = new MemoryStream())
                {
                    inst.file.Write(new AssetsFileWriter(ms), 0, assetReplacers, null);
                    newAssets = ms.ToArray();
                }
                var dirInfo = bun.file.BlockAndDirInfo.DirectoryInfos[0];
                var bundleReplacers = new List<BundleReplacer>
                {
                    // 注意参数顺序：(oldName, newName, ...) —— 反了的话 cab 名不会变
                    new BundleReplacerFromMemory(dirInfo.Name, newCabName, true, newAssets, newAssets.Length, 0)
                };
                WriteBundleCompressed(bun.file, bundleReplacers, outBundle);
                Console.WriteLine(string.Format("wrote bundle: {0} ({1} bytes) cab={2}", outBundle, new FileInfo(outBundle).Length, newCabName));
            }
            finally { manager.UnloadAllBundleFiles(); }

            // 4) 验证
            var check = new AssetsManager();
            try
            {
                var bun2 = check.LoadBundleFile(outBundle, true);
                var inst2 = check.LoadAssetsFileFromBundle(bun2, 0, false);
                Console.WriteLine("verify cab_name: " + bun2.file.BlockAndDirInfo.DirectoryInfos[0].Name);
                foreach (var info in inst2.file.AssetInfos)
                {
                    if (info.TypeId != AssetBundleTypeId) continue;
                    var bf = check.GetBaseField(inst2, info);
                    foreach (var entry in bf["m_Container"]["Array"].Children)
                    {
                        long pid;
                        try { pid = entry["second"]["asset"]["m_PathID"].AsLong; } catch { continue; }
                        var spec = specs.FirstOrDefault(s => s.containerPath == entry["first"].AsString);
                        if (spec != null) Console.WriteLine("verify container: " + entry["first"].AsString);
                    }
                }
                foreach (var info in inst2.file.AssetInfos)
                {
                    if (info.TypeId != Texture2DTypeId) continue;
                    var bf = check.GetBaseField(inst2, info);
                    string name = bf["m_Name"].AsString;
                    var spec = specs.FirstOrDefault(s => s.newName == name);
                    if (spec == null) continue;
                    var tf2 = TextureFile.ReadTextureFile(bf);
                    byte[] back = tf2.GetTextureData(inst2);
                    bool same = back.Length == spec.bgra.Length;
                    long diff = 0;
                    if (same) for (int i = 0; i < back.Length; i++) if (back[i] != spec.bgra[i]) diff++;
                    Console.WriteLine(string.Format("verify texture: {0} {1}x{2} fmt={3} bytes={4} 不一致字节={5}",
                        name, tf2.m_Width, tf2.m_Height, TextureFormatName(tf2.m_TextureFormat), back.Length, diff));
                    if (!(tf2.m_Width == spec.width && tf2.m_Height == spec.height &&
                          tf2.m_TextureFormat == (int)TextureFormat.RGBA32 && same && diff == 0))
                    {
                        Console.Error.WriteLine("VERIFY FAILED: " + spec.newName);
                        return 1;
                    }
                    done.Add(name);
                }
                if (done.Count != specs.Count) { Console.Error.WriteLine("VERIFY FAILED: not all textures found"); return 1; }
                Console.WriteLine("CARD BUNDLE VERIFIED");
                return 0;
            }
            finally { check.UnloadAllBundleFiles(); }
        }

        /// <summary>把字段树打出来（侦察 m_Container 之类嵌套结构的真实字段名）</summary>
        private static void PrintFieldTree(AssetTypeValueField field, string indent, int depth, int maxDepth)
        {
            if (field == null) return;
            string val = "";
            try
            {
                if (field.TypeName == "string") val = " = " + field.AsString;
                else if (field.Children == null || field.Children.Count == 0) val = " = " + field.AsString;
            }
            catch { }
            Console.WriteLine(string.Format("{0}{1} : {2}{3}", indent, field.FieldName, field.TypeName, val));
            if (depth >= maxDepth || field.Children == null) return;
            int shown = 0;
            foreach (var child in field.Children)
            {
                PrintFieldTree(child, indent + "  ", depth + 1, maxDepth);
                if (++shown >= 8) { Console.WriteLine(indent + "  …（共 " + field.Children.Count + " 个）"); break; }
            }
        }

        private sealed class CardBundleSpec
        {            public string oldName;
            public string newName;
            public string containerPath;
            public string rawFile;
            public int width;
            public int height;
            public byte[] bgra;
        }

        /// <summary>读原始 RGBA 文件 → BGRA（SetTextureData 吃 BGRA）</summary>
        private static byte[] RgbaFileToBgra(string file, int width, int height)
        {
            byte[] raw = File.ReadAllBytes(file);
            if (raw.Length != width * height * 4)
            {
                Console.Error.WriteLine(string.Format("raw size mismatch: {0} bytes, expected {1}", raw.Length, width * height * 4));
                return null;
            }
            var bgra = new byte[raw.Length];
            for (int i = 0; i < raw.Length; i += 4)
            {
                bgra[i + 0] = raw[i + 2];
                bgra[i + 1] = raw[i + 1];
                bgra[i + 2] = raw[i + 0];
                bgra[i + 3] = raw[i + 3];
            }
            return bgra;
        }

        // texture-info <bundle> <textureName>：只报一张纹理的尺寸/格式（给造卡工具做「按游戏比例裁剪」用）
        private static int TextureInfo(string bundlePath, string[] args)
        {
            if (args.Length < 3)
            {
                Console.Error.WriteLine("usage: BundleTool texture-info <bundle> <textureName>");
                return 2;
            }
            string selector = args[2];
            var manager = new AssetsManager();
            try
            {
                BundleFileInstance bun;
                AssetsFileInstance inst;
                try
                {
                    bun = manager.LoadBundleFile(bundlePath, true);
                    inst = manager.LoadAssetsFileFromBundle(bun, 0, false);
                }
                catch (Exception ex)
                {
                    // CN 包有一大半是加密的（asset-map.json 里 scrambled=true），
                    // AssetsTools.NET 没有密钥读不了。这里给出干净的错误而不是抛栈。
                    Console.Error.WriteLine("BUNDLE UNREADABLE（加密包？）: " + ex.GetType().Name + " " + ex.Message);
                    return 3;
                }
                foreach (var info in inst.file.AssetInfos)
                {
                    if (info.TypeId != Texture2DTypeId) continue;
                    var bf = manager.GetBaseField(inst, info);
                    string name = bf["m_Name"].AsString;
                    if (!string.Equals(name, selector, StringComparison.Ordinal) && info.PathId.ToString() != selector) continue;
                    var tf = TextureFile.ReadTextureFile(bf);
                    Console.WriteLine(string.Format("TEXTURE name={0} width={1} height={2} format={3} formatId={4} mips={5} bytes={6}",
                        name, tf.m_Width, tf.m_Height, TextureFormatName(tf.m_TextureFormat), tf.m_TextureFormat, tf.m_MipCount, tf.m_CompleteImageSize));
                    return 0;
                }
                Console.Error.WriteLine("no Texture2D matched: " + selector);
                return 1;
            }
            finally { manager.UnloadAllBundleFiles(); }
        }

        private static int ListTextures(string bundlePath, string[] args)
        {
            bool all = args.Length > 2 && args[2] == "--all";
            string filter = args.Length > 2 && args[2] != "--all" ? args[2] : null;
            var manager = new AssetsManager();
            try
            {
                BundleFileInstance bun;
                AssetsFileInstance inst;
                try
                {
                    bun = manager.LoadBundleFile(bundlePath, true);
                    inst = manager.LoadAssetsFileFromBundle(bun, 0, false);
                }
                catch (Exception ex)
                {
                    // CN 包有一大半是加密的（asset-map.json 里 scrambled=true），
                    // AssetsTools.NET 没有密钥读不了。这里给出干净的错误而不是抛栈。
                    Console.Error.WriteLine("BUNDLE UNREADABLE（加密包？）: " + ex.GetType().Name + " " + ex.Message);
                    return 3;
                }
                int count = 0;
                foreach (var info in inst.file.AssetInfos)
                {
                    if (info.TypeId != Texture2DTypeId) continue;
                    var bf = manager.GetBaseField(inst, info);
                    string name = bf["m_Name"].AsString;
                    if (filter != null && name.IndexOf(filter, StringComparison.OrdinalIgnoreCase) < 0) continue;
                    var tf = new TextureFile();
                    try { tf = TextureFile.ReadTextureFile(bf); }
                    catch (Exception ex) { Console.WriteLine(string.Format("  {0,-40} <读取失败: {1}>", name, ex.Message)); continue; }
                    Console.WriteLine(string.Format("  {0,-44} {1,5}x{2,-5} fmt={3,-12} mips={4} bytes={5,-9} pathId={6}",
                        name, tf.m_Width, tf.m_Height, TextureFormatName(tf.m_TextureFormat), tf.m_MipCount,
                        tf.m_CompleteImageSize, info.PathId));
                    count++;
                    if (!all && count >= 200) { Console.WriteLine("  …（更多请加 --all 或给名字过滤）"); break; }
                }
                Console.WriteLine("textures listed: " + count);
                return 0;
            }
            finally { manager.UnloadAllBundleFiles(); }
        }

        private static int ExportTexture(string bundlePath, string[] args)
        {
            if (args.Length < 4)
            {
                Console.Error.WriteLine("usage: BundleTool export-texture <bundle> <textureName> <outRawFile>");
                return 2;
            }
            string selector = args[2];
            string outFile = Path.GetFullPath(args[3]);
            var manager = new AssetsManager();
            try
            {
                BundleFileInstance bun;
                AssetsFileInstance inst;
                try
                {
                    bun = manager.LoadBundleFile(bundlePath, true);
                    inst = manager.LoadAssetsFileFromBundle(bun, 0, false);
                }
                catch (Exception ex)
                {
                    // CN 包有一大半是加密的（asset-map.json 里 scrambled=true），
                    // AssetsTools.NET 没有密钥读不了。这里给出干净的错误而不是抛栈。
                    Console.Error.WriteLine("BUNDLE UNREADABLE（加密包？）: " + ex.GetType().Name + " " + ex.Message);
                    return 3;
                }
                AssetFileInfo target = null;
                string targetName = null;
                foreach (var info in inst.file.AssetInfos)
                {
                    if (info.TypeId != Texture2DTypeId) continue;
                    var bf = manager.GetBaseField(inst, info);
                    string name = bf["m_Name"].AsString;
                    if (string.Equals(name, selector, StringComparison.Ordinal) || info.PathId.ToString() == selector) { target = info; targetName = name; break; }
                }
                if (target == null) { Console.Error.WriteLine("no Texture2D matched: " + selector); return 1; }
                var bf2 = manager.GetBaseField(inst, target);
                var tf = new TextureFile();
                tf = TextureFile.ReadTextureFile(bf2);
                byte[] decoded = tf.GetTextureData(inst);          // 解出来的像素（BGRA 顺序）
                File.WriteAllBytes(outFile, decoded);
                Console.WriteLine(string.Format("exported {0}  {1}x{2} fmt={3} -> {4} ({5} bytes)",
                    targetName, tf.m_Width, tf.m_Height, TextureFormatName(tf.m_TextureFormat), outFile, decoded.Length));
                Console.WriteLine(string.Format("RAW INFO width={0} height={1} bytes={2} (BGRA)", tf.m_Width, tf.m_Height, decoded.Length));
                return 0;
            }
            finally { manager.UnloadAllBundleFiles(); }
        }

        // import-texture <bundle> <textureName> <inRaw> <width> <height> <outBundle> [--rgba]
        // 输入是**未压缩像素**（默认 BGRA，和 export-texture 的输出一致；加 --rgba 表示数据是 RGBA 顺序）。
        private static int ImportTexture(string bundlePath, string[] args)
        {
            if (args.Length < 7)
            {
                Console.Error.WriteLine("usage: BundleTool import-texture <bundle> <textureName> <inRaw> <width> <height> <outBundle> [--rgba]");
                return 2;
            }
            string selector = args[2];
            string inRaw = Path.GetFullPath(args[3]);
            int width = int.Parse(args[4]);
            int height = int.Parse(args[5]);
            string outBundle = Path.GetFullPath(args[6]);
            bool inputIsRgba = args.Length > 7 && args[7] == "--rgba";
            if (!File.Exists(inRaw)) { Console.Error.WriteLine("input not found: " + inRaw); return 2; }
            if (string.Equals(bundlePath, outBundle, StringComparison.OrdinalIgnoreCase)) { Console.Error.WriteLine("refusing to overwrite the source bundle"); return 2; }

            byte[] raw = File.ReadAllBytes(inRaw);
            if (raw.Length != width * height * 4)
            {
                Console.Error.WriteLine(string.Format("raw size mismatch: {0} bytes, expected {1} ({2}x{3}x4)", raw.Length, width * height * 4, width, height));
                return 2;
            }
            // SetTextureData 吃 BGRA；如果给的是 RGBA 就先换过来
            byte[] bgra = raw;
            if (inputIsRgba)
            {
                bgra = new byte[raw.Length];
                for (int i = 0; i < raw.Length; i += 4)
                {
                    bgra[i + 0] = raw[i + 2];
                    bgra[i + 1] = raw[i + 1];
                    bgra[i + 2] = raw[i + 0];
                    bgra[i + 3] = raw[i + 3];
                }
            }

            var manager = new AssetsManager();
            string targetName = null;
            try
            {
                BundleFileInstance bun;
                AssetsFileInstance inst;
                try
                {
                    bun = manager.LoadBundleFile(bundlePath, true);
                    inst = manager.LoadAssetsFileFromBundle(bun, 0, false);
                }
                catch (Exception ex)
                {
                    // CN 包有一大半是加密的（asset-map.json 里 scrambled=true），
                    // AssetsTools.NET 没有密钥读不了。这里给出干净的错误而不是抛栈。
                    Console.Error.WriteLine("BUNDLE UNREADABLE（加密包？）: " + ex.GetType().Name + " " + ex.Message);
                    return 3;
                }
                AssetFileInfo target = null;
                foreach (var info in inst.file.AssetInfos)
                {
                    if (info.TypeId != Texture2DTypeId) continue;
                    var bf = manager.GetBaseField(inst, info);
                    string name = bf["m_Name"].AsString;
                    if (string.Equals(name, selector, StringComparison.Ordinal) || info.PathId.ToString() == selector) { target = info; targetName = name; break; }
                }
                if (target == null) { Console.Error.WriteLine("no Texture2D matched: " + selector); return 1; }

                var baseField = manager.GetBaseField(inst, target);
                var tf = new TextureFile();
                tf = TextureFile.ReadTextureFile(baseField);
                Console.WriteLine(string.Format("target : {0}  {1}x{2} fmt={3} mips={4}",
                    targetName, tf.m_Width, tf.m_Height, TextureFormatName(tf.m_TextureFormat), tf.m_MipCount));

                tf.m_Width = width;
                tf.m_Height = height;
                tf.m_TextureFormat = (int)TextureFormat.RGBA32;   // 统一成未压缩 RGBA32（不依赖压缩编码器）
                tf.m_MipCount = 1;
                tf.m_MipMap = false;
                tf.SetTextureData(bgra, width, height);
                tf.WriteTo(baseField);

                var assetReplacers = new List<AssetsReplacer> { new AssetsReplacerFromMemory(inst.file, target, baseField) };
                byte[] newAssets;
                using (var ms = new MemoryStream())
                {
                    inst.file.Write(new AssetsFileWriter(ms), 0, assetReplacers, null);
                    newAssets = ms.ToArray();
                }
                var dirInfo = bun.file.BlockAndDirInfo.DirectoryInfos[0];
                var bundleReplacers = new List<BundleReplacer>
                {
                    new BundleReplacerFromMemory(dirInfo.Name, dirInfo.Name, true, newAssets, newAssets.Length, 0)
                };
                WriteBundleCompressed(bun.file, bundleReplacers, outBundle);
                Console.WriteLine("wrote bundle: " + outBundle + " (" + new FileInfo(outBundle).Length + " bytes)");
            }
            finally { manager.UnloadAllBundleFiles(); }

            // 验证：重新读一遍，确认尺寸/格式/像素都对
            var check = new AssetsManager();
            try
            {
                var bun2 = check.LoadBundleFile(outBundle, true);
                var inst2 = check.LoadAssetsFileFromBundle(bun2, 0, false);
                foreach (var info in inst2.file.AssetInfos)
                {
                    if (info.TypeId != Texture2DTypeId) continue;
                    var bf = check.GetBaseField(inst2, info);
                    if (bf["m_Name"].AsString != targetName) continue;
                    var tf2 = new TextureFile();
                    tf2 = TextureFile.ReadTextureFile(bf);
                    byte[] back = tf2.GetTextureData(inst2);
                    bool same = back.Length == bgra.Length;
                    long diff = 0;
                    if (same) for (int i = 0; i < back.Length; i += 997) if (back[i] != bgra[i]) diff++;
                    Console.WriteLine(string.Format("verify : {0} {1}x{2} fmt={3} bytes={4} 抽样不一致={5}",
                        targetName, tf2.m_Width, tf2.m_Height, TextureFormatName(tf2.m_TextureFormat), back.Length, diff));
                    if (tf2.m_Width == width && tf2.m_Height == height && tf2.m_TextureFormat == (int)TextureFormat.RGBA32 && same && diff == 0)
                    {
                        Console.WriteLine("TEXTURE IMPORT VERIFIED");
                        return 0;
                    }
                    Console.Error.WriteLine("VERIFY FAILED");
                    return 1;
                }
                Console.Error.WriteLine("VERIFY FAILED: texture not found in output");
                return 1;
            }
            finally { check.UnloadAllBundleFiles(); }
        }

        // ---------------------------------------------------------------- list

        private static int List(string bundlePath)
        {
            var manager = new AssetsManager();
            try
            {
                var bun = manager.LoadBundleFile(bundlePath, true);
                var dirInfos = bun.file.BlockAndDirInfo.DirectoryInfos;
                Console.WriteLine("bundle      : " + bundlePath);
                Console.WriteLine("bundle bytes: " + new FileInfo(bundlePath).Length);
                Console.WriteLine("files in bundle: " + dirInfos.Length);
                for (int i = 0; i < dirInfos.Length; i++)
                {
                    Console.WriteLine(string.Format("  [{0}] {1}  decompressed={2}", i, dirInfos[i].Name, dirInfos[i].DecompressedSize));
                }

                for (int i = 0; i < dirInfos.Length; i++)
                {
                    var inst = manager.LoadAssetsFileFromBundle(bun, i, false);
                    var file = inst.file;
                    Console.WriteLine();
                    Console.WriteLine(string.Format("--- serialized file [{0}] {1} : {2} assets, unity {3} ---",
                        i, dirInfos[i].Name, file.AssetInfos.Count, file.Metadata.UnityVersion));

                    foreach (var group in file.AssetInfos.GroupBy(x => x.TypeId).OrderByDescending(g => g.Count()))
                    {
                        Console.WriteLine(string.Format("  TypeId {0,-6} count={1}", group.Key, group.Count()));
                    }

                    var textAssets = ReadTextAssets(manager, inst);
                    Console.WriteLine();
                    Console.WriteLine(string.Format("--- TextAssets ({0}) ---", textAssets.Count));
                    foreach (var item in textAssets.OrderBy(t => t.name, StringComparer.Ordinal))
                    {
                        string head = item.text.Length > 0
                            ? item.text.Substring(0, Math.Min(70, item.text.Length)).Replace("\r", " ").Replace("\n", " ")
                            : "";
                        Console.WriteLine(string.Format("  pathId={0,-22} name={1,-42} chars={2,-9} head={3}",
                            item.pathId, item.name, item.text.Length, head));
                    }
                }
                return 0;
            }
            finally
            {
                manager.UnloadAllBundleFiles();
            }
        }

        // ---------------------------------------------------------------- dump

        private static int Dump(string bundlePath, string[] args)
        {
            if (args.Length < 4)
            {
                Console.Error.WriteLine("usage: BundleTool dump <bundle> <textAssetName> <outFile>");
                return 2;
            }
            string selector = args[2];
            string outFile = Path.GetFullPath(args[3]);

            var manager = new AssetsManager();
            try
            {
                BundleFileInstance bun;
                AssetsFileInstance inst;
                try
                {
                    bun = manager.LoadBundleFile(bundlePath, true);
                    inst = manager.LoadAssetsFileFromBundle(bun, 0, false);
                }
                catch (Exception ex)
                {
                    // CN 包有一大半是加密的（asset-map.json 里 scrambled=true），
                    // AssetsTools.NET 没有密钥读不了。这里给出干净的错误而不是抛栈。
                    Console.Error.WriteLine("BUNDLE UNREADABLE（加密包？）: " + ex.GetType().Name + " " + ex.Message);
                    return 3;
                }
                var item = FindTextAsset(manager, inst, selector);
                if (item == null)
                {
                    Console.Error.WriteLine("no TextAsset matched: " + selector);
                    return 1;
                }
                File.WriteAllText(outFile, item.text, new UTF8Encoding(false));
                Console.WriteLine(string.Format("dumped {0} -> {1} ({2} chars, {3} bytes)",
                    item.name, outFile, item.text.Length, new FileInfo(outFile).Length));
                return 0;
            }
            finally
            {
                manager.UnloadAllBundleFiles();
            }
        }

        // ------------------------------------------------------------- replace

        private static int Replace(string bundlePath, string[] args)
        {
            if (args.Length < 5)
            {
                Console.Error.WriteLine("usage: BundleTool replace <bundle> <textAssetName> <inFile> <outBundle>");
                return 2;
            }
            string selector = args[2];
            string inFile = Path.GetFullPath(args[3]);
            string outBundle = Path.GetFullPath(args[4]);

            if (!File.Exists(inFile))
            {
                Console.Error.WriteLine("input file not found: " + inFile);
                return 2;
            }
            if (string.Equals(bundlePath, outBundle, StringComparison.OrdinalIgnoreCase))
            {
                Console.Error.WriteLine("refusing to overwrite the source bundle; pass a different outBundle");
                return 2;
            }

            string replacement = File.ReadAllText(inFile, Encoding.UTF8);
            List<TextAssetEntry> before;

            var manager = new AssetsManager();
            try
            {
                BundleFileInstance bun;
                AssetsFileInstance inst;
                try
                {
                    bun = manager.LoadBundleFile(bundlePath, true);
                    inst = manager.LoadAssetsFileFromBundle(bun, 0, false);
                }
                catch (Exception ex)
                {
                    // CN 包有一大半是加密的（asset-map.json 里 scrambled=true），
                    // AssetsTools.NET 没有密钥读不了。这里给出干净的错误而不是抛栈。
                    Console.Error.WriteLine("BUNDLE UNREADABLE（加密包？）: " + ex.GetType().Name + " " + ex.Message);
                    return 3;
                }

                before = ReadTextAssets(manager, inst);
                var target = before.FirstOrDefault(t =>
                    string.Equals(t.name, selector, StringComparison.Ordinal) || t.pathId.ToString() == selector);
                if (target == null)
                {
                    Console.Error.WriteLine("no TextAsset matched: " + selector);
                    return 1;
                }
                Console.WriteLine(string.Format("target : name={0} pathId={1} oldChars={2} newChars={3}",
                    target.name, target.pathId, target.text.Length, replacement.Length));

                var baseField = manager.GetBaseField(inst, target.info);
                baseField["m_Script"].AsString = replacement;

                var assetReplacers = new List<AssetsReplacer>
                {
                    new AssetsReplacerFromMemory(inst.file, target.info, baseField)
                };

                byte[] newAssets;
                using (var ms = new MemoryStream())
                {
                    inst.file.Write(new AssetsFileWriter(ms), 0, assetReplacers, null);
                    newAssets = ms.ToArray();
                }
                Console.WriteLine("rewrote serialized file: " + newAssets.Length + " bytes");

                var dirInfo = bun.file.BlockAndDirInfo.DirectoryInfos[0];
                var bundleReplacers = new List<BundleReplacer>
                {
                    new BundleReplacerFromMemory(dirInfo.Name, dirInfo.Name, true, newAssets, newAssets.Length, 0)
                };

                WriteBundleCompressed(bun.file, bundleReplacers, outBundle);
                Console.WriteLine("wrote bundle: " + outBundle + " (" + new FileInfo(outBundle).Length + " bytes)");
            }
            finally
            {
                manager.UnloadAllBundleFiles();
            }

            return VerifyRewrite(outBundle, selector, replacement, before);
        }

        // -------------------------------------------------------- replace-many

        // Replaces several TextAssets in one rewrite. A custom card normally needs
        // card.csv + skill_player.csv + skill_role_player.csv updated together; doing
        // them one at a time would rewrite the bundle three times.
        private static int ReplaceMany(string bundlePath, string[] args)
        {
            if (args.Length < 4)
            {
                Console.Error.WriteLine("usage: BundleTool replace-many <bundle> <outBundle> <textAssetName=inFile> [more...]");
                return 2;
            }
            string outBundle = Path.GetFullPath(args[2]);
            var pairs = new List<KeyValuePair<string, string>>();
            for (int i = 3; i < args.Length; i++)
            {
                int eq = args[i].IndexOf('=');
                if (eq <= 0 || eq == args[i].Length - 1)
                {
                    Console.Error.WriteLine("expected <textAssetName=inFile>, got: " + args[i]);
                    return 2;
                }
                string name = args[i].Substring(0, eq);
                string file = Path.GetFullPath(args[i].Substring(eq + 1));
                if (!File.Exists(file))
                {
                    Console.Error.WriteLine("input file not found: " + file);
                    return 2;
                }
                pairs.Add(new KeyValuePair<string, string>(name, file));
            }
            if (string.Equals(bundlePath, outBundle, StringComparison.OrdinalIgnoreCase))
            {
                Console.Error.WriteLine("refusing to overwrite the source bundle; pass a different outBundle");
                return 2;
            }

            List<TextAssetEntry> before;
            var expected = new Dictionary<string, string>(StringComparer.Ordinal);
            var manager = new AssetsManager();
            try
            {
                BundleFileInstance bun;
                AssetsFileInstance inst;
                try
                {
                    bun = manager.LoadBundleFile(bundlePath, true);
                    inst = manager.LoadAssetsFileFromBundle(bun, 0, false);
                }
                catch (Exception ex)
                {
                    // CN 包有一大半是加密的（asset-map.json 里 scrambled=true），
                    // AssetsTools.NET 没有密钥读不了。这里给出干净的错误而不是抛栈。
                    Console.Error.WriteLine("BUNDLE UNREADABLE（加密包？）: " + ex.GetType().Name + " " + ex.Message);
                    return 3;
                }
                before = ReadTextAssets(manager, inst);

                var assetReplacers = new List<AssetsReplacer>();
                foreach (var pair in pairs)
                {
                    var target = before.FirstOrDefault(t => string.Equals(t.name, pair.Key, StringComparison.Ordinal));
                    if (target == null)
                    {
                        Console.Error.WriteLine("no TextAsset named: " + pair.Key);
                        return 1;
                    }
                    string replacement = File.ReadAllText(pair.Value, Encoding.UTF8);
                    expected[pair.Key] = replacement;
                    Console.WriteLine(string.Format("  {0}: {1} -> {2} chars", pair.Key, target.text.Length, replacement.Length));

                    var baseField = manager.GetBaseField(inst, target.info);
                    baseField["m_Script"].AsString = replacement;
                    assetReplacers.Add(new AssetsReplacerFromMemory(inst.file, target.info, baseField));
                }

                byte[] newAssets;
                using (var ms = new MemoryStream())
                {
                    inst.file.Write(new AssetsFileWriter(ms), 0, assetReplacers, null);
                    newAssets = ms.ToArray();
                }

                var dirInfo = bun.file.BlockAndDirInfo.DirectoryInfos[0];
                var bundleReplacers = new List<BundleReplacer>
                {
                    new BundleReplacerFromMemory(dirInfo.Name, dirInfo.Name, true, newAssets, newAssets.Length, 0)
                };
                WriteBundleCompressed(bun.file, bundleReplacers, outBundle);
                Console.WriteLine("wrote bundle: " + outBundle + " (" + new FileInfo(outBundle).Length + " bytes)");
            }
            finally
            {
                manager.UnloadAllBundleFiles();
            }

            // Verify: every requested asset carries the new text, nothing else moved.
            var check = new AssetsManager();
            try
            {
                var bun2 = check.LoadBundleFile(outBundle, true);
                var inst2 = check.LoadAssetsFileFromBundle(bun2, 0, false);
                var after = ReadTextAssets(check, inst2);
                var beforeById = before.ToDictionary(t => t.pathId, t => t);
                var afterById = after.ToDictionary(t => t.pathId, t => t);

                var missing = beforeById.Keys.Except(afterById.Keys).ToList();
                var added = afterById.Keys.Except(beforeById.Keys).ToList();
                var changedNames = beforeById.Keys
                    .Where(k => afterById.ContainsKey(k))
                    .Where(k => !string.Equals(beforeById[k].text, afterById[k].text, StringComparison.Ordinal))
                    .Select(k => beforeById[k].name)
                    .OrderBy(n => n, StringComparer.Ordinal)
                    .ToList();

                int contentOk = 0;
                foreach (var pair in expected)
                {
                    var matches = after.Where(t => string.Equals(t.name, pair.Key, StringComparison.Ordinal)).ToList();
                    if (matches.Count == 1 && string.Equals(matches[0].text, pair.Value, StringComparison.Ordinal))
                    {
                        contentOk++;
                    }
                }

                Console.WriteLine(string.Format("verify : textAssets {0}->{1} missing={2} added={3} changed={4} contentOk={5}/{6}",
                    before.Count, after.Count, missing.Count, added.Count, changedNames.Count, contentOk, expected.Count));
                Console.WriteLine("verify : changed = " + string.Join(", ", changedNames));

                // Every requested asset must now hold the expected text, nothing may be
                // added or removed, and no asset outside the request may have moved.
                var unexpected = changedNames.Where(n => !expected.ContainsKey(n)).ToList();
                if (contentOk == expected.Count && missing.Count == 0 && added.Count == 0 && unexpected.Count == 0)
                {
                    Console.WriteLine("ROUNDTRIP VERIFIED");
                    return 0;
                }
                if (unexpected.Count > 0)
                {
                    Console.Error.WriteLine("VERIFY FAILED: collateral changes: " + string.Join(", ", unexpected));
                }
                else
                {
                    Console.Error.WriteLine("VERIFY FAILED");
                }
                return 1;
            }
            finally
            {
                check.UnloadAllBundleFiles();
            }
        }

        // ----------------------------------------------------------- roundtrip

        private static int Roundtrip(string bundlePath, string[] args)
        {
            if (args.Length < 3)
            {
                Console.Error.WriteLine("usage: BundleTool roundtrip <bundle> <outBundle>");
                return 2;
            }
            string outBundle = Path.GetFullPath(args[2]);
            List<TextAssetEntry> before;

            var manager = new AssetsManager();
            try
            {
                BundleFileInstance bun;
                AssetsFileInstance inst;
                try
                {
                    bun = manager.LoadBundleFile(bundlePath, true);
                    inst = manager.LoadAssetsFileFromBundle(bun, 0, false);
                }
                catch (Exception ex)
                {
                    // CN 包有一大半是加密的（asset-map.json 里 scrambled=true），
                    // AssetsTools.NET 没有密钥读不了。这里给出干净的错误而不是抛栈。
                    Console.Error.WriteLine("BUNDLE UNREADABLE（加密包？）: " + ex.GetType().Name + " " + ex.Message);
                    return 3;
                }
                before = ReadTextAssets(manager, inst);

                byte[] newAssets;
                using (var ms = new MemoryStream())
                {
                    inst.file.Write(new AssetsFileWriter(ms), 0, new List<AssetsReplacer>(), null);
                    newAssets = ms.ToArray();
                }

                var dirInfo = bun.file.BlockAndDirInfo.DirectoryInfos[0];
                var bundleReplacers = new List<BundleReplacer>
                {
                    new BundleReplacerFromMemory(dirInfo.Name, dirInfo.Name, true, newAssets, newAssets.Length, 0)
                };

                WriteBundleCompressed(bun.file, bundleReplacers, outBundle);
                Console.WriteLine(string.Format("rewrote {0} TextAssets -> {1} ({2} bytes)",
                    before.Count, outBundle, new FileInfo(outBundle).Length));
            }
            finally
            {
                manager.UnloadAllBundleFiles();
            }

            return VerifyRewrite(outBundle, null, null, before);
        }

        // -------------------------------------------------------------- verify

        private static int VerifyRewrite(string outBundle, string editedName, string expectedText, List<TextAssetEntry> before)
        {
            var check = new AssetsManager();
            try
            {
                var bun = check.LoadBundleFile(outBundle, true);
                var inst = check.LoadAssetsFileFromBundle(bun, 0, false);
                var after = ReadTextAssets(check, inst);

                // pathId is unique; names are NOT (the bundle contains duplicate TextAsset names).
                var beforeById = before.ToDictionary(t => t.pathId, t => t);
                var afterById = after.ToDictionary(t => t.pathId, t => t);

                var missing = beforeById.Keys.Except(afterById.Keys).ToList();
                var added = afterById.Keys.Except(beforeById.Keys).ToList();
                var changed = beforeById.Keys
                    .Where(k => afterById.ContainsKey(k))
                    .Where(k => !string.Equals(beforeById[k].text, afterById[k].text, StringComparison.Ordinal))
                    .ToList();

                Console.WriteLine(string.Format("verify : textAssets before={0} after={1} missing={2} added={3} changed={4}",
                    before.Count, after.Count, missing.Count, added.Count, changed.Count));
                if (missing.Count > 0) Console.WriteLine("  missing pathIds: " + string.Join(", ", missing.Take(10)));
                if (added.Count > 0) Console.WriteLine("  added pathIds  : " + string.Join(", ", added.Take(10)));

                var duplicateNames = before.GroupBy(t => t.name, StringComparer.Ordinal)
                    .Where(g => g.Count() > 1)
                    .Select(g => g.Key + " x" + g.Count())
                    .ToList();
                if (duplicateNames.Count > 0)
                {
                    Console.WriteLine("  duplicate names: " + string.Join(", ", duplicateNames));
                }

                if (editedName != null)
                {
                    var editedEntries = after.Where(t => string.Equals(t.name, editedName, StringComparison.Ordinal)).ToList();
                    bool contentOk = editedEntries.Count == 1 &&
                                     string.Equals(editedEntries[0].text, expectedText, StringComparison.Ordinal);
                    Console.WriteLine("verify : edited content " + (contentOk ? "OK" : "MISMATCH") +
                        " (matched " + editedEntries.Count + " entry/entries)");
                    var unexpected = changed.Where(k => !beforeById[k].name.Equals(editedName, StringComparison.Ordinal)).ToList();
                    if (unexpected.Count > 0)
                    {
                        Console.Error.WriteLine("VERIFY FAILED: collateral changes on " +
                            string.Join(", ", unexpected.Take(10).Select(k => beforeById[k].name)));
                        return 1;
                    }
                    if (contentOk && missing.Count == 0 && added.Count == 0)
                    {
                        Console.WriteLine("ROUNDTRIP VERIFIED");
                        return 0;
                    }
                    Console.Error.WriteLine("VERIFY FAILED");
                    return 1;
                }

                if (changed.Count > 0)
                {
                    Console.Error.WriteLine("VERIFY FAILED, differing: " +
                        string.Join(", ", changed.Take(20).Select(k => beforeById[k].name)));
                    return 1;
                }
                Console.WriteLine("ROUNDTRIP LOSSLESS");
                return 0;
            }
            finally
            {
                check.UnloadAllBundleFiles();
            }
        }

        private static int Verify(string bundlePath, string[] args)
        {
            if (args.Length < 3)
            {
                Console.Error.WriteLine("usage: BundleTool verify <bundle> <serverResourceSetRoot>");
                return 2;
            }
            string root = Path.GetFullPath(args[2]);

            var index = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var path in Directory.EnumerateFiles(root, "*.csv", SearchOption.AllDirectories))
            {
                index[Path.GetFileName(path)] = path;
            }
            Console.WriteLine("server csv index: " + index.Count + " names");

            var manager = new AssetsManager();
            try
            {
                BundleFileInstance bun;
                AssetsFileInstance inst;
                try
                {
                    bun = manager.LoadBundleFile(bundlePath, true);
                    inst = manager.LoadAssetsFileFromBundle(bun, 0, false);
                }
                catch (Exception ex)
                {
                    // CN 包有一大半是加密的（asset-map.json 里 scrambled=true），
                    // AssetsTools.NET 没有密钥读不了。这里给出干净的错误而不是抛栈。
                    Console.Error.WriteLine("BUNDLE UNREADABLE（加密包？）: " + ex.GetType().Name + " " + ex.Message);
                    return 3;
                }
                var assets = ReadTextAssets(manager, inst);

                int identical = 0, different = 0, noCounterpart = 0;
                foreach (var item in assets.OrderBy(t => t.name, StringComparer.Ordinal))
                {
                    if (!item.name.EndsWith(".csv", StringComparison.OrdinalIgnoreCase))
                    {
                        continue;
                    }
                    if (!index.TryGetValue(item.name, out var serverPath))
                    {
                        noCounterpart++;
                        Console.WriteLine(string.Format("  {0,-34} no server file", item.name));
                        continue;
                    }
                    string serverText = File.ReadAllText(serverPath, Encoding.UTF8);
                    if (string.Equals(serverText, item.text, StringComparison.Ordinal))
                    {
                        identical++;
                    }
                    else
                    {
                        different++;
                        Console.WriteLine(string.Format("  {0,-34} DIFFERENT (client {1} chars / server {2} chars)",
                            item.name, item.text.Length, serverText.Length));
                    }
                }
                Console.WriteLine(string.Format("identical={0} different={1} noServerCounterpart={2}", identical, different, noCounterpart));
                return different == 0 ? 0 : 1;
            }
            finally
            {
                manager.UnloadAllBundleFiles();
            }
        }

        // Write the bundle uncompressed first, then repack with LZ4 so the
        // result stays close to the original size instead of ~7x bloating it.
        private static void WriteBundleCompressed(AssetBundleFile bundle, List<BundleReplacer> replacers, string outBundle)
        {
            string tempPath = outBundle + ".uncompressed.tmp";
            try
            {
                using (var fs = File.Create(tempPath))
                using (var writer = new AssetsFileWriter(fs))
                {
                    bundle.Write(writer, replacers, null);
                }

                using (var reader = new AssetsFileReader(tempPath))
                using (var outStream = File.Create(outBundle))
                using (var writer = new AssetsFileWriter(outStream))
                {
                    var uncompressed = new AssetBundleFile();
                    uncompressed.Read(reader);
                    uncompressed.Pack(uncompressed.Reader, writer, AssetBundleCompressionType.LZ4, false, null);
                    uncompressed.Close();
                }
            }
            finally
            {
                if (File.Exists(tempPath))
                {
                    File.Delete(tempPath);
                }
            }
        }

        // ------------------------------------------------------------- helpers

        private sealed class TextAssetEntry
        {
            public AssetFileInfo info;
            public long pathId;
            public string name;
            public string text;
        }

        private static List<TextAssetEntry> ReadTextAssets(AssetsManager manager, AssetsFileInstance inst)
        {
            var result = new List<TextAssetEntry>();
            foreach (var info in inst.file.AssetInfos)
            {
                if (info.TypeId != TextAssetTypeId)
                {
                    continue;
                }
                try
                {
                    var baseField = manager.GetBaseField(inst, info);
                    result.Add(new TextAssetEntry
                    {
                        info = info,
                        pathId = info.PathId,
                        name = baseField["m_Name"].AsString,
                        text = baseField["m_Script"].AsString
                    });
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine(string.Format("  TextAsset pathId={0} unreadable: {1}", info.PathId, ex.Message));
                }
            }
            return result;
        }

        private static TextAssetEntry FindTextAsset(AssetsManager manager, AssetsFileInstance inst, string selector)
        {
            return ReadTextAssets(manager, inst).FirstOrDefault(t =>
                string.Equals(t.name, selector, StringComparison.Ordinal) ||
                t.pathId.ToString() == selector);
        }
    }
}
