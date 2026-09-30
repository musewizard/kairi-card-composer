# 乖离性百万亚瑟王（第三方社区服务端）卡牌制作工具

一个给 **《乖离性百万亚瑟王》第三方社区服务端** 用的**卡牌自定义工具**：不用写代码，从游戏包里读真实数据，
自己造新卡 / 拼技能 / 换卡面 / 写台词配音，再写回游戏包。

> ⚠️ **仍在开发中，功能与稳定性都在完善。** 请先拿**副本**练手，别拿正在玩的包试。
> 工具**不会**给你整包备份（只在关掉 Live2D、删掉自作卡面时留副本）—— **动手前请自己复制一份游戏包**。
>
> 本项目是基于 **[@kuuhaku1314](https://github.com/kuuhaku1314) 的 [kairisei-ma-ch](https://github.com/kuuhaku1314/kairisei-ma-ch)**
> （《乖离性百万亚瑟王》第三方社区服务端）**二次开发的周边工具** —— 游戏服务端本体、资源包、客户端都不在本仓库里，
> 本仓库也不包含任何游戏资源，你需要自己先有那套服务端并遵守它自己的许可。
>
> 💡 **关于这个项目**：它是一个 **vibe coding** 作品 —— 作者不是专业程序员，代码主要是和 AI 一起讨论着写出来的。
> 所以**功能更新和修 bug 的节奏可能比较慢**，部分实现也还比较朴素，还望见谅；欢迎提 Issue 或 PR 一起完善。

---

## 能做什么

| 功能 | 说明 |
|---|---|
| **克隆改卡** | 挑一张同职业同稀有度的官方卡当模板，改名字/数值/费用/稀有度，生成一张全新的卡 |
| **拼技能** | 用「效果块」拼覚醒技：伤害/回复/增益/减益/抽牌/各类特殊效果，可选目标、可加**条件变体**（比如满足条件单体变 AOE） |
| **自动生成通常技** | 通常技是其他三个职业看到的弱化版。默认自动从覚醒技的**第 1 段效果块**缩出一份（可调弱化系数） |
| **自定义卡面** | 导入自己的图片，带取景框、透明背景去除；Live2D 卡也能强制做成静态卡面 |
| **台词与配音** | 写卡牌台词（支持 `<br>` 换行）；配音可以**借用**游戏里任意一句现成配音（1 万多个 ID，能直接 ▶ 试听）。⚠️ **自己替换配音音频文件的功能未完成，请勿使用** |
| **卡牌方案库** | 写过的卡自动记住，能列表加载、导出成文件分享给别人、导入别人的方案（自动去重） |
| **写包但不包票** | 注入前可以「干跑」先看一遍要写什么；关 Live2D / 删自作卡面时会留副本。**但不会整包备份**，请自己先复制游戏包 |

## 快速开始

```bat
:: 1) 需要 Node.js（20 LTS 或更新）和 .NET 8 SDK
:: 2) ★ 先把 AssetsTools.NET 的 DLL 放进 tools\libs\（bundle-tool 必需，见 tools\README.md）
:: 3) 编译配套的 C# 工具（三个小工具）
cd tools\bundle-tool  && dotnet build -c Release
cd ..\reseal          && dotnet build -c Release
cd ..\thumb-tool      && dotnet build -c Release

:: 4) 启动制作工具
cd ..\..\cardcomposer
node server.js
:: 然后浏览器打开 http://127.0.0.1:8788
```

第一次打开会让你**选择游戏包目录**（就是那个 `kairisei-ma-cn602-server` 文件夹，里面要有 `resource-set\`）。
选好后工具会自己校验，选错了会用人话提示你。

详细步骤看 **[使用教程.md](使用教程.md)**。

## 目录结构

```
cardcomposer\          卡牌制作工具本体（Node.js）
  server.js            本地服务端（监听 8788，页面 + 接口都在这）
  lib\                 各个功能模块（读包/写包/拼技能/卡面/缩略图/方案库/配音索引…）
  web\index.html       全部界面（一个文件，原生 JS）
  test\                测试（node test\test-xxx.js）
tools\
  bundle-tool\         读写游戏 AssetBundle 的小工具（C#）
  reseal\              重新签资源清单/版本（C#）
  thumb-tool\          生成卡牌缩略图（C#）
  skill-library\       从游戏数据里整理技能目录/参考表（C#）
```

## 已知问题 / 注意

* **部分机制还在摸索**：比如多条台词的完整用途、部分特殊效果；界面上会明确标「推测」的地方就是还没完全确定。
* 只有 **Windows** 上验证过。
* 工具会**直接改你的游戏包**（会先备份），务必先在自己复制出来的包上练手。
* 需要你自备游戏服务端（见上面 kairisei-ma-ch 链接），本仓库不含任何游戏资源。

## ⚠️ 未完成的功能

* ⚠️ **自定义 / 替换配音音频文件的功能未完成，请勿使用**（只做到了「借用现成配音 + 试听」）。 工具里只给了「要什么格式」的说明，写入链路没做完。

## 许可

本项目代码使用 **MIT 许可**（见 [LICENSE](LICENSE)）。
用到的第三方组件（AssetsTools.NET 等）见 [THIRD-PARTY.md](THIRD-PARTY.md)。
**游戏本体、服务端、资源与素材的权利属于原项目与原版权方**，与本仓库无关。

## 致谢

* 游戏服务端：[kairisei-ma-ch](https://github.com/kuuhaku1314/kairisei-ma-ch)（[@kuuhaku1314](https://github.com/kuuhaku1314)）
* AssetBundle 读写：[AssetsTools.NET](https://github.com/nesrak1/AssetsTools.NET) / [UABEA](https://github.com/nesrak1/UABEA)
* 音频解码（配音试听）：[vgmstream](https://github.com/vgmstream/vgmstream)
