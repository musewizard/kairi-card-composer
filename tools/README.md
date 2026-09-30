# tools\ —— 配套的小工具（C#）

`cardcomposer` 本体是 Node.js，但读写游戏包里的 **AssetBundle**、贴图、资源清单这几件事是用这几个
C# 小程序做的。**用之前先编译它们**（各编译一次就行）：

```bat
cd tools\bundle-tool  && dotnet build -c Release
cd ..\reseal          && dotnet build -c Release
cd ..\thumb-tool      && dotnet build -c Release
```

编译产物会出现在各自的 `bin\Release\net8.0\` 下，`cardcomposer` 会**按这个固定位置**去找：

```
tools\bundle-tool\bin\Release\net8.0\BundleTool.exe
tools\reseal\bin\Release\net8.0\Reseal.exe
tools\thumb-tool\bin\Release\net8.0\ThumbTool.exe
```

如果你的产物在别处，用环境变量告诉工具就行：

```bat
set KAIRI_TOOLS=D:\somewhere\tools
set KAIRI_BUNDLE_TOOL=D:\somewhere\BundleTool.exe
set KAIRI_RESEAL=D:\somewhere\Reseal.exe
set KAIRI_THUMB_TOOL=D:\somewhere\ThumbTool.exe
```

## 各项说明

| 工具 | 干什么 |
|---|---|
| `bundle-tool` | 读写游戏 AssetBundle：解包/替换贴图、导出贴图原始像素、把自制卡面打进卡包 |
| `reseal` | 改完资源后**重新签**资源清单（`resource-set.json` / 版本表），不然服务端/客户端不认 |
| `thumb-tool` | 生成卡牌缩略图（160×160 webp） |
| `skill-library` | **可选**：从你自己的游戏包里整理技能目录/中文对照表，生成到 `tools\skill-library\out\`（不跑也能用主工具）：`dotnet run --project tools\skill-library -- <游戏包目录>` |

## ★ 先把 AssetsTools.NET 的 DLL 放好（bundle-tool 必需）

本仓库**不打包**这些 DLL。请从 [UABEA](https://github.com/nesrak1/UABEA) 的目录（或
[AssetsTools.NET](https://github.com/nesrak1/AssetsTools.NET) 的构建产物）里，把这些文件复制到 **`tools\libs\`**：

```
tools\libs\AssetsTools.NET.dll
tools\libs\AssetsTools.NET.Texture.dll
tools\libs\AssetsTools.NET.Cpp2IL.dll        （有就带上）
tools\libs\AssetsTools.NET.MonoCecil.dll     （有就带上）
tools\libs\Mono.Cecil.dll                    （有就带上）
tools\libs\classdata.tpk                     （读类型树要用；没有也能跑，个别功能会报错）
```

然后 `cd tools\bundle-tool && dotnet build -c Release` 就能编译了。
（NuGet 上的 `AssetsTools.NET` 3.0.x **缺少**本工具要用的 `BundleReplacer` 类型，所以不要改用 PackageReference，
除非你确认那个版本里有这个类型。）


## 配音试听用的 vgmstream（可选）

工具里「▶ 试听」配音需要 [vgmstream](https://github.com/vgmstream/vgmstream) 的 `vgmstream-cli.exe`：
下载后放到 `tools\vgmstream\vgmstream-cli.exe`（或用 `KAIRI_VGMSTREAM` 指定路径）。
**本仓库不打包它**；不装的话只是试听按钮不可用，其它功能都正常。
