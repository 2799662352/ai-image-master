# CATIMATION Plugins

把 52 个 AI 图像/视频创作 skill,按 `obra/Superpowers` 的插件市场标准,编排成 **5 个领域插件**。每个插件自带 `skills/ + commands/ + hooks/`,并同时提供 **Claude Code / Cursor / Codex** 三套清单,可一键安装。

## 插件总览

| 插件 | skills | 命令 | 一句话 |
|---|---|---|---|
| **catimation-director** | 13 | `/director` | 13 维电影摄制框架的导演总调度与镜头技法 |
| **catimation-storyboard** | 28 | `/storyboard`、`/reverse-shot` | 单镜画面打磨与参考图/视频反推技法库 |
| **catimation-film** | 4 | `/make-film`、`/write-script`、`/trailer` | 概念→剧本→分镜→出图→出视频→拼接的门控制片流水线 |
| **catimation-video** | 5 | `/sd2`、`/gen-video`、`/edit-video` | **sd2-pe 提示词工程化(总兜底)** + Seedance 出片 + ffmpeg 后期 |
| **catimation-core** | 3 | `/gen-image`、`/brainstorm` | 应用内出图、人像库、创意头脑风暴 |

> 合计 53 个 skill(52 个原始用户 skill 完整拷贝 + 新增骨干 `sd2-pe`)。

## 视频与提示词的总骨干:sd2-pe

`sd2-pe`(Seedance 2.0 Prompt Optimizer)是**生成视频与写提示词的总兜底和起点,一切相关 skill 都围绕它做衍生**:

```
                 sd2-pe  ← 任何视频/提示词需求的起点 + 兜底
                   │  八大要素 · 任务分类 · 素材映射 · 路径A/B 三段论 · 强制兜底包
   ┌───────────────┼───────────────────────────────┐
   │               │                               │
director-orchestrator   seedance-video-craft        storyboard-*
(成套分镜13维定位)    (模型对齐/配额/爆款体检)     (逐镜画面打磨)
   └───────────────┴───────────────┬───────────────┘
                                    ↓
                catimation-video.generate_video → ffmpeg-win 后期
```

- 入口:`/sd2` 直接优化提示词;`/gen-video` 先 sd2-pe 后出片。
- `catimation-video` 的 SessionStart hook 会自动注入 sd2-pe 全文,确保任何视频/提示词工作都从它起步、以它兜底。

## 目录结构

```
catimation-plugins/
├── .claude-plugin/marketplace.json     # 市场清单(列出 5 个插件)
├── README.md
├── AGENTS.md
└── <plugin>/
    ├── .claude-plugin/plugin.json      # Claude Code 清单
    ├── .cursor-plugin/plugin.json      # Cursor 清单(displayName + skills/commands/hooks 路径)
    ├── .codex-plugin/plugin.json       # Codex 专用清单(含 interface 块)
    ├── README.md
    ├── skills/<skill>/SKILL.md         # 拷贝自用户 skill
    ├── commands/<cmd>.md               # 工作流编排命令
    └── hooks/
        ├── hooks.json                  # Claude SessionStart
        ├── hooks-cursor.json           # Cursor sessionStart
        ├── hooks-codex.json            # Codex SessionStart
        ├── run-hook.cmd                # 跨平台 polyglot wrapper(Win/Unix)
        └── session-start               # 注入上下文的 bash 脚本
```

## 三套清单的差异

- **`.claude-plugin/plugin.json`**:基础元数据(name/description/version/author/...)。市场入口在根 `.claude-plugin/marketplace.json`。
- **`.cursor-plugin/plugin.json`**:加 `displayName` 与 `skills`/`commands`/`hooks` 资源路径,hooks 指向 `hooks-cursor.json`。
- **`.codex-plugin/plugin.json`**:Codex 专用,额外带 **`interface` 块**(displayName / shortDescription / longDescription / category / capabilities / defaultPrompt / brandColor / screenshots),hooks 指向 `hooks-codex.json`。

## 安装(应用内市场 / COS)

这些插件通过 **CATIMATION 桌面应用的「技能商城」** 分发,托管在腾讯 COS:

- 打开应用 →「技能商城」→ 顶部 **🧩 Plugins** 分类 → 在插件卡片点 **Get** 一键安装。
- 安装即把该插件捆绑的全部 skill 解压进 `~/.agents/skills/`,应用内 Codex 立即可发现可用;**Update / Uninstall** 同处操作。
- 发布端:`scripts/upload-plugins-to-cos.mjs`(`npm run publish:plugins`);catalog:`plugins/plugins-catalog.json`,zip 文件名内容寻址(`<name>-<version>-<sha8>.zip`)。

> commands/hooks 是 Claude Code / Cursor / Codex CLI 等 IDE harness 的构件,本 app 的 Codex 不消费,故 COS 安装**只落地 `skills/`**。若将来要走 IDE 插件市场分发,把本仓库推到 Git 后,各 harness 按 `.claude-plugin` / `.cursor-plugin` / `.codex-plugin` 清单加载即可。

## 编排关系

```
catimation-film (端到端总编排)
   ├── catimation-director (写镜头前总调度)
   │      └── catimation-storyboard (逐镜技法 / 反推)
   ├── catimation-core (出图)
   └── catimation-video (出视频 + 后期)
```

建议整套一起安装以获得完整流水线。

## 注意

- skill **内容**未改动,仅做了分组拷贝;原始 skill 仍在 `~/.agents/skills` 等位置。
- 各清单里的 `homepage` / `repository` / `author.url` 指向 `zuozuoliang999/catimation-plugins`,仅作元数据展示;**COS 应用内安装不读取这些 URL**(只按 catalog 的 zip 链接下载并 sha256 校验),故无需先推 GitHub 即可分发。
