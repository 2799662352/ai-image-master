# NovelAI 提示词助手(novelai-assistant)

**第三方项目,原样收录。** 本目录下 `skills/novelai-assistant/` 是 [2332239652/novelai-assistant](https://github.com/2332239652/novelai-assistant)(歌靡Abyss)的内容;收录的是本团队的 fork [2799662352/novelai-assistant](https://github.com/2799662352/novelai-assistant) 的提交 `005ac15`,与上游相比**只有三行措辞调整**(把画师词表的标注改为「NAI V5 通用」,见 `README.md` 与 `SKILL.md`),词表与其余资源未动。

| 项 | 内容 |
|---|---|
| 上游 | https://github.com/2332239652/novelai-assistant(提交 `2e8601b`) |
| 收录的 fork | https://github.com/2799662352/novelai-assistant(提交 `005ac15`) |
| 作者 | 歌靡Abyss |
| 许可 | **MIT**(技能目录下带 `LICENSE`) |

## 包含什么

一个技能 `novelai-assistant`:NovelAI 提示词专家,覆盖 V5 / V4.5 / V4 / NAI3。V5 优先采用自然语言场景描述 + 角色框分工 + 少量标签锚定,另有整页漫画直出、中英日文文字渲染、原生透明背景、评分与 NSFW 标签体系等。

随包资源(都在 `skills/novelai-assistant/` 下,按需读取):

- Danbooru 数据表:`Danbooru-Top-Tags.xlsx`、`Danbooru-Tag-Aliases.xlsx`、`danbooru-cn-reference.xlsx`、`danbooru-characters-full.txt`
- 画师词表:`nai31-artists-full.txt`、`artist-300-styles.txt`、`artist-strings.md`、`v5-confirmed-artist-strings.md`
- 模板与配方:`prompt-templates.md`、`root-curated-recipes.md`、`kr-high-reuse-recipes.md`、`community-recipes.md`、`nai3-template-codex.md`、`manga-page-playbook.md` 等

## 体量说明

`SKILL.md` 正文约 100 KB(远超我们自家技能的 20,000 字符上限),整份载入会占不少上下文。因为是第三方原样收录、不拆分,仓库里的 `scripts/lib/skill-architecture-validator.mjs` 为 `THIRD_PARTY_PLUGINS` 里的插件放行「正文限长」等三项(description、冒充生成入口的检查仍然有效)。如果以后要拆,应当先和上游商量,或者另起一个明确标注为「改编版」的插件,不要直接改这里。

要升级:从 fork 取新提交,整个 `skills/novelai-assistant/` 替换,并同步改本文件的提交号与版本号。**不要手改 `skills/` 下的任何文件。**

> 经 CATIMATION 应用「技能商城」→ 🧩 Plugins 安装;`plugin.json` 的仓库 / 作者 URL 仅作展示,COS 安装不读取。
