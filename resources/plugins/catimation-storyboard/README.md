# CATIMATION Storyboard

分镜技法库:**28 个 `storyboard-*` craft skill**,负责单镜画面级的打磨与参考图/视频反推。与 `catimation-director` 配合——成套写镜头先过导演总调度,本库提供逐镜的具体技法。

## 入口

- **命令 `/storyboard`** — 按画面问题路由 storyboard-* 技法写提示词。
- **命令 `/reverse-shot`** — 反推参考图/爆款视频为可复刻提示词。
- **SessionStart hook** — 注入分镜库的简短用法提醒。

## 技法分组(28)

- **光影**:storyboard-light-reconstruction、storyboard-color-grading-control
- **角色**:storyboard-character-acting、storyboard-character-motivation、storyboard-live-character-realism、storyboard-multi-character-control
- **构图/空间**:storyboard-foreground-occlusion、storyboard-pseudo-perspective、storyboard-feature-collapse、storyboard-visual
- **镜头/情绪**:storyboard-structure、storyboard-shot-emotion-matching、storyboard-emotional-montage、storyboard-director-thinking
- **物理/时间**:storyboard-physics、storyboard-time-words、storyboard-kinematic-reverse-engineering
- **风格/控制**:storyboard-style、storyboard-style-extraction-logic、storyboard-negative-control、storyboard-robustness-breaking、storyboard-creative-imagination、storyboard-dodge
- **声音/对白**:storyboard-audio、storyboard-dialogue、storyboard-voice-control
- **反推/优化**:storyboard-scene-breakdown、storyboard-video-prompt-optimization(**sd2-pe 的衍生模块**:在 sd2-pe 结构内做提示词瘦身,见该 skill 的 README)

> 经 CATIMATION 应用「技能商城」→ 🧩 Plugins 安装;`plugin.json` 的仓库/作者 URL 仅作展示,COS 安装不读取。
