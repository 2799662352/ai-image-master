# CATIMATION Core

CATIMATION 桌面应用的核心集成插件——出图、人像库、创意共创。

## 入口

- **命令 `/gen-image`** — catimation 应用内 `generate_image` / `generate_images`(可选渠道)。
- **命令 `/brainstorm`** — catimation-brainstorm 用 ask_user 卡片定创意方向。
- **SessionStart hook** — 注入核心工具的简短用法提醒。

## 包含的 skills(3)

| skill | 用途 |
|---|---|
| catimation-image | 应用内首选出图工具(渲染进聊天 + 落盘 + 历史 + 附件面板;支持 gpt-image-2-vip / 腾讯 image2 / 万相 2.7 pro 渠道选择) |
| catimation-portrait-library | 自治管理人像库 / 角色锚点 |
| catimation-brainstorm | 开放/高价值创意的 ask_user 卡片共创 |

> 写提示词前先过 `catimation-director` 的 director-orchestrator。
> 经 CATIMATION 应用「技能商城」→ 🧩 Plugins 安装;`plugin.json` 的仓库/作者 URL 仅作展示,COS 安装不读取。
