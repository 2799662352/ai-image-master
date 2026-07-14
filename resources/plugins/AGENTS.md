# AGENTS — CATIMATION Plugins

本仓库是把 CATIMATION 创作 skill 编排成的插件市场。给 agent 的工作约定:

## 路由总则(单入口 + 四级分层)

0. **出图 → `catimation-image` 是唯一图片顶层入口;出视频/让静帧动起来 → `catimation-video` 是唯一视频顶层入口**。入口先把任务分成 快速/标准/专业/制片 四级并维护本回合 routing receipt(`task_level`、`spec_confirmed`、`prompt_engineered`、`qa_completed`、`generation_attempts`),再按预算加载下游 skill。其它任何 skill 不得反向调用入口或重跑分级。
1. **视频提示词工程 → 相关任务自动加载 `sd2-pe`,并必载其结构叶子 `seedance-cinematic-format`**(出片 / 写·改·优化视频提示词 / Seedance 语法问答即载;八大要素、统一三段结构·无「简单视频」降级路径、素材绑定、兜底包 + **每次**输出 12 字段骨架,单镜快速任务也不省,并主动检索核实 2–3 个真实影视参考候选给用户选)。真人/2D/3D profile reference 仍可渐进披露。导演/分镜/技法仍按症状与预算加载,禁止「可能有帮助就全载」。
2. **复杂镜头设计(13 维镜头语言、专业构图打光、参考复刻、跨镜一致性)→ 专业/制片级才加载 `director-orchestrator`**。快速/标准任务不触发;它也不再调用 router 或生成工具。
3. **要做整片(多镜短片/宣传片/成片交付)→ `/make-film`**(film-studio,制片级外壳),按阶段加载所需 skill,每镜生成仍委托 catimation-image / catimation-video。
4. **单镜打磨 / 反推参考图 → `/storyboard`、`/reverse-shot`**;**一张图出网格分镜 → storyboard-grid-to-seedance**;**连续性制片包 → `/create-storyboard`**(catimation-storyboard-pro)。这些产出提示词/制品,生成一律回到入口。
5. **生成结果有具体症状(太假、动作怪、站桩、混脸、风格跑偏)→ 查 `catimation-video-director-router` 症状映射表**,按症状加载对应 craft 修复;它不是生成前置门。
6. **方向不明 / 开放创意 → 先 `/brainstorm`**(catimation-core):用 `ask_user` 弹选项卡与用户定向,定向后交回对应入口按级执行。别自己猜方向。

## 硬约束

- **调用预算**:快速级最多 2 个 skill;标准级最多 3;专业级最多 5;制片级按阶段加载、禁止一次加载全部。超预算必须说明具体风险。
- **规格只确认一次**:画幅/时长/分辨率由入口确认并写入 receipt,下游 skill 不得重复询问;`prompt_engineered=true` 后不得重跑基础提示词工程。
- **视频提示词经 sd2-pe 工艺兜底**:`generate_video` 前提示词应含八大要素自检 + 统一三段结构(总体设定→镜头分镜→风格约束,单镜只减镜头数不降规格) + 画质/稳定/水印兜底包,完整输出 12 字段骨架(字段可增不可减);真人/2D/3D 是可组合媒介 profile,“电影”是检索创作技法的意图词;台词沿用用户或素材语言,不擅自翻译。引用素材用 `@图片N`/`@视频N`/`@音频N` 与 `<主体N>`,严禁裸写 Asset ID,一镜一运镜,镜头顺序优先于绝对秒数。
- 提示词:**物理可复现参数优先于情绪形容词**;**默认只写正向提示词**;输出**结构化文本而非 JSON**。
- **QA 按风险分级,由入口唯一执行**:快速级只确认生成成功与基本参数,不自动抽帧/上传理解模型;人脸手部重点、多人、复杂动作或用户要求检查 → 视觉 QA(抽 3–5 关键帧);多镜剧情/台词口型/剪辑验证/用户明确要审片 → 内容 QA(`understand_video`);正式交付 → 发布 QA(ffprobe + 九宫格 + 平台规格)。自动修正上限 2 次,继续付费重试需用户确认。
- 角色/场景锚点一旦确定,必须逐字下传到每条 prompt,保证一致性。
- skill 内容只读;需要技法细节就用 Skill 工具加载对应 SKILL.md,不要重写。craft/knowledge skill 是叶子:只返回提示词片段或建议,不加载 router/orchestrator/生成工具/QA 工具。
- **跨插件引用一律优雅降级**:入口/编排 skill 引用兄弟插件的 craft skill 时,加载不到就就地应用其原则并继续,**不阻塞、不报错**。完整能力需装全套 6 插件;每个插件单装也能干好自己的核心活(hook 各自独立)。

## 清单维护

- 改插件内容(skill / hook / command / 元数据)→ 一条命令 `npm run publish:marketplace`:自动对齐 4 处版本(marketplace.json + 3 份 plugin.json)、内容变更自动升版、同步单技能市场、审计、发两个 catalog。**不要再手改 3 份 `plugin.json`**(会被自动对齐覆盖)。发布前可先 `npm run publish:marketplace:dry` 看计划。
- 手动指定某插件版本(minor/major)→ 直接改根 `.claude-plugin/marketplace.json` 的 `version`,脚本会尊重并把 3 份 manifest 对齐过去。
- 加新插件:更新根 `.claude-plugin/marketplace.json` 的 `plugins[]`。
- 所有 `*.json` 必须是合法 JSON;hooks 的 `run-hook.cmd` 是跨平台 polyglot,勿改其头尾结构。
- 机制/排障:见 `docs/marketplace-version-consistency.md`。
