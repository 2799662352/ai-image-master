# CATIMATION Director

导演模式插件。把 **13 个 `director-*` 技法 skill** 编排在一个总调度器之下,以 **13 维电影摄制框架**(物理可复现参数优先于情绪形容词)写出结构化提示词。

## 入口

- **命令 `/director`** — 进入导演总调度流水线。
- **Skill `director-orchestrator`** — 「每次必用」的路由器:只要任务涉及图片/视频/动画/提示词,先过它的 STEP 0 反问与技能路由。
- **SessionStart hook** — 会话开始时自动注入 `director-orchestrator` 全文,确保不会「凭感觉直接写提示词」。

## 包含的 skills(13)

| skill | 用途 |
|---|---|
| director-orchestrator | 总调度路由器(13 维框架 + STEP 0 反问) |
| director-prompt-engineering | 提示词结构(七字段 / 正负向) |
| director-cinematic-composition | 构图、取景、三分法、景深 |
| director-shot-sequence-patterns | 景别、分镜序列、转场、建立镜头 |
| director-narrative-flow | 叙事节奏、镜头顺序 |
| director-scene-analysis-depth | 场景/参考图分析 |
| director-anchor-extraction-quality | 角色锚点提取 |
| director-character-consistency | 角色一致性 |
| director-style-consistency | 风格统一 |
| director-visual-continuity | 连续性、配色一致 |
| director-lighting-continuity | 打光、光源方向一致 |
| director-anime-quality-boost | 日式动画质感/赛璐璐 |
| director-structured-captioning | 结构化反推标注 |

## 安装

通过 CATIMATION 应用「技能商城」→ **🧩 Plugins** 一键安装(托管在腾讯 COS,见仓库根 `README.md`)。

> `plugin.json` 中的 `homepage` / `repository` / `author.url` 仅作元数据展示,COS 应用内安装不读取它们。
