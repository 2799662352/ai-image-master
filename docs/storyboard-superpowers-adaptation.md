# 故事板 Skill 体系 · superpowers 格式适配总览

> 日期:2026-06-22 ｜ 首要 harness:**Codex**(同时兼容 Cursor / Claude Code)
> 计划:`docs/superpowers/plans/2026-06-22-storyboard-skills-superpowers-adaptation-plan.md`

本次把外部参考技能与 updream 精华按 **superpowers** 规范落地进 `temp-ai-image-master-source/resources/plugins/`,采用"引用而非重写"的混合策略,并把全部 catimation 插件的 hook 结构对齐 `obra/superpowers`。

## 一句话:落地了什么

1. **新插件 `catimation-storyboard-pro`** —— 连续性优先的「制片包」生成器(`create-storyboard` skill + `/create-storyboard` 命令)。
2. **新 skill `storyboard-grid-to-seedance`** —— 并入 `catimation-storyboard`,一张图出整套分镜(3×3/4×4/16 格)再喂 Seedance。
3. **updream 4 份 references** —— 9 维分镜表 / 6 款 LUT / Seedance 6 铁律 / 情绪→生理映射,忠实移植入 `storyboard-grid-to-seedance/references/`。
4. **film-studio 集成** —— 新增 `references/continuity-matrices.md`,在 G2/G3/G4.5 门内引用(不重写工艺)。
5. **Codex hook 机制对齐** —— 6 文件 superpowers-exact 结构,新插件 + 回填 5 个旧插件统一。
6. **去 Python 化** —— 制品目录树由 agent 用文件工具确定性创建,不依赖脚本/特定运行时。

## 产物目录

```text
resources/plugins/
├── catimation-storyboard-pro/                 # 新插件
│   ├── .claude-plugin/ .cursor-plugin/ .codex-plugin/   # 三份 plugin.json(codex 带 interface)
│   ├── commands/create-storyboard.md
│   ├── hooks/                                  # 6 文件 superpowers-exact
│   │   ├── run-hook.cmd  hooks.json  hooks-cursor.json
│   │   └── hooks-codex.json  session-start  session-start-codex
│   ├── skills/create-storyboard/{assets,references}/
│   └── README.md
├── catimation-storyboard/
│   ├── skills/storyboard-grid-to-seedance/     # 新 skill(第 29 个)
│   │   ├── SKILL.md
│   │   └── references/{seedance-9dim-shot-table,lut-aesthetics,seedance-6-rules,emotion-physiology}.md
│   └── …(plugin.json/README/commands 已更新到 29)
├── catimation-film/skills/film-studio/
│   └── references/continuity-matrices.md       # 门内校验参考(蒸馏自 create-storyboard)
└── AGENTS.md                                   # 路由总则补两条
```

## Codex hook 机制(superpowers-exact)

每个插件 `hooks/` 6 文件,三 harness 各取所需:

| 文件 | 消费方 | matcher | 调用 |
|------|--------|---------|------|
| `hooks.json` | Claude Code | `startup\|clear\|compact` | `run-hook.cmd session-start` |
| `hooks-cursor.json` | Cursor | — | `./hooks/run-hook.cmd session-start` |
| `hooks-codex.json` | **Codex** | `startup\|resume\|clear` | `run-hook.cmd session-start-codex` |
| `session-start` | cursor/claude/copilot | — | 按 env 三分支输出 |
| `session-start-codex` | **Codex 专用** | — | 固定输出嵌套 `hookSpecificOutput.additionalContext`,不分支 |
| `run-hook.cmd` | 全部 | — | polyglot wrapper(Windows→Git Bash) |

- **Codex 专用脚本**:`session-start-codex` 始终输出 `hookSpecificOutput.additionalContext` 嵌套结构,与 `obra/superpowers` 逐字同构,仅注入串不同。
- 动态注入插件(`catimation-director` 注入 `director-orchestrator` 全文、`catimation-video` 注入 `sd2-pe` 全文)的 codex 脚本复刻了读取+转义+拼装逻辑,注入串与各自 `session-start` 完全一致。
- 校验:6 插件 × `hooks*.json` 全部合法 JSON;5 个回填插件 `session-start-codex` 与 `session-start` 注入串逐一 ctx-MATCH。

## 路由(何时用哪个)

- 一张图出整套分镜 / 网格故事板(3×3/4×4/16 格)→ **`storyboard-grid-to-seedance`**。
- 连续性受控的出片制片包(圣经/衔接矩阵/剪辑边界/双语提示词)→ **`catimation-storyboard-pro` 的 `create-storyboard`**。
- 单镜画面打磨 / 参考图反推 → `catimation-storyboard` 的 `storyboard-*` 技法库。
- 端到端成片(剧本→成片)→ `catimation-film` 的 `film-studio` 编排器。
- 视频提示词最终一律经 **`sd2-pe`** 工程化(总则不变)。

## 从哪开始用

- Codex/Cursor/Claude 安装本市场后,会话开始自动注入引导串。
- 直接 `/create-storyboard <剧本或概念>` 进制片包流程;或 `/storyboard` 写单镜提示词。
- 制片包目录树按 `catimation-storyboard-pro/skills/create-storyboard/assets/production_package_spec.md` 由 agent 自建,无需脚本。

## 溯源

updream 4 份 references 已与源逐份核对,无新增 AI 杜撰段(updream 已知补全段按现状照搬)。源:`reference-projects/updreamskill/seedance-cinematic-drama/skill/references/`。

---

## 追加:updream skill 精华融入现有 skill(2026-06-22)

把 `reference-projects/updreamskill` 中**完整可信**的 skill 精华,以"引用而非新增重复 skill"的方式**融入现有项目 skill**(用 `references/` + 正文 pointer)。**原则**:只移植审计判定完整的内容;被 5000 字截断/抓错 frontmatter 的 skill **不逐字补全**(避免 AI 杜撰,依据 `reference-projects/updreamskill/COMPLETENESS-AUDIT.md`)。

| updream skill | 状态 | 融入目标(现有 skill) | 新增 reference |
|---------------|------|----------------------|----------------|
| `seedance-prompt-filter` + `prompt-optimizer` | 完整 | `storyboard-negative-control` | `references/compliance-filter.md`(9 类敏感检测 + A–G 改写 + 合规输出格式) |
| `video-prompt-optimizer` | 完整 | `storyboard-video-prompt-optimization` | `references/seedance-6module-template.md`(六模块 ≤1900 字成稿骨架) |
| `jimeng-prompt-pro` | 完整 | `seedance-video-craft` | `references/time-allocation-and-multimodal.md`(字/秒切时长 + `@素材` 多模态 ≤12 文件 + 案例) |
| `character-design` | 完整 | `director-character-consistency` | `references/character-design-profiles.md`(编剧/美术/选角三版 + 弧光,美术版映射 anchor) |
| `seedance-cinematic-drama` / `longzeflow` references | 截断但精华已提 | 上一轮已入 `storyboard-grid-to-seedance/references/` | (无新增) |

**已作可选补充融入(三视图放开后):**
- `character-turnaround`(三视图+360转台+六表情模组)、`character-four-view`(四视图合图)—— 本 app **默认**用「单锚点人像库:大头照 + 全身照」,三视图/四视图**作可选补充**(非默认产出,慎用)。两个 skill 已**适配本 app 工具**(`generate_image`/`generate_images`/`generate_video` + 人像库,替换 updream 的 `banana-pro`/`hub.use_tool`/`kling`)融入 `director-character-consistency/references/character-multiview-supplement.md`(含四视图 A-pose+三点布光中英提示词模板),正文加 pointer。
- 其余被 5000 字截断/抓错 frontmatter 的 skill(`scene-multi-angle-generator`、`cinematic-storyboard-writer`、`ai-short-drama-asset-designer-i2`、`storyboard-lighting-kimi`、`auto_novel_writer`、`bootstrap-script`、`aigc-prompt-optimizer-v2` 等)—— 正文不完整,逐字移植=杜撰;其能力均已有本地 analog(见 `reference-projects/updreamskill/LOCAL-ANALOGS.md`)。

落点均为现有 skill 的 `references/` + 正文一行 pointer,**不新增重复 skill、不改既有硬规则**。
