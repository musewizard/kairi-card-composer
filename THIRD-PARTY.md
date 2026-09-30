# 第三方组件与致谢

本仓库**只包含我们自己写的代码**，不包含任何游戏资源、也不包含下面这些第三方组件的二进制。
你需要自己获取它们（大部分走 NuGet / 官方发布页）。

## 编译/运行需要的

| 组件 | 用途 | 许可 / 来源 |
|---|---|---|
| **.NET 8 SDK** | 编译 `tools\` 下的三个 C# 小工具 | MIT，https://dotnet.microsoft.com/download |
| **Node.js 18+** | 运行 `cardcomposer`（工具本体） | MIT，https://nodejs.org |
| **AssetsTools.NET**<br>**AssetsTools.NET.Texture** | `bundle-tool` 读写游戏 AssetBundle / 解压贴图 | MIT，https://github.com/nesrak1/AssetsTools.NET （NuGet 包同名） |
| **UABEA** | 上面那两个 DLL 的常见来源（本项目**不打包**它们） | 见 https://github.com/nesrak1/UABEA |

> `tools\bundle-tool\BundleTool.csproj` 引用 AssetsTools.NET 的方式见文件里的注释：
> 优先用 NuGet 包；如果你的环境只能用 DLL，把它们放到 `tools\libs\` 并调整 `HintPath`。

## 可选（配音试听功能）

| 组件 | 用途 | 许可 / 来源 |
|---|---|---|
| **vgmstream** | 把游戏里的配音（CRI HCA）解成 wav，供工具「▶ 试听」 | 见 https://github.com/vgmstream/vgmstream （**不打包**，自行下载放到 `tools\vgmstream\`） |

## 关于游戏本体

* 游戏服务端：**[kairisei-ma-ch](https://github.com/kuuhaku1314/kairisei-ma-ch)**（[@kuuhaku1314](https://github.com/kuuhaku1314)）
  —— 本项目是它上面的**周边工具**，与它各自独立授权。
* 《乖离性百万亚瑟王》（乖離性ミリオンアーサー）的名称、素材、数据等权利属于**原版权方**。
  本仓库**不包含**任何游戏资源；使用本工具前请自行确认你手头的服务端/资源来源合法，并自行承担风险。
* 工具会读写你自己那份游戏包里的文件（会先做备份），请在**复制出来的副本**上练习。
