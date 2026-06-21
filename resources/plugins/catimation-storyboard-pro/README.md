# CATIMATION Storyboard Pro

连续性优先的**图生视频制片包生成器**。把剧本/概念做成 SceneDance/Seedance 可用的出片素材包,产出表现得像由导演、分镜师、剪辑师共同准备。

> **定位区分:** 本插件 = **制片包**(整片连续性 + 衔接/剪辑矩阵 + 双语提示词);`catimation-storyboard` = **单镜技法库**(逐镜画面打磨与参考图反推);`catimation-film` 的 `film-studio` = **端到端成片编排器**(会在 G2/G3 调用本 skill)。

## 包含

- **skill** `create-storyboard` —— 标准流程:圣经 → shot cards → 衔接矩阵 → 剪辑边界矩阵 → 中英分离 Image2 提示词 → Seedance 逐镜提示词 → 剪映/CapCut + 风险回退清单。
- **command** `/create-storyboard` —— 一句话触发制片包流程(先过 director-orchestrator,视频提示词经 sd2-pe)。
- **assets** 提示词/制品规格/可填模板;**references** 工作流与平台说明。

## 安装与触发(Codex 优先)

- 本插件已登记在 `resources/plugins/.claude-plugin/marketplace.json`,随市场一键安装到 **Codex / Cursor / Claude Code**。
- **Codex**:`.codex-plugin/plugin.json` 带 `interface` 展示信息;`hooks/hooks-codex.json` 在 SessionStart(`startup|resume|clear`)调专用 `session-start-codex`,注入嵌套 `hookSpecificOutput.additionalContext` 引导串(结构对齐 `obra/superpowers`)。
- 会话开始即注入一段 `<IMPORTANT>` 引导:遇到"制片包/剧本分镜/Seedance 素材"任务时用 Skill 工具加载 `create-storyboard`。
- 命令用法:`/create-storyboard <你的剧本或概念>`。

## 制品(无 Python 依赖)

制片包目录树由 agent 按 `skills/create-storyboard/assets/production_package_spec.md` 用文件工具**确定性创建**,无需任何脚本或特定语言运行时:

```text
storyboard_projects/<project-slug>/
├── 01_script_brief/  02_bibles/  03_storyboard/  04_prompts/
├── 05_images/  06_delivery/  └── final_image_package/
```

## 硬约束

- 每段 SceneDance/Seedance `≤ 15s`;一镜一事一运镜。
- 含文字/网格的整图**不作唯一视频输入**;主输入是干净关键帧。
- 视频提示词最终经 `sd2-pe` 工程化后再生成。
