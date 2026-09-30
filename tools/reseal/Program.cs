using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Reseal
{
    /// <summary>
    /// Recomputes every integrity receipt a kairisei resource-set package carries, so an
    /// edited file is not rejected at startup by Read-ResourceSet.ps1 (or later by the admin
    /// card catalog / CDN export):
    ///
    ///   resource-set/resource-set.json     files[].bytes + files[].sha256 + summary.file_count/bytes
    ///   release-manifest.json              files[] + resource_set_sha256
    ///   cn602-card-runtime-master.json     source.files[] provenance receipts
    ///
    /// Phases are ordered so that a size change in one manifest never leaves another stale:
    ///   A. hash pass            -> results[]
    ///   B. rewrite runtime master (changes its own bytes) -> refresh results[]
    ///   C. write resource-set.json from results[] (files[] + summary in one shot)
    ///   D. write release-manifest.json from results[] + the freshly written resource-set.json
    /// </summary>
    internal static class Program
    {
        private sealed class Entry
        {
            public long Bytes;
            public string Sha;
            public bool ShaReused;
        }

        private static readonly JsonSerializerOptions WriteOptions = new JsonSerializerOptions
        {
            WriteIndented = true,
            Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        };

        private static int Main(string[] args)
        {
            if (args.Length < 1 || args[0].StartsWith("--"))
            {
                Console.Error.WriteLine("usage: Reseal <packageRoot> [--full] [--changed <path>]... [--dry-run]");
                Console.Error.WriteLine();
                Console.Error.WriteLine("  <packageRoot>  directory containing resource-set\\resource-set.json");
                Console.Error.WriteLine("  --full         hash every file (~14 GB) instead of only suspects");
                Console.Error.WriteLine("  --changed P    force-hash a file; P is resource-set-relative or any path suffix");
                Console.Error.WriteLine("  --dry-run      report what would change without writing anything");
                Console.Error.WriteLine();
                Console.Error.WriteLine("Also refreshes asset-map.json bundles[].delivery_crc32 for any patch bundle");
                Console.Error.WriteLine("whose bytes changed - the CN client CRC32-checks every downloaded bundle,");
                Console.Error.WriteLine("so a stale value surfaces as a client patch-data error, not a server error.");
                return 2;
            }

            string root = Path.GetFullPath(args[0]);
            bool full = args.Contains("--full");
            bool dryRun = args.Contains("--dry-run");
            var forced = new List<string>();
            for (int i = 1; i < args.Length; i++)
            {
                if (args[i] == "--changed" && i + 1 < args.Length)
                {
                    forced.Add(Normalize(args[++i]));
                }
            }

            string resourceSetDir = Path.Combine(root, "resource-set");
            string manifestPath = Path.Combine(resourceSetDir, "resource-set.json");
            string releaseManifestPath = Path.Combine(root, "release-manifest.json");
            string masterRel = "_local/control/server/cn602-card-runtime-master.json";
            string masterPath = Path.Combine(resourceSetDir, masterRel.Replace('/', Path.DirectorySeparatorChar));

            if (!File.Exists(manifestPath))
            {
                Console.Error.WriteLine("resource-set.json not found under: " + resourceSetDir);
                return 2;
            }

            var clock = Stopwatch.StartNew();
            var manifestNode = JsonNode.Parse(File.ReadAllText(manifestPath, Encoding.UTF8));
            if (manifestNode?["files"] is not JsonArray filesNode)
            {
                Console.Error.WriteLine("resource-set.json has no files[] array");
                return 2;
            }

            // ---------------------------------------------------------------- inventory
            var actual = new Dictionary<string, FileInfo>(StringComparer.OrdinalIgnoreCase);
            foreach (var path in Directory.EnumerateFiles(resourceSetDir, "*", SearchOption.AllDirectories))
            {
                if (string.Equals(Path.GetFullPath(path), Path.GetFullPath(manifestPath), StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }
                actual[Normalize(Path.GetRelativePath(resourceSetDir, path))] = new FileInfo(path);
            }

            var recorded = new Dictionary<string, JsonNode>(StringComparer.OrdinalIgnoreCase);
            foreach (var item in filesNode)
            {
                string p = item?["path"]?.GetValue<string>();
                if (p != null)
                {
                    recorded[Normalize(p)] = item;
                }
            }

            var entrypointFiles = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            if (manifestNode["entrypoints"] is JsonObject entrypointsNode)
            {
                foreach (var kv in entrypointsNode)
                {
                    string value = kv.Value?.GetValue<string>();
                    if (string.IsNullOrEmpty(value))
                    {
                        continue;
                    }
                    if (File.Exists(Path.Combine(resourceSetDir, value.Replace('/', Path.DirectorySeparatorChar))))
                    {
                        entrypointFiles.Add(Normalize(value));
                    }
                }
            }

            DateTime manifestMtime = File.GetLastWriteTimeUtc(manifestPath);
            Console.WriteLine("package      : " + root);
            Console.WriteLine("on disk      : " + actual.Count + " files under resource-set\\");
            Console.WriteLine("recorded     : " + recorded.Count + " entries in resource-set.json");
            Console.WriteLine("entrypoints  : " + entrypointFiles.Count + " files (hash-verified at startup)");
            Console.WriteLine("mode         : " + (full ? "FULL" : "suspects only") + (dryRun ? " [dry-run]" : ""));
            Console.WriteLine();

            // ------------------------------------------------------- A. hash pass
            var results = new Dictionary<string, Entry>(StringComparer.OrdinalIgnoreCase);
            int hashed = 0, reused = 0, sizeChanged = 0, hashChanged = 0;
            long hashedBytes = 0;
            var additions = new List<string>();
            var hashFailures = new List<string>();

            foreach (var kv in actual.OrderBy(k => k.Key, StringComparer.Ordinal))
            {
                string rel = kv.Key;
                var info = kv.Value;
                bool exists = recorded.TryGetValue(rel, out var old);
                long? oldBytes = TryGetLong(old?["bytes"]);
                string oldSha = old?["sha256"]?.GetValue<string>();

                bool forcedHit = forced.Any(f => rel.Equals(f, StringComparison.OrdinalIgnoreCase) ||
                                                 rel.EndsWith(f, StringComparison.OrdinalIgnoreCase));
                bool needHash = full || forcedHit || entrypointFiles.Contains(rel) ||
                                !exists || oldBytes != info.Length ||
                                string.IsNullOrEmpty(oldSha) || info.LastWriteTimeUtc > manifestMtime;

                string sha;
                bool reusedSha = false;
                if (needHash)
                {
                    sha = HashFile(info.FullName);
                    if (sha == null)
                    {
                        hashFailures.Add(rel);
                        results[rel] = new Entry { Bytes = info.Length, Sha = oldSha, ShaReused = true };
                        continue;
                    }
                    hashed++;
                    hashedBytes += info.Length;
                }
                else
                {
                    sha = oldSha;
                    reusedSha = true;
                    reused++;
                }

                if (!exists) additions.Add(rel);
                if (exists && oldBytes != info.Length) sizeChanged++;
                if (exists && !string.Equals(oldSha, sha, StringComparison.OrdinalIgnoreCase)) hashChanged++;
                results[rel] = new Entry { Bytes = info.Length, Sha = sha, ShaReused = reusedSha };
            }

            var removals = recorded.Keys.Where(k => !actual.ContainsKey(k)).ToList();

            Console.WriteLine(string.Format("hashed       : {0} files ({1:N1} MB) in {2:N1}s", hashed, hashedBytes / 1048576.0, clock.Elapsed.TotalSeconds));
            Console.WriteLine("reused hash  : " + reused + " files");
            Console.WriteLine("size changed : " + sizeChanged);
            Console.WriteLine("hash changed : " + hashChanged);
            if (additions.Count > 0) Console.WriteLine("added        : " + string.Join(", ", additions));
            if (removals.Count > 0) Console.WriteLine("removed      : " + string.Join(", ", removals));
            if (hashFailures.Count > 0) Console.WriteLine("HASH FAILED  : " + string.Join(", ", hashFailures));
            Console.WriteLine();

            // ------------------------------- A2. patch-bundle delivery CRCs
            // The CN client verifies every downloaded bundle against the CRC32 the catalog
            // declares. That value comes from version.dat, unless asset-map.json overrides it
            // via bundles[].delivery_crc32 -- "a validated overlay may declare the CRC of its
            // replacement delivery bytes in the asset map". Editing a bundle without
            // refreshing this makes the client reject the download with a patch-data error
            // ("网络环境不稳定，补丁数据获取失败") even though the server serves it happily.
            if (manifestNode["entrypoints"] is JsonObject entrypointNode)
            {
                string assetMapRel = Normalize(entrypointNode["cn-asset-map"]?.GetValue<string>() ?? "asset-map.json");
                string patchRootRel = Normalize(entrypointNode["cn-patch-root"]?.GetValue<string>() ?? "resources/patch");
                string assetMapPath = Path.Combine(resourceSetDir, assetMapRel.Replace('/', Path.DirectorySeparatorChar));
                string patchRoot = Path.Combine(resourceSetDir, patchRootRel.Replace('/', Path.DirectorySeparatorChar));

                if (File.Exists(assetMapPath) && Directory.Exists(patchRoot) && results.TryGetValue(assetMapRel, out var assetMapEntry))
                {
                    // asset-map.json's own mtime is the reference: we only rewrite it when a CRC
                    // actually changes, so an untouched package never re-hashes 5 GB of bundles.
                    DateTime assetMapMtime = File.GetLastWriteTimeUtc(assetMapPath);
                    var assetMapNode = JsonNode.Parse(File.ReadAllText(assetMapPath, Encoding.UTF8));
                    if (assetMapNode?["bundles"] is JsonArray bundleArray)
                    {
                        int checkedCount = 0, fixedCount = 0;
                        foreach (var bundleNode in bundleArray)
                        {
                            string rel = bundleNode?["bundle"]?.GetValue<string>();
                            if (string.IsNullOrEmpty(rel))
                            {
                                continue;
                            }
                            string bundleFile = Path.Combine(patchRoot, rel.Replace('/', Path.DirectorySeparatorChar));
                            if (!File.Exists(bundleFile))
                            {
                                continue; // the catalog skips bundles that are absent on disk
                            }
                            if (!full && File.GetLastWriteTimeUtc(bundleFile) <= assetMapMtime)
                            {
                                continue;
                            }
                            string declared = bundleNode["delivery_crc32"]?.GetValue<string>();
                            string actualCrc = Crc32Hex(bundleFile);
                            checkedCount++;
                            if (!string.Equals(declared, actualCrc, StringComparison.OrdinalIgnoreCase))
                            {
                                Console.WriteLine(string.Format("  bundle CRC: {0}  {1} -> {2}", rel, declared ?? "(none)", actualCrc));
                                bundleNode["delivery_crc32"] = actualCrc;
                                fixedCount++;
                            }
                        }
                        Console.WriteLine(string.Format("patch bundles: {0} CRC checked, {1} refreshed (root {2})", checkedCount, fixedCount, patchRootRel));
                        if (fixedCount > 0 && !dryRun)
                        {
                            File.WriteAllText(assetMapPath, Serialize(assetMapNode, "\n"), new UTF8Encoding(false));
                            assetMapEntry.Bytes = new FileInfo(assetMapPath).Length;
                            assetMapEntry.Sha = HashFile(assetMapPath);
                            assetMapEntry.ShaReused = false;
                            Console.WriteLine("asset-map.json rewritten: " + assetMapEntry.Bytes + " bytes");
                        }
                    }
                }
            }
            Console.WriteLine();

            // ------------------------------------------- B. runtime master provenance
            bool masterRewritten = false;
            if (File.Exists(masterPath) && results.TryGetValue(Normalize(masterRel), out var masterEntry))
            {
                var masterNode = JsonNode.Parse(File.ReadAllText(masterPath, Encoding.UTF8));
                if (masterNode?["source"]?["files"] is JsonArray provenance)
                {
                    int updated = 0;
                    var missing = new List<string>();
                    foreach (var item in provenance)
                    {
                        string p = item?["path"]?.GetValue<string>();
                        if (p == null)
                        {
                            continue;
                        }
                        string key = Normalize(p);
                        if (!results.TryGetValue(key, out var entry))
                        {
                            missing.Add(key);
                            continue;
                        }
                        if (TryGetLong(item["bytes"]) != entry.Bytes ||
                            !string.Equals(item["sha256"]?.GetValue<string>(), entry.Sha, StringComparison.OrdinalIgnoreCase))
                        {
                            Console.WriteLine(string.Format("  provenance: {0}  {1} -> {2} bytes", key, TryGetLong(item["bytes"]), entry.Bytes));
                            item["bytes"] = entry.Bytes;
                            item["sha256"] = entry.Sha;
                            updated++;
                        }
                    }
                    if (missing.Count > 0)
                    {
                        Console.WriteLine("  provenance paths not present in this package (informational): " + missing.Count);
                    }
                    if (updated > 0)
                    {
                        long before = new FileInfo(masterPath).Length;
                        if (!dryRun)
                        {
                            File.WriteAllText(masterPath, Serialize(masterNode, "\n"), new UTF8Encoding(false));
                            // the master just changed: refresh its own receipt before anything else reads it
                            string masterSha = HashFile(masterPath);
                            masterEntry.Bytes = new FileInfo(masterPath).Length;
                            masterEntry.Sha = masterSha;
                            masterEntry.ShaReused = false;
                            masterRewritten = true;
                            Console.WriteLine(string.Format("runtime master rewritten: {0} entries, {1} -> {2} bytes",
                                updated, before, masterEntry.Bytes));
                            if (masterEntry.Bytes > 16 * 1024 * 1024)
                            {
                                Console.Error.WriteLine("WARNING: runtime master exceeds the 16 MiB server limit (maxCardMasterBytes)");
                            }
                        }
                        else
                        {
                            Console.WriteLine("runtime master: " + updated + " provenance entries would change");
                        }
                    }
                    else
                    {
                        Console.WriteLine("runtime master: provenance already current");
                    }
                }
            }
            Console.WriteLine();

            // ------------------------------------------------ C. resource-set.json
            long totalBytes = 0;
            foreach (var kv in actual)
            {
                totalBytes += results[kv.Key].Bytes;
            }

            foreach (var rel in actual.Keys.OrderBy(k => k, StringComparer.Ordinal))
            {
                var entry = results[rel];
                if (recorded.TryGetValue(rel, out var node))
                {
                    node["bytes"] = entry.Bytes;
                    node["sha256"] = entry.Sha;
                }
                else
                {
                    filesNode.Add(new JsonObject { ["path"] = rel, ["bytes"] = entry.Bytes, ["sha256"] = entry.Sha });
                }
            }
            foreach (var rel in removals)
            {
                filesNode.Remove(recorded[rel]);
            }

            if (manifestNode["summary"] is JsonObject summary)
            {
                Console.WriteLine(string.Format("summary      : file_count {0} -> {1}, bytes {2} -> {3}",
                    TryGetLong(summary["file_count"]), actual.Count, TryGetLong(summary["bytes"]), totalBytes));
                summary["file_count"] = actual.Count;
                summary["bytes"] = totalBytes;
            }

            if (dryRun)
            {
                Console.WriteLine();
                Console.WriteLine("dry-run: nothing written");
                return hashFailures.Count == 0 ? 0 : 1;
            }

            string manifestText = Serialize(manifestNode, "\n");
            File.WriteAllText(manifestPath, manifestText, new UTF8Encoding(false));
            byte[] manifestRaw = File.ReadAllBytes(manifestPath);
            string manifestSha = HashBytes(manifestRaw);
            Console.WriteLine("resource-set.json written: " + manifestRaw.Length + " bytes, sha256=" + manifestSha.Substring(0, 16) + "...");

            // ---------------------------------------------- D. release-manifest.json
            if (File.Exists(releaseManifestPath))
            {
                string releaseOriginal = File.ReadAllText(releaseManifestPath, Encoding.UTF8);
                string newline = releaseOriginal.Contains("\r\n") ? "\r\n" : "\n";
                var releaseNode = JsonNode.Parse(releaseOriginal);
                if (releaseNode?["files"] is JsonArray releaseFiles)
                {
                    var byPath = new Dictionary<string, JsonNode>(StringComparer.OrdinalIgnoreCase);
                    foreach (var item in releaseFiles)
                    {
                        string p = item?["path"]?.GetValue<string>();
                        if (p != null)
                        {
                            byPath[Normalize(p)] = item;
                        }
                    }

                    int upd = 0, add = 0, rem = 0;
                    var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

                    void Upsert(string path, long bytes, string sha)
                    {
                        seen.Add(path);
                        if (byPath.TryGetValue(path, out var node))
                        {
                            if (TryGetLong(node["bytes"]) != bytes ||
                                !string.Equals(node["sha256"]?.GetValue<string>(), sha, StringComparison.OrdinalIgnoreCase))
                            {
                                node["bytes"] = bytes;
                                node["sha256"] = sha;
                                upd++;
                            }
                        }
                        else
                        {
                            releaseFiles.Add(new JsonObject { ["path"] = path, ["bytes"] = bytes, ["sha256"] = sha });
                            add++;
                        }
                    }

                    foreach (var kv in results)
                    {
                        Upsert("resource-set/" + kv.Key, kv.Value.Bytes, kv.Value.Sha);
                    }
                    foreach (var path in Directory.EnumerateFiles(root))
                    {
                        string name = Path.GetFileName(path);
                        if (string.Equals(name, "release-manifest.json", StringComparison.OrdinalIgnoreCase))
                        {
                            continue;
                        }
                        Upsert(name, new FileInfo(path).Length, HashFile(path));
                    }
                    Upsert("resource-set/resource-set.json", manifestRaw.Length, manifestSha);

                    foreach (var pair in byPath)
                    {
                        if (!seen.Contains(pair.Key))
                        {
                            releaseFiles.Remove(pair.Value);
                            rem++;
                        }
                    }

                    releaseNode["resource_set_sha256"] = manifestSha;
                    File.WriteAllText(releaseManifestPath, Serialize(releaseNode, newline), new UTF8Encoding(false));
                    Console.WriteLine(string.Format("release-manifest.json written: files updated={0} added={1} removed={2}, resource_set_sha256={3}...",
                        upd, add, rem, manifestSha.Substring(0, 16)));
                }
            }

            Console.WriteLine();
            Console.WriteLine("RESEAL COMPLETE in " + clock.Elapsed.TotalSeconds.ToString("N1") + "s" +
                              (masterRewritten ? " (runtime master was rewritten)" : ""));
            return hashFailures.Count == 0 ? 0 : 1;
        }

        private static string Serialize(JsonNode node, string newline)
        {
            // JsonNode always emits \n; convert only when the original used CRLF.
            string text = node.ToJsonString(WriteOptions).Replace("\r\n", "\n");
            if (newline == "\r\n")
            {
                text = text.Replace("\n", "\r\n");
            }
            return text + newline;
        }

        private static string Normalize(string path)
        {
            return path.Replace('\\', '/');
        }

        private static long? TryGetLong(JsonNode node)
        {
            if (node == null)
            {
                return null;
            }
            try
            {
                return node.GetValue<long>();
            }
            catch
            {
                return null;
            }
        }

        private static string HashFile(string path)
        {
            try
            {
                using var stream = File.OpenRead(path);
                using var sha = SHA256.Create();
                return Convert.ToHexString(sha.ComputeHash(stream)).ToLowerInvariant();
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("  hash failed for " + path + ": " + ex.Message);
                return null;
            }
        }

        private static string HashBytes(byte[] data)
        {
            using var sha = SHA256.Create();
            return Convert.ToHexString(sha.ComputeHash(data)).ToLowerInvariant();
        }

        private static readonly uint[] Crc32Table = BuildCrc32Table();

        private static uint[] BuildCrc32Table()
        {
            var table = new uint[256];
            for (uint i = 0; i < 256; i++)
            {
                uint c = i;
                for (int k = 0; k < 8; k++)
                {
                    c = ((c & 1) != 0) ? (0xEDB88320u ^ (c >> 1)) : (c >> 1);
                }
                table[i] = c;
            }
            return table;
        }

        /// <summary>Standard CRC-32 (IEEE/zlib), the variant the CN client checks bundles with.</summary>
        private static string Crc32Hex(string path)
        {
            uint crc = 0xFFFFFFFFu;
            var buffer = new byte[1 << 20];
            using var stream = File.OpenRead(path);
            int read;
            while ((read = stream.Read(buffer, 0, buffer.Length)) > 0)
            {
                for (int i = 0; i < read; i++)
                {
                    crc = Crc32Table[(crc ^ buffer[i]) & 0xFF] ^ (crc >> 8);
                }
            }
            return (crc ^ 0xFFFFFFFFu).ToString("X8");
        }
    }
}
