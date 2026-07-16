# Seedance 提示词路由与格式契约（2026-07-16）

## 结论

本轮改动以 2026-07-15 发布的 v4.4.0 为底座。开始修改时，当前分支提交
`bbd9387` 是线上 `origin/main@b698e52` 的祖先；两者之间仅有 PR #66 的合并提交
和香港 COS Runner 发布修复，Skill 内容底座一致。`release-v4.3.96` worktree
仍是只读历史参考，不是合并来源。

新版不是回退到旧版，而是在 v4.4.0 基础上明确恢复“轻重路径分流”，同时保留
发布版已经建立的证据边界、素材职责、故事板低约束和风险 QA 规则。

## 最终契约

### 路径 A：轻量连续任务

- 适用：简单、单镜、单一时空内可连续完成的生成、多模态参考、编辑、延长、
  组合等单点任务。
- 编辑、延长、组合只有在仍满足“简单 + 单镜”时才能走 A，任务类型本身不是
  路径判定捷径。
- 内容正文可以连续成文，不强拆 `镜头1 / 镜头2`。
- 可跳过 `seedance-cinematic-format`，由 `sd2-pe` 独立完成。
- “可跳过”只减少 Skill 加载与结构开销，不降低交付要求。

### 路径 B：复杂影视化任务

- 适用：多镜、多事件链、跨空间、混合媒介、复杂导演参考或完整制片。
- B 条件优先于生成 / 编辑 / 延长 / 组合等任务类型；任一命中即进入，明确多镜
  本身就是充分条件。
- 覆盖“总体设定、镜头流程、风格与约束”三组语义内容，但不强制三段、标题、
  顺序或空行，可合并、重排或融入散文。
- 加载 `seedance-cinematic-format`，按需读取真人 / 2D / 3D profile。

### 两条路径共同的硬要求

1. 八大核心要素必须全部覆盖：主体、动作、场景、光影、运镜、风格、画质、约束。
   路径 A 可把后六项压缩成短语或自动补全，但不能省略。
2. 12 项是**内容覆盖清单**，不是固定方括号模板。标题、顺序、空行和散文形式
   自由，只要交付前逐项能找到有效落点。
3. 五大内容块每次必备，可在路径 A 中压缩：
   - 演出核心 + 感情递进
   - 收束方向
   - 品质绝对基准
   - 详细高品质参考
   - 监督演出思考
4. 百分比只表示语义收束方向，不是 API 参数；必须同时写出可执行职责。
5. Skill 写作使用 `@图片N / @视频N / @音频N` 提高素材可见性；本 app 在工具
   边界统一归一为 `图片N / 视频N / 音频N`。`@` 不是上游 API 参数。
6. “空间信息 + 时间信息”是提示词组织框架，不宣称是未经公开证实的模型内部架构。

## 故事板与多宫格

检测到长图、九宫格、故事板或电影美术设定板时，用一次 `ask_user` 让用户选择：

- 拆成单图精确执行（推荐默认）
- 整张作为 `atmosphere-loose` 氛围参考

整板参考必须带“提示词主导 / 氛围板低约束”前缀；身份锚点与干净关键帧优先于
粗糙故事板。用户不回应或要求直出时按推荐路径继续，不阻塞流程。

## 单一真源与生成链

- 权威提示词源：
  `resources/plugins/catimation-video/skills/sd2-pe/SKILL.md`
- 条件结构叶子：
  `resources/plugins/catimation-video/skills/seedance-cinematic-format/`
- 视频顶层入口：
  `resources/plugins/catimation-video/skills/catimation-video/SKILL.md`
- `resources/codex-skills/`、顶层 `skills/` 与
  `src/main/agent/generated/firstPartySkills.generated.ts` 均由脚本生成，不手改。

## 验证与发布

- Skill 架构审计：136 Skills / 36 hooks，0 违规。
- Skill 架构与契约测试：19/19。
- 首方 Skill 安装测试：29/29。
- first-party、top-level、codex marketplace 镜像无漂移。
- `build:vite` 通过。
- Marketplace dry-run 通过。

2026-07-16 已发布：

- 插件：`catimation-video@1.0.23`、`catimation-director@1.0.14`、
  `catimation-storyboard@1.0.11`、`catimation-storyboard-pro@1.0.10`、
  `catimation-film@1.0.11`、`catimation-core@1.0.18`
- 独立 Skill：`sd2-pe@1.0.27`、`seedance-cinematic-format@1.0.14`、
  `director-orchestrator@1.0.13`、`seedance-video-craft@1.0.15`、
  `film-studio@1.0.13`、`storyboard-grid-to-seedance@1.0.7`

客户端需升级到 v4.4.1，因为路径 A 的条件加载规则同时存在于应用内嵌
`catimation-video` 与 SessionStart hook；只发布独立 Skill 不能保证旧客户端
使用一致路由。
