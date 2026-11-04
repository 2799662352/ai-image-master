# NovelAI V5 提示词(nai5-prompting)

**第三方项目,原样收录。** 本目录下 `skills/` 是 [Miint-Sunny/nai5-prompting](https://github.com/Miint-Sunny/nai5-prompting) 的「拆分版」11 个技能,**逐字节取自上游提交,没有任何改动**。

| 项 | 内容 |
|---|---|
| 上游 | https://github.com/Miint-Sunny/nai5-prompting |
| 上游版本 | v1.2.8(提交 `4f6d70e46efaad26204a8125cf20f86f01cfd38f`) |
| 作者 | Miint-Sunny |
| 许可 | **GPL-3.0-only**(每个技能目录下都带完整的 `LICENSE` 与 `NOTICE`) |

## 包含的技能(11)

| 技能 | 用途 |
|---|---|
| `nai5-ideas` | 整体想法、主题、故事种子、开放式的想象方向 |
| `nai5-scene-design` | 场景、地点、环境与情境设计 |
| `nai5-illustration-composition` | 已有想法后的插画构图、画面瞬间、机位、空间关系、光线 |
| `nai5-art-direction` | 情绪 / 象征的视觉表达、美术指导、媒介与风格探索 |
| `nai5-costume-writing` | 已定服装的提示词写法 |
| `oc-costume-design` | 原创角色的服装与衣橱设计 |
| `oc-character-design` | 原创角色的核心、世界关系、行为与视觉身份 |
| `nai5-comic-storyboard` | 漫画故事架构、分页分格、四格叙事、文字分镜 |
| `nai5-comic-writing` | 已定分镜的 NovelAI 漫画 / 四格提示词成稿 |
| `nai5-reverse-prompt` | 看图反推可直接使用的 NovelAI V5 提示词(或只反推其中一部分) |
| `nai5-writing` | 通用语法、字段与预设、普通插画的写法、对已有提示词的精确改词 |

执行时按需读取各技能目录下 `references/` 的参考资料,不会一次性全部载入。

## 为什么没有改动、也不走我们自己的架构审计

- 这些技能内部互相引用(例如 `nai5-writing` ↔ `nai5-costume-writing`),与 CATIMATION 自家技能「入口 → 叶子、单向、限条数」的编排纪律不同。为了过审计去改上游就不再是原样、也跟不上上游更新,还要按 GPL 标注「已修改」。
- 因此仓库里的 `scripts/lib/skill-architecture-validator.mjs` 为 `THIRD_PARTY_PLUGINS` 里的插件放行「正文限长 / 引用环 / 引用条数」三项;**description 长度、宽触发词、冒充生成入口仍然检查**。
- 要升级:从上游取新版本,整个 `skills/` 目录替换,同步改本文件的版本与提交号、三份 `plugin.json` 与 `marketplace.json` 的版本号。**不要手改 `skills/` 下的任何文件。**

## 许可与署名

- 整包按 GPL-3.0-only 分发,版权 © 2026 Miint-Sunny。完整许可见各技能目录下的 `LICENSE`,贡献范围与第三方来源(含对 [Elowwwen/Fanfic-background-assistant](https://github.com/Elowwwen/Fanfic-background-assistant) 方法的改写说明)见 `NOTICE`。**分发时请连同这两份文件一起保留。**
- 本包作为独立的、未修改的技能压缩包经插件商城分发,与 CATIMATION 桌面应用(MIT)是「汇集」关系,并不合并成一个程序;它**不会**被打进桌面安装包(`resources/plugins` 不在安装包范围内,只在用户主动安装时从插件商城下载)。

> 经 CATIMATION 应用「技能商城」→ 🧩 Plugins 安装;`plugin.json` 的仓库 / 作者 URL 仅作展示,COS 安装不读取。
