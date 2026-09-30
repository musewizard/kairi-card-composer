'use strict';
/*
 * tmp.js -- 工具的临时目录。
 *
 * ★ 为什么不用系统 %TEMP%（2026-09-25 实测）：
 *   由 node 拉起的 .NET 工具（BundleTool / ThumbTool）往 C:\Users\<用户>\AppData\Local\Temp\
 *   写文件会被拒绝（System.UnauthorizedAccessException: Access to the path ... is denied），
 *   而写工作区里的路径完全正常。注入卡牌（重建 container.dat）、导入卡面（导出/导入贴图）、
 *   生成缩略图、造新卡面包都会经过这些临时文件，所以统一放在工作区内。
 *   顺带好处：临时文件可见可清，出问题好排查。
 * 可用环境变量 KAIRI_TMP 覆盖（测试用）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = process.env.KAIRI_TMP || path.join(__dirname, '..', 'tmp');

/** 确保临时目录存在；万一工作区不可写就退回系统临时目录（不让工具直接崩） */
function ensure() {
  try { fs.mkdirSync(DIR, { recursive: true }); return DIR; }
  catch (e) { return os.tmpdir(); }
}
/** 一个临时文件的全路径（不会创建文件） */
function file(prefix, ext) {
  const rnd = Math.random().toString(36).slice(2, 7);
  return path.join(ensure(), prefix + '-' + Date.now() + '-' + rnd + (ext || ''));
}
/** 一个临时子目录（会创建） */
function dir(prefix) {
  const rnd = Math.random().toString(36).slice(2, 8);
  const d = path.join(ensure(), prefix + '-' + rnd);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
/** 删掉临时文件/目录（失败就算了） */
function cleanup(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); }
  catch (e) { try { fs.unlinkSync(p); } catch (e2) { } }
}

module.exports = { DIR, ensure, file, dir, cleanup };

// ★ 关键（2026-09-25 实测）：AssetsTools.NET 内部用 Path.GetTempFileName() 造临时文件，
//   而它**只认 TMP/TEMP 环境变量** —— 在这个会话里指向系统 %TEMP% 会被拒绝
//   （System.UnauthorizedAccessException: Access to the path 'C:\Users\...\Temp\tmpXXXX.tmp' is denied）。
//   所以这里直接把 TMP/TEMP/TMPDIR 指到工作区里：子进程默认继承本进程环境，
//   各处 execFileSync 就不必逐个加 env，BundleTool 内部也能正常写临时文件。
try {
  const d = ensure();
  process.env.TMP = d; process.env.TEMP = d; process.env.TMPDIR = d;
} catch (e) { /* 不改也不影响其它功能 */ }