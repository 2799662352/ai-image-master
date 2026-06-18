# AGENTS — CATIMATION Plugins

本仓库是把 CATIMATION 创作 skill 编排成的插件市场。给 agent 的工作约定:

## 路由总则

0. **涉及生成视频 / 写视频提示词 → `sd2-pe` 是总兜底和起点**(catimation-video)。任何想法/草稿/多模态 JSON 先经 sd2-pe 走完 Step 0→Step 4(八大要素 + 任务分类 + 素材映射 + 路径 A/B 三段论 + 强制兜底包),其它视频相关 skill 都是在它产出的工程化提示词之上做衍生;落地交 `generate_video`。入口 `/sd2`、`/gen-video`。
1. **涉及图片/视频/动画/提示词 → 先过 `director-orchestrator`**(catimation-director),走完 STEP 0 反问与技能路由再动笔;**若判定为视频,STEP 0 定位后交给 sd2-pe 结构化**。各插件的 SessionStart hook 会提醒这一点。
2. **要做整片(从想法/剧本到成片)→ 用 `/make-film`**(film-studio 门控流水线),它会在各阶段调用其它插件的 skill。
3. **单镜打磨 / 反推参考图 → `/storyboard`、`/reverse-shot`**(catimation-storyboard)。
4. **出图 → `/gen-image`**;**出视频 → `/gen-video`**;**后期 → `/edit-video`**。
5. **方向不明 / 开放创意 → 先 `/brainstorm`**(catimation-core)再收敛。

## 硬约束

- **视频提示词必须经 sd2-pe 兜底**:任何 `generate_video` 调用前,提示词都应是 sd2-pe 工程化产物(含八大要素自检 + 路径 A/B 结构 + 画质/稳定/水印兜底包);引用素材用 `@图片N`/`@视频N`/`@音频N` 与 `<主体N>`,严禁裸写 Asset ID,一镜一运镜,镜头顺序优先于绝对秒数。
- 提示词:**物理可复现参数优先于情绪形容词**;**默认只写正向提示词**;输出**结构化文本而非 JSON**。
- 出图/出视频用 catimation 应用内工具(`generate_image` / `generate_images` / `generate_video`),返回成功即完成,**不要 `view_image` 自检**。
- 角色/场景锚点一旦确定,必须逐字下传到每条 prompt,保证一致性。
- skill 内容只读;需要技法细节就用 Skill 工具加载对应 SKILL.md,不要重写。

## 清单维护

- 改插件元数据:同步更新该插件的 `.claude-plugin` / `.cursor-plugin` / `.codex-plugin` 三份 `plugin.json`。
- 加新插件:更新根 `.claude-plugin/marketplace.json` 的 `plugins[]`。
- 所有 `*.json` 必须是合法 JSON;hooks 的 `run-hook.cmd` 是跨平台 polyglot,勿改其头尾结构。
