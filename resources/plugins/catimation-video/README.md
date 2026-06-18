# CATIMATION Video

视频出片与后期插件。**一切围绕 `sd2-pe` 展开**——它是视频与提示词的**总兜底和起点**,其余 skill 都是在它产出的工程化提示词之上做衍生。

## 总骨干:sd2-pe

`sd2-pe`(Seedance 2.0 Prompt Optimizer)把任何想法 / 堆砌形容词的草稿 / 多模态 JSON,重写为符合 Seedance 2.0 语法约定的**工程型指令**:

- **八大要素**:精准主体 + 动作细节 + 场景环境 + 光影色调 + 镜头运镜 + 视觉风格 + 画质 + 约束条件。
- **任务分类**:多模态参考 / 编辑 / 延长 / 组合。
- **路径分流**:路径 A(单段直组)/ 路径 B(总体设定→镜头分镜→风格约束 三段论)。
- **强制兜底**:画质包 + 稳定包 + 水印/Logo 兜底,按场景挂字幕/双胞胎/风格锚定。
- **引用规范**:`@图片N`/`@视频N`/`@音频N`、`<主体N>` 绑定、Asset ID 屏蔽、一镜一运镜、镜头顺序优先于绝对秒数。

> **SessionStart hook 会在会话开始自动注入 sd2-pe 全文**,确保任何视频/提示词工作都从它起步、并以它兜底。

## 入口

- **命令 `/sd2`** — 直接用 sd2-pe 把需求/草稿优化成工程化提示词(总兜底引擎)。
- **命令 `/gen-video`** — 先 sd2-pe 结构化 → 再 Seedance 2.0 出片(`generate_video`)。
- **命令 `/edit-video`** — ffmpeg 剪辑/拼接/字幕/转码。

## 包含的 skills(5)

| skill | 角色 | 用途 |
|---|---|---|
| **sd2-pe** | **总骨干/兜底** | Seedance 2.0 提示词工程化(八大要素 + 路径 A/B + 兜底包) |
| seedance-video-craft | 衍生 | Seedance 2.0 满血版出片实战(模型对齐/配额/爆款体检) |
| catimation-video | 出片 | 应用内 `generate_video`(渲染进聊天并落盘+历史) |
| ffmpeg-win | 后期 | 剪辑/拼接/字幕/调速/转码/硬件加速(经 ffmpeg-win MCP) |
| codex-research-grounded-prompting | 衍生 | 高风险视频/图像提示词的研究驱动写法 |

## 衍生关系

```
sd2-pe (总兜底:工程化提示词骨架)
   ├── director-orchestrator   成套分镜先做 13 维 STEP 0 定位,再回 sd2-pe 路径 B
   ├── seedance-video-craft    模型能力对齐 / 全能参考配额 / 爆款体检
   ├── storyboard-*            逐镜画面打磨(光影/演技/调色/去 AI 味)
   └── storyboard-video-prompt-optimization  在 sd2-pe 结构内精简超长提示词
        ↓
   catimation-video.generate_video  →  ffmpeg-win 后期
```

> 经 CATIMATION 应用「技能商城」→ 🧩 Plugins 安装;`plugin.json` 的仓库/作者 URL 仅作展示,COS 安装不读取。
