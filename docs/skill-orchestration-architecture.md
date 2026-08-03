# CATIMATION Skill 编排架构(2026-07 重构版)

本文档描述 2026-07 「减法式重构」后的 Skill 编排架构:图片/视频各自唯一入口、四级任务分层、单向依赖、按风险 QA、单一真源生成链,以及守护这些不变量的回归测试。

## 1. 目标架构

```text
用户请求
   ↓
图片 → catimation-image(唯一图片顶层入口)
视频 → catimation-video(唯一视频顶层入口)
   ↓
入口分级:快速 / 标准 / 专业 / 制片
   ↓
按预算加载少量 craft 叶子(sd2-pe、director-*、storyboard-* 等)
   ↓
generate_image / generate_video
   ↓
入口按风险执行唯一一次 QA
```

核心不变量:

- **唯一入口**:`catimation-image` 与 `catimation-video` 分别独占图片/视频领域的宽泛触发词(生成图片、出视频、让静帧动起来等)。其它任何 skill 的 description 不得再认领这些宽泛入口。
- **单向依赖(DAG)**:入口可以按需加载 craft;craft 是叶子节点,不得反向调用入口、router、orchestrator、生成工具或 QA 工具。正文中只有**反引号**引用的 skill 名才算依赖边,纯文本提及不算。
- **幂等状态**:入口维护本回合 routing receipt——`task_level`、`direction_confirmed`、`spec_confirmed`、`prompt_engineered`、`qa_completed`、`generation_attempts`。下游只读取,不重复执行已完成阶段;规格(画幅/时长/分辨率)整回合只确认一次。
- **身份锚点用户驱动**:大头照+全身照、三视图/四视图/多视图角色板或其它确认
  资产都可作为 `identity-hard`;用户已指定就采用,多套候选拿不准且身份关键时询问,
  仅低风险未指定时使用轻量默认。
- **制片外壳**:`film-studio` 只负责真正的多镜成片项目,按 G0–G8 阶段加载所需 skill,每镜生成仍委托两个入口。

## 2. 四级任务分层与调用预算

| 级别 | 典型请求 | 预算(skill 数) | QA |
|---|---|---|---|
| 快速 | 「让猫眨眼」「生成 5 秒海浪」「画一只猫」 | ≤ 2(入口 + sd2-pe/0) | 快速 QA:确认生成成功、时长/比例/文件存在 |
| 标准 | 单人物表演、简单电影感、明确单图需求 | ≤ 3 | 快速 QA + 症状抽查 |
| 专业 | 武打、多人、参考复刻、复杂运镜、跨图一致性 | ≤ 5(可含 `director-orchestrator`) | 视觉 QA:抽 3–5 关键帧/九宫格 |
| 制片 | 多镜短片、宣传片、完整成片 | 按阶段加载,禁止一次加载全部 | 内容 QA + 发布 QA |

升级条件:检测到多镜、人物表演、复杂动作、角色一致性,或用户明确要求专业制作,才允许升级;超预算加载必须说明具体风险,不能因为「可能有帮助」就加载。

QA 触发(由入口唯一执行,自动修正上限 2 次,继续付费重试需用户确认):

- **快速 QA**:所有任务默认;不自动抽帧、不上传理解模型。
- **视觉 QA**:人脸/手部重点、多人物、复杂动作、用户要求检查、疑似穿帮。
- **内容 QA**(`understand_video`):多镜剧情、台词字幕口型、连续性检查、剪辑验证、用户明确要求审片。
- **发布 QA**:正式交付;ffprobe、编码/分辨率/帧率、音频响度、九宫格、平台规格。

## 3. 角色分工

| Skill | 角色 |
|---|---|
| `catimation-image` / `catimation-video` | 唯一入口 + 任务分级者 + 规格确认 + 生成调用 + QA 升级;预算标记 `pro` |
| `sd2-pe` | Seedance 提示词格式与素材绑定规则,纯工艺叶子;仅简单单镜轻量任务走路径 A,复杂、多镜、混合媒介或需展开导演/作品参考任一命中即走路径 B,且 B 条件优先于生成/编辑/延长/组合等任务类型;两条路径均覆盖八大核心要素、12 项内容与五大必备块,只改变展开程度不降低交付要求;主动出已核实影视参考候选供用户选;“电影”是检索创作技法的意图词 |
| `seedance-cinematic-format` | `sd2-pe` 的**条件结构叶子**:路径 B 加载,路径 A 可跳过;提供 12 项内容定义(标题/分段/散文形式自由)、总体设定/镜头流程/风格与约束三组语义、真人/2D/3D 媒介差异、语言建议、prompt-primary/identity-hard/keyframe-strong/atmosphere-loose/director-free 语义优先级与参考替换规则;使用故事板/多宫格时强制提示词主导前缀;类别 reference 渐进披露;不做入口路由、不调用生成或 QA |
| `director-orchestrator` | 复杂镜头 13 维设计调度器,仅专业/制片级由入口加载;不再「每次必用」,无 STEP -1 强制路由 |
| `catimation-video-director-router` | 症状修复查找表:仅当用户反馈「太假/动作怪/站桩/混脸/风格跑偏」等具体问题时使用;不是生成前置门,fanout 0 |
| `seedance-video-craft` | 复杂 Seedance 任务(多模态参考、多镜叙事、编辑/延长、商业交付)专业知识模块;假定上游已完成基础路由 |
| `animation-craft` | 日式动画运动规律层(timing/中割/张数);按症状加载,无强制前置 |
| `director-*` / `storyboard-*` | 纯专业知识叶子:输入场景与目标,输出提示词片段/建议;不加载任何调度器 |
| `ffmpeg-win` / `catimation-understand` | 检查与处理工具,按 QA 风险触发,不再默认全触发 |
| `film-studio` | 制片级外壳(预算标记 `studio`),按阶段加载 |

description 纪律(验证器强制):≤ 480 字符;禁止 `MUST every time`、`ANY image/video` 类词面;禁止通用模型名单尾巴(sora/veo/kling/… 枚举);专项 skill 触发词只写症状与专门任务,不写「视频/图片/生成」等公共词。

## 4. 单一真源与生成链

```text
resources/plugins/*/skills/<name>/SKILL.md   ← 共享 skill 权威源
resources/first-party-skills/<name>/SKILL.md ← App-only skill 权威源(canvas/understand/director-stage)
        │
        ├─ scripts/generate-first-party-skills.mjs
        │     → src/main/agent/generated/firstPartySkills.generated.ts(应用内首方安装)
        ├─ scripts/sync-top-level-skills.mjs
        │     → skills/(兼容镜像:保留 name/appliesTo/priority 流水线 frontmatter,description+正文跟随权威源)
        └─ scripts/sync-plugin-skills-to-codex.mjs --apply
              → resources/codex-skills/(单技能市场镜像,自动 bump skill-versions.json)
```

改任何插件 skill 后,`npm run publish:marketplace` 会自动跑这三步(dry-run 用 `--check`)。**不要手改镜像/生成物**,验证器会以 `SKILL_COPY_DRIFT` / `FIRST_PARTY_PARITY_MISMATCH` 报警。

插件版本号由发布器按内容哈希计算并回写三份 manifest,`scripts/plugin-publish-state.json` 是单一真源。**手改 `plugin.json` 的 `version` 没有意义**,真发时会被覆盖。

### 4.1 运行时落盘:三条路径,同一个目录

上面是「源码 → 产物」;这一节是「产物 → 用户磁盘」。三条路径**都落到 `~/.agents/skills/<name>/`**,但装进去的内容和后续归谁管完全不同:

| 路径 | 触发时机 | 装什么 | 标记 |
|---|---|---|---|
| **首方安装** `firstPartySkills.ts` | 应用启动 | **只有 `SKILL.md`** | 写 `.catimation-managed`(内容 sha256) |
| **插件安装** 应用内市场 / 外部 harness | 用户装插件 | **整个 skill 目录**(含 `references/`、`assets/`) | 无 |
| **单技能安装** 技能市场 | 用户装单个 skill | **整个目录的 zip**(`upload-skills-to-cos.mjs` 的 `buildSkillZip` 递归打包) | 无 |

两个由此而来的坑:

**① 首方集合只能放单文件 skill。** `writeManaged` 只写 `SKILL.md`,带 `references/` 的 skill 进 `FIRST_PARTY_SKILL_SOURCES` 会变成一堆悬空指针。要让带参考文件的 skill 随应用强制安装,得先扩 installer。

**② 插件安装会夺走首方 skill 的更新权。** `catimation-video` / `catimation-video-workbench` / `ffmpeg-win` 等既在首方集合、又随插件交付。插件安装覆盖同名目录后 `.catimation-managed` 消失,下次开机 `installFirstPartySkills` 判定 `isAppManaged === false`(标记缺失 = 用户手改过),归入 `preserved` 并**永不再更新**。

这不是故障——更新权只是从「随应用版本」转给了「随插件市场」,保持插件最新即可。但要恢复应用托管,得**删掉该 skill 目录再重启应用**(目录不存在时 installer 才会重新写一份带标记的)。排查时看 `~/.agents/skills/<name>/.catimation-managed` 在不在即可判断当前归谁管。

### 4.2 单技能市场的准入规则(标签有误导性)

`sync-plugin-skills-to-codex.mjs` 的判定只有一行:

```js
const allowed = codexNames.has(name) || ADD_LIST.has(name)
```

即「已经在 `resources/codex-skills/` 里」或「在脚本顶部硬编码的 `ADD_LIST` 里」。两者都不是就跳过,输出打的标签是 `⏭️ SKIPPED app-only / not curated`——**这个标签把两种完全不同的情况混在了一起**:

- **刻意排除**:app 集成类 skill(`catimation-image/video/brainstorm/portrait`、`create-storyboard`、`trailer-plan-generator`)离开应用跑不起来,只走插件市场 + 首方安装。
- **只是没登记**:任何新增的插件 skill 默认都会被跳过,因为它既不在 `codex-skills/` 也不在 `ADD_LIST`。

新增 craft skill 想进单技能市场,把名字加进 `ADD_LIST` 即可。判断标准看**对 app 专有工具的依赖**:`storyboard-grid-to-seedance` 对 `generate_image` / `ask_user` / `view_image` 这类工具是 0 引用,所以单装可用;引用了这些工具的 skill 单装时会指向调不到的东西,要么改成能力中性措辞,要么只走插件交付。

`ADD_LIST` 顶部那条注释是硬要求:**引用了别的 skill 的单发 skill,被引用者也必须在单技能市场里**,否则单装会留下悬空的渐进披露指针。

## 5. SessionStart Hook 纪律

- Hook 不得 `cat` 整份 SKILL.md;注入文本上限 2000 字符(验证器 `HOOK_CATS_SKILL` / `HOOK_INJECTION_TOO_LARGE`)。
- 现有 12 个 hook(6 插件 × claude/codex 两分支)注入 582–1821 字符的短指针:入口是谁、四级分层、工具纪律、硬门摘要。
- 跨插件引用一律优雅降级:加载不到兄弟插件的 skill 就就地应用其原则并继续。

## 6. 验证与回归

| 命令 | 作用 |
|---|---|
| `npm run audit:skill-arch` | 全仓审计(139 skill + 36 hook),违规即 exit 1 |
| `npm run test:skill-arch` | 验证器单测 + 仓库架构契约 + sd2-pe/结构叶子契约,共 19 条,node:test |
| `npx vitest run src/main/agent/__tests__/firstPartySkills.test.ts` | 首方生成物与 Markdown 源 parity |
| `node scripts/generate-first-party-skills.mjs --check` | CI 校验生成物未漂移 |
| `node scripts/sync-top-level-skills.mjs --check` | CI 校验顶层镜像未漂移 |

验证器规则代码一览:`IMPLICIT_GENERATION_ENTRY_COLLISION`(入口独占)、`DEPENDENCY_CYCLE`(DFS 环检测)、`BUDGET_FANOUT_EXCEEDED`(fast 1 / standard 3 / pro 7,`<!-- skill-budget: ... -->` 标记,studio 免限;数的是**反引号引用条数**而非同时载入数,pro 的上限随视频入口真实交接对象增长过两次,改动要连同 `BUDGET_LIMITS` 上方注释一起更新)、`CRAFT_FORCED_ORCHESTRATOR_BACK_EDGE`(叶子禁止强制回调调度器)、`DESCRIPTION_TOO_LONG` / `DESCRIPTION_FORBIDDEN_TRIGGER` / `DESCRIPTION_MODEL_LIST_TAIL`、`HOOK_CATS_SKILL` / `HOOK_INJECTION_TOO_LARGE`、`SKILL_COPY_DRIFT` / `FIRST_PARTY_PARITY_MISMATCH`。

语义触发金标(20+ 条 should-trigger / should-not-trigger 场景 + 预期预算级别)在 `tests/skill-architecture/fixtures/trigger-goldens.json`,供发布前模型评测使用;结构测试进 CI。

## 7. 迁移备注(2026-07-10)

- 重构前:12 条依赖环、14 处 fanout 超预算、18 处模型名单尾巴、hook 全文注入 sd2-pe/orchestrator;「生成视频」会命中十余个 skill。
- 重构后:审计 0 违规;普通单镜请求收敛到入口 + sd2-pe 两个 skill;专业/制片场景仍可逐级升级到 orchestrator/film-studio,角色一致性与资产门保留在专业/制片级。
- `catimation-video-director-router` 未删除,降级为症状查找表兼容壳;其分类/套餐逻辑已并入 `catimation-video` 正文。
- 发布状态(2026-07-10):插件/skill 市场已随重构内容发布(6 插件 + 51 单技能,catalog.json 更新);重构与 v4.3.92 版本提交已推送 GitHub main;`npm run release:cn` 已产出安装包并上传 COS,`releases/latest.yml` 指向 4.3.92。
