# CATIMATION Film Studio

端到端 AI 制片插件。坐在所有工艺 skill 之上,负责**顺序、衔接、门控**,把一个想法一条龙做成成片。

## 入口

- **命令 `/make-film`** — film-studio 门控流水线(G0→G8)。
- **命令 `/write-script`** — screenwriter 写剧本/分场/对白。
- **命令 `/trailer`** — trailer-plan-generator 生成预告片方案。
- **SessionStart hook** — 注入制片流水线的简短提醒。

## 包含的 skills(4)

| skill | 用途 |
|---|---|
| film-studio | 端到端制片总编排器(9 道审批门 + 智能路由) |
| screenwriter | 编剧:剧情/分场/对白/节拍/片长(含 templates + tools) |
| trailer-plan-generator | 5 个 90 秒专业预告方案 |
| animation-craft | 动画作画:运动法则/计时节拍/连续性台账/审查 rubric |

## 依赖关系

film-studio 在各阶段会调用其它插件的 skill(`catimation-director`、`catimation-storyboard`、`catimation-video`、`catimation-core`)。建议经 CATIMATION 应用「技能商城」→ 🧩 Plugins 整套一起安装以获得完整流水线。

> `plugin.json` 中的仓库/作者 URL 仅作元数据展示,COS 应用内安装不读取它们。
