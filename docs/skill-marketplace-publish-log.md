# 技能市场发布记录（Skill Marketplace Publish Log）

记录每次往腾讯云 COS「技能桶」发布/更新 Codex 技能的版本与校验结果。
技能市场与 app 版本**解耦**——单跑发布脚本即可换技能内容，无需重新打包/发 installer。

> 💡 **日常发布用一键命令**：`npm run publish:marketplace`（插件 + 单技能一起更新、自动对齐/升版、
> 审计后发两个 catalog）。原理与排障见 `docs/marketplace-version-consistency.md`。下面的分步命令
> （`publish:skills` 等）仅用于只发单通道或排障。

## 桶与脚本

| 项 | 值 |
|----|----|
| Bucket | `image-master-1345773498`（`ap-guangzhou`，public-read） |
| 技能源 | `resources/codex-skills/<name>/`（`SKILL.md` + 可选 `references/`） |
| 版本清单 | `resources/codex-skills/skill-versions.json`（single source of truth） |
| 发布脚本 | `scripts/upload-skills-to-cos.mjs` |
| catalog | `https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/skills/catalog.json` |

```bash
npm run publish:skills:dry   # 只打包 + 打印 catalog，不上传
npm run publish:skills       # 打包 → sha256 → 上传 zip + catalog.json
```

> ⚠️ **约定**：`SKILL.md` 的 `description` 必须是**单行**。脚本用 `^description:\s*(.+)$`
> 抽取，YAML 折叠块（`>-`）只会被抽到字面量 `>-`，导致 catalog 描述损坏。
> 改了某个技能的 `SKILL.md` / `references/` 后，记得在 `skill-versions.json` 里**升版本号**。

## 发布步骤（新增/更新一个技能）

1. 把技能放到 `resources/codex-skills/<name>/`（`SKILL.md` 单行 description；参考文件进 `references/`，链接写成 `references/xxx.md`）。
2. `skill-versions.json` 里登记 `"<name>": "x.y.z"`。
3. `npm run publish:skills:dry` 核对体积、技能总数、无 `⚠/❌`。
4. `npm run publish:skills` 正式上传（`.env` 需有 `COS_SECRET_ID` / `COS_SECRET_KEY`）。
5. 拉线上 catalog 校验该条目（name/version/size/sha256/url）。

## 校验命令

```powershell
$j = Invoke-RestMethod "https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/skills/catalog.json?t=$(Get-Random)"
$j.skills | Where-Object { $_.name -eq 'ffmpeg-win' } | ConvertTo-Json
"total: $($j.skills.Count)  generatedAt: $($j.generatedAt)"
```

---

## 发布记录

### 2026-06-14 — 新增 `ffmpeg-win` 技能

| 字段 | 值 |
|------|----|
| name | `ffmpeg-win` |
| version | `1.0.0` |
| size | `12526` B（≈12.2 KB） |
| sha256 | `0d07bdce92a32cc798ef0e8f24f217aece4a90b1084425cf743afc9216f2669c` |
| url | `https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/skills/ffmpeg-win-1.0.0.zip` |
| catalog 技能总数 | 42 → **43** |
| catalog generatedAt | 2026-06-14 12:18:19 UTC |
| 校验 | ✅ 线上 catalog 条目一致，description 为单行 |

**内容**：驱动 `ffmpeg-win` MCP 工具（Docker 化 FFmpeg 8.1 + Windows 路径自动转换）的操作手册——转码/缩放/裁剪/变速/压缩/音频/拼接/淡入淡出/叠加/缩略图/GIF/检测，调用约定为 `args` 数组 + 盘符根 `basedir`。`references/` 含 filters/codecs、audio-processing、streaming-hwaccel、platform-export，以及 **catimation-workflow**（竖屏 9:16 适配、拼接 Seedance 片段、加 BGM 人声闪避、封面/压缩/GIF）。

**来源**：知识底料改编自 [jakenuts/ffmpeg-toolkit](https://github.com/jakenuts/agent-skills)，重写为 MCP 工具调用。仓库副本同步在 [`2799662352/ffmpeg-mcp-server`](https://github.com/2799662352/ffmpeg-mcp-server) 的 `.agents/skills/ffmpeg-win/`。

> 注意：该技能驱动的是 `ffmpeg-win` MCP 工具，使用方需在自己的 MCP 配置里接上对应 server（即 `ffmpeg-mcp-server`）才能真正调用。app 内置 agent 默认未接 ffmpeg MCP。

> 未发布 `ffmpeg-toolkit`（jakenuts 原版假设本地 `ffmpeg` 二进制，在 app 内 agent 环境跑不了，仅作为仓库参考底料保留）。

### 2026-06-15 — 新增 `screenwriter` + `seedance-video-craft` 两个技能

| 字段 | `screenwriter` | `seedance-video-craft` |
|------|----------------|------------------------|
| version | `1.0.0` | `1.0.0` |
| size | `27761` B（≈27.1 KB） | `14355` B（≈14.0 KB） |
| sha256 | `8de374db2369…` | `d8af28be3c53…` |
| url | `…/skills/screenwriter-1.0.0.zip` | `…/skills/seedance-video-craft-1.0.0.zip` |
| catalog 技能总数 | 43 → **45** | — |
| 校验 | ✅ 下载 zip 重算 sha256 == catalog | ✅ 下载 zip 重算 sha256 == catalog |

**`screenwriter`（编剧/剧作)**：纯方法论工艺型 skill,基于 McKee《故事》+ Campbell《千面英雄》+ Aristotle《诗学》,产出好莱坞格式剧本、支持双语剧本、按因果链/价值流审结构。`references/` 含 methodology / style-rules / workflow / timing-and-cutting / README;`templates/` 含 synopsis / characters / worldbuilding / treatment;`tools/` 含 3 个可选 `.docx` 生成器 + `package.json`。
- **来源**:改编自一个俄语本地 skill `screenwriter(1)`。已**改名**(去 `(1)`,与 frontmatter `name` 一致)、**全文译为中文 + description 中英双语触发词**、并**解耦 .docx 工具**(去掉 `NODE_PATH=/usr/local/...` 硬编码与 `mcp__cowork__create_artifact` 依赖,改为 `cd tools && npm install docx` 后本机 `node` 运行)。

**`seedance-video-craft`(Seedance 2.0 出片实战)**:模型对齐 + 出片编排 + 爆款体检层,坐在 `storyboard-*`/`director-*` 工艺 skill 之上。`references/` 含 seedance-2.0-capabilities / all-around-reference / prompt-engineering / virality-scorecard / ad-short-form-modes。
- **理论基础**:字节 Seedance 2.0 技术报告《Advancing Video Generation for World Complexity》(arXiv 2604.14148)+ Seed2.0 Model Card(统一多模态音视频联合生成、4–15s、480p/720p、最多 9 图/3 视频/3 音频参考、原生音频+口型 8+ 语言、主体控制/运动操控/风格迁移/视频延长)。**仅用 2.0,不含 1.0/1.5pro。**
- **写法借鉴**:Higgsfield AI 开源 skills(`higgsfield-ai/skills`)的 Marketing Studio 模式分类 与 Virality Predictor(`brain_activity`)爆款打分维度——但**不依赖 Higgsfield CLI**,是模型无关方法论,落到 app 内置 Seedance 2.0 工具上。
- 与 app 默认一致:全能参考(9 图/3 视频/3 音频)、时长 4–15s、默认 720p、默认满血版 2.0。

### 2026-07-03 — 运镜知识库(`search_cinematography_kb`)接入 skill/hook,随 app v4.3.75 发布

一键 `npm run publish:marketplace` 自动升版并发布(内容签名比对触发)。**插件**升版 4 个、**单技能**升版 6 个,双 catalog 已上线并审计通过(marketplace.json == 3 份 manifest)。

| 通道 | 升版条目 |
|------|----------|
| 插件 `plugins-catalog.json` | `catimation-director` 1.0.6、`catimation-storyboard` 1.0.4、`catimation-video` 1.0.12、`catimation-core` 1.0.10 |
| 单技能 `catalog.json`(51 项) | `director-orchestrator` 1.0.6、`director-cinematic-composition` 1.0.4、`director-shot-sequence-patterns` 1.0.4、`sd2-pe` 1.0.4、`seedance-video-craft` 1.0.8、`storyboard-video-prompt-optimization` 1.0.5 |

**内容**:把「运镜与结构化描述库」(阿里百炼 RAG)接入 `director-orchestrator`(总调度,库优先于联网)、`catimation-core` 全局 session-start hook、以及 `sd2-pe` / `storyboard-video-prompt-optimization` / `director-cinematic-composition` / `director-shot-sequence-patterns` / `seedance-video-craft` 等运镜相关 skill——写运镜/景别/机位/构图/结构化镜头描述前先调 `search_cinematography_kb`。首方 skill `catimation-video`/`catimation-image` 的同类指针随 app installer/热更新下发(不走市场)。所有指针条件式:工具不可用/未配 `DASHSCOPE_API_KEY` 时静默退回联网检索。

- catalog:`https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/plugins/plugins-catalog.json` / `…/skills/catalog.json`
- 校验:发布脚本内置 sha256 内容寻址 + 对齐审计,发布日志见上方脚本输出。

### 2026-07-23 — `catimation-core` 1.0.21(Seedream 5.0 出图指引 + 音频链路),随 app v4.4.9 发版同日发布

一键 `npm run publish:marketplace` 自动升版并发布(内容签名比对触发)。本次差异极小:
**仅 `catimation-core` 1.0.20 → 1.0.21**,其余 5 个插件与全部 51 个单技能内容无变化
(单技能通道 ADD 0 / CHANGED 0,catalog 仅刷新 generatedAt)。

| 通道 | 升版条目 |
|------|----------|
| 插件 `plugins-catalog.json`(6 插件) | `catimation-core` 1.0.21(28.4 KB,4 skills + 2 cmds) |
| 单技能 `catalog.json`(52 项) | 无升版,仅重建 catalog |

**内容**:`catimation-image` SKILL.md 补齐 **Seedream 5.0 Pro 出图渠道指引**(对应 app
v4.4.5 接入)与**音频生成链路配套说明**(对应 v4.4.6 `generate_audio`/`catimation-audio`),
`commands/gen-image.md` 同步微调。共 5 文件、+25/−15 行(见 commit `6e96cd4`、`937cd6e`)。

- 版本状态回写:PR #101(3 份 plugin.json + marketplace.json + plugin-publish-state.json +
  skill-versions.json),CI 全绿后合入 main。
- 排障备忘:git worktree 不共享 untracked 的 `.env`,在新 worktree 真发前需从主 checkout
  复制 `.env`(含 `COS_SECRET_ID/KEY`),否则发布器在「Publish plugin catalog」步骤报缺密钥中止
  (dry-run 不受影响)。
