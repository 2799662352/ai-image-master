# 商城版本一致性审计与发布纪律（Marketplace Version Consistency）

> 起因：一次改动只更新了 `marketplace.json` 的插件版本，却漏改插件自带的 3 份
> `plugin.json`（`.claude-plugin` / `.cursor-plugin` / `.codex-plugin`），导致
> **版本漂移（version drift）**。本文档记录问题定义、全量审计结果，以及防止复发的发布清单。

## 两条交付通道（务必区分）

| 通道 | 内容源 | 版本清单 | 发布脚本 | 消费者 |
|------|--------|----------|----------|--------|
| **插件市场** | `resources/plugins/<plugin>/`（skills + hooks + commands + 3×manifest） | `resources/plugins/.claude-plugin/marketplace.json` | `scripts/upload-plugins-to-cos.mjs` | app 内插件市场 + 外部 harness（Claude/Cursor/Codex 装插件） |
| **单技能市场** | `resources/codex-skills/<name>/`（SKILL.md + references） | `resources/codex-skills/skill-versions.json` | `scripts/upload-skills-to-cos.mjs` | Codex 单技能安装 |

- 两通道**解耦**、**各有版本清单**，跑脚本即换内容，无需重打包/发 installer。
- 一个**插件**内可含**多个 skill**；同一 skill 可能同时出现在插件里（随插件走）和单技能市场里（curated 单发）。因此改一个 skill 常常要**两条通道都动**。

## 问题定义（两类漂移）

- **P1 · 插件清单漂移**：`marketplace.json` 里某插件的 `version` 与该插件自带的 3 份
  `plugin.json` 的 `version` 不一致。
  - 影响：app 内升级判定读 `marketplace.json`（安装时只解包 `skills/`），**不受影响**；
    外部 harness 读插件自带 `plugin.json`，会显示**与市场不一致的版本号**（外观/一致性问题，非崩溃）。
- **P2 · 单技能市场覆盖/漂移**：某 craft skill 内容变了但 `skill-versions.json` 未升版，
  或应上架单技能市场的 skill 未被 `sync-plugin-skills-to-codex.mjs` 的 `ADD_LIST` 收录。
  - 影响：单技能市场用户拿不到更新，或拿不到该 skill。

## 全量审计结果（2026-07-02）

### P1 — 6 个插件清单版本对齐核查

用脚本读 `marketplace.json` 与每插件 3 份 `plugin.json` 逐一比对：

| 插件 | marketplace.json | claude / cursor / codex | 结果 |
|------|------------------|--------------------------|------|
| catimation-director | 1.0.4 | 1.0.4 / 1.0.4 / 1.0.4 | ✅ |
| catimation-video | 1.0.10 | 1.0.10 / 1.0.10 / 1.0.10 | ✅ |
| catimation-core | 1.0.9 | 1.0.9 / 1.0.9 / 1.0.9 | ✅ |
| catimation-storyboard-pro | 1.0.2 | 1.0.2 / 1.0.2 / 1.0.2 | ✅ |
| **catimation-storyboard** | 1.0.3 | ~~1.0.2~~ → **1.0.3** | ❌→✅ 已修 |
| **catimation-film** | 1.0.4 | ~~1.0.3~~ → **1.0.4** | ❌→✅ 已修 |

- 发现 2 个额外漂移插件（storyboard、film），均为 3 份清单落后 `marketplace.json` 一个补丁号。
- 修复：把 3 份 `plugin.json` 抬到与 `marketplace.json` 一致（**不动** `marketplace.json`，
  因为漂移方向是清单落后于市场；抬清单即可，无需再升市场版本，避免误触发 app 内升级）。
- 修完重跑 `upload-plugins-to-cos.mjs` 重发插件市场，让修正后的清单随 zip 落地到外部 harness。
  6 插件全部重发、`plugins-catalog.json` 已更新。

### P2 — 单技能市场覆盖核查

- `sync-plugin-skills-to-codex.mjs --apply` 报告：47 个 unchanged（与插件内容逐字一致）、
  本轮仅 3 个变动（`catimation-video-director-router` 新增、`director-orchestrator`、
  `codex-research-grounded-prompting` 升版），已发布。
- SKIPPED 的 app-集成型 skill（catimation-image/video/brainstorm/portrait/core/director/
  film/storyboard/storyboard-pro/create-storyboard/trailer-plan-generator）为**有意排除**
  （依赖 app 内工具，单跑无意义）。
- 结论：**单技能市场无遗漏、无内容漂移**。

## 一键发布（推荐，2026-07-02 起）

改完内容后，**只需一条命令**，插件市场 + 单技能市场一起更新，不再手动对齐版本 / 记住多步骤：

```bash
npm run publish:marketplace:dry   # 先看计划：哪些插件会 bump、skill 会同步几个，不写盘不上传
npm run publish:marketplace       # 正式：对齐版本 → 同步 skill → 审计 → 发两个 catalog
```

编排脚本 `scripts/publish-marketplace.mjs` 按序做 4 件事：

1. **VERSION（版本决策，自动）**：`marketplace.json` 是插件版本的**唯一真源**。脚本对每个插件算
   一个**与版本号无关**的内容签名（`scripts/lib/marketplace-versioning.mjs` 里对 3 份
   `plugin.json` 剥掉 `version` 再哈希），与committed 基线 `scripts/plugin-publish-state.json`
   比对：
   - 内容变了、作者没手动升版 → **自动 patch-bump**；
   - 内容变了、作者已手动升版 → 尊重手动版本，不重复 bump；
   - 内容没变 → 保持不动。
   然后把这个版本**自动写回** `marketplace.json` + 该插件 3 份 `plugin.json`。**4 处永远一致，
   漂移在结构上不可能发生**；「忘记 bump」也被自动兜住。
2. **SYNC（同步单技能）**：调 `sync-plugin-skills-to-codex.mjs --apply`，把变动的插件 skill 镜像到
   `resources/codex-skills/`，并自动升 `skill-versions.json`。
3. **AUDIT（审计，正式发布前）**：断言 `marketplace.json` 与每插件 3 份 `plugin.json` 版本全等、
   JSON 合法；不通过则**中止、不上传**。
4. **PUBLISH（发两个 catalog）**：先发插件 catalog，再发单技能 catalog。

> 单元测试：`npm run publish:marketplace:test`（覆盖 `bumpPatch` / `decideVersion` 的 seed /
> unchanged / auto-bump / 手动 bump 不重复 四种分支）。

### 日常用法（改完东西后）

- 改了插件里的 skill / hook / command / manifest → 直接 `npm run publish:marketplace`。
  版本自动 bump + 对齐，两个市场都更新。
- 新 craft skill 想上**单技能市场**（不只随插件走）→ 先把名字加进
  `sync-plugin-skills-to-codex.mjs` 的 `ADD_LIST`，再 `npm run publish:marketplace`。
- 想手动指定某插件版本（如 minor/major）→ 直接改 `marketplace.json` 的 `version`，脚本会尊重它
  （标记为 `manual`），并把 3 份 manifest 对齐过去。

## 底层原理与硬规则（供排障）

- **一个插件 = 4 处版本必须相等**：`marketplace.json` + `.claude-plugin` + `.cursor-plugin`
  + `.codex-plugin`。一键脚本会自动保证；**不要再手改 3 份 manifest**（改了也会被脚本覆盖对齐）。
- 内容变了才升版；内容签名剥掉了 `version` 字段，所以「对齐/升版」本身不会反过来触发「内容变化」误判。
- **基线文件** `scripts/plugin-publish-state.json`（committed）：记录每插件上次发布的内容签名 + 版本。
  删了它会导致下一次全部按 `seed` 处理（不 bump）——若误删，改回来或重新 seed 即可。
- zip 是内容寻址（`-<sha8>`），即便版本没 bump，catalog 也总指向最新内容；版本号只影响 app 内
  「有更新」提示。所以「漏 bump」最坏后果是「有新内容但不弹更新」，而 auto-bump 已消除该风险。

## 解耦与跨插件引用（最佳实践，2026-07-02 审计）

依据官方 `plugin-json-spec.md`（context7 `/openai/codex`）：`plugin.json` 顶层字段为
`name/version/description/author/homepage/repository/license/keywords/skills/hooks/mcpServers/apps/interface`
—— **没有 `dependencies` 字段**。Codex 无插件间依赖机制，所以最佳实践是：**每个插件自包含 +
跨插件增强优雅降级**。

三层解耦现状：

| 层 | 是否解耦 | 说明 |
|----|---------|------|
| **Hook** | ✅ 完全解耦 | 6 个插件各带完整 6 文件 hook 集（`hooks.json`/`-codex`/`-cursor` + `session-start`/`-codex` + `run-hook.cmd`），按各自 `pluginId` 追踪；单装任一插件 hook 都能用。 |
| **插件打包** | ✅ 解耦 | 各插件独立 zip、无跨插件路径引用；`sync-plugin-skills-to-codex.mjs` 对 skill 叶名冲突**硬中止**，无重名。 |
| **Skill 路由/行为** | ⚠️ 有意「软耦合」 | 分层设计：`catimation-director` 的 router/orchestrator、`catimation-video` 的 sd2-pe、`catimation-film` 的 film-studio 会路由到**兄弟插件**的 craft skill。这是运行时「能加载就加载」的建议，不是打包依赖。 |

**规则：跨插件引用一律优雅降级。** 路由/编排 skill 引用兄弟插件 craft skill 时，加载不到（用户没装
该插件）就**就地应用其原则并继续，绝不阻塞/报错**。已写入 `catimation-video-director-router`
的「跨插件优雅降级」段与 `resources/plugins/AGENTS.md` 硬约束。

**推荐安装组合（分层由弱到强）：**

- 只做**应用内出图/头脑风暴** → `catimation-core`（可单装）。
- 要**导演级提示词/13 维编排** → `catimation-director`（+ 建议 `catimation-storyboard` 提供 craft 库）。
- 要**Seedance 出片** → `catimation-video`（sd2-pe 兜底可单干；+ storyboard/director 更强）。
- 要**整片/多镜成片** → `catimation-film` + `catimation-storyboard-pro`（+ 上面全部）。
- **完整威力** → 装全 6 个：core / director / storyboard / storyboard-pro / video / film。

> 每个插件**单装都能干好自己的核心活**（core 出图、director 路由、video 用 sd2-pe 出片、
> storyboard 提供 craft、film 编排），只是跨插件增强需要装上对应兄弟插件。

## 手动 / 分步发布（高级，一般不用）

保留了颗粒化脚本，用于只发单通道或排障：

```bash
npm run publish:plugins        # 只发插件 catalog
npm run publish:skills         # 只发单技能 catalog
node scripts/sync-plugin-skills-to-codex.mjs [--apply]   # 只同步单技能树
```

> 走分步流程时，插件版本对齐要**自己负责**（4 处同步），否则会重新引入 P1 漂移。优先用一键命令。

## 本轮发布产物（2026-07-02）

- 插件市场重发 6 插件：director@1.0.4 / storyboard@1.0.3 / storyboard-pro@1.0.2 /
  film@1.0.4 / video@1.0.10 / core@1.0.9；bundle `catimation-plugins@1.0.0`；
  `plugins-catalog.json`（6 plugins）已更新。
- 单技能市场（本轮此前已发）：新增 `catimation-video-director-router@1.0.0`，
  `director-orchestrator@1.0.5`、`codex-research-grounded-prompting@1.0.2`。
