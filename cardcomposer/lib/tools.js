'use strict';
/*
 * tools.js -- 统一的「配套工具在哪 / 游戏包在哪」解析器（可开源版本）。
 *
 * 为什么需要它：开发机上是写死的 `D:\...\tools\bundle-tool\bin\Release\net8.0\BundleTool.exe`，
 * 别人机器上根本不存在。这里按**发行包布局**解析，全部可以用环境变量覆盖：
 *
 *   发行包根/                     ← 本文件在 发行包根/cardcomposer/lib/tools.js
 *   ├── cardcomposer/             （工具本体，node server.js）
 *   └── tools/                    （C# 小工具源码；dotnet build 后产物在各自的 bin/Release/net8.0/）
 *       ├── bundle-tool/bin/Release/net8.0/BundleTool.exe
 *       ├── reseal/bin/Release/net8.0/Reseal.exe
 *       ├── thumb-tool/bin/Release/net8.0/ThumbTool.exe
 *       └── vgmstream/vgmstream-cli.exe      ← 可选，配音试听用（自己下载）
 *
 * 覆盖用的环境变量：
 *   KAIRI_ROOT        发行包根（默认取本文件的 ../..）
 *   KAIRI_TOOLS       配套工具根目录（默认 <KAIRI_ROOT>/tools）
 *   KAIRI_BUNDLE_TOOL / KAIRI_RESEAL / KAIRI_THUMB_TOOL / KAIRI_VGMSTREAM   单个可执行文件
 *   KAIRI_PKG         游戏包目录（kairisei-ma-cn602-server）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = process.env.KAIRI_ROOT || path.join(__dirname, '..', '..');
const TOOLS = process.env.KAIRI_TOOLS || path.join(ROOT, 'tools');

function toolsRoot() { return TOOLS; }
function exe(envName, toolDir, exeName) {
  if (process.env[envName]) return process.env[envName];
  const base = path.join(TOOLS, toolDir, 'bin', 'Release', 'net8.0', exeName);
  return base;
}
function bundleTool() { return exe('KAIRI_BUNDLE_TOOL', 'bundle-tool', 'BundleTool.exe'); }
function reseal() { return exe('KAIRI_RESEAL', 'reseal', 'Reseal.exe'); }
function thumbTool() { return exe('KAIRI_THUMB_TOOL', 'thumb-tool', 'ThumbTool.exe'); }
function vgmstream() {
  if (process.env.KAIRI_VGMSTREAM) return process.env.KAIRI_VGMSTREAM;
  return path.join(TOOLS, 'vgmstream', 'vgmstream-cli.exe');
}
/** 工具在不在？不在就给一句人话提示（别让人对着 ENOENT 发呆） */
function requireExe(p, what) {
  if (!fs.existsSync(p)) {
    throw new Error('找不到 ' + what + '：' + p + '\n' +
      '  → 需要先在 <发行包目录>\\tools\\' + (what === 'BundleTool' ? 'bundle-tool' : what === 'Reseal' ? 'reseal' : 'thumb-tool') +
      ' 里执行 `dotnet build -c Release`；\n' +
      '  → 或者用环境变量指定路径（如 KAIRI_BUNDLE_TOOL）。');
  }
  return p;
}

/** 找一个「像游戏包」的目录：包含 resource-set 子目录 */
function looksLikePackage(dir) {
  try { return !!dir && fs.existsSync(path.join(dir, 'resource-set')); } catch (e) { return false; }
}
/**
 * 猜游戏包目录：KAIRI_PKG → 当前目录/上层若干层 → 上层的 mod/ play/ 子目录。
 * 找不到返回 ''（上层会让用户在界面里选）。
 */
function findPackage(startDir) {
  if (process.env.KAIRI_PKG && looksLikePackage(process.env.KAIRI_PKG)) return process.env.KAIRI_PKG;
  const bases = [];
  let d = path.resolve(startDir || process.cwd());
  for (let i = 0; i < 4 && d; i++) { bases.push(d); const up = path.dirname(d); if (up === d) break; d = up; }
  const names = ['kairisei-ma-cn602-server', 'kairisei-ma-cn602-server', '.'];
  const subs = ['', 'mod', 'play', 'server'];
  for (const b of bases) {
    for (const s of subs) {
      for (const n of names) {
        const cand = path.join(b, s, n);
        if (looksLikePackage(cand)) return cand;
      }
    }
  }
  return process.env.KAIRI_PKG || '';
}

module.exports = { ROOT, TOOLS, toolsRoot, bundleTool, reseal, thumbTool, vgmstream, requireExe, findPackage, looksLikePackage };
