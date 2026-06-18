# Screenwriter Skill — 快速上手

通用的「编剧工具型」skill,不绑定具体故事。纯方法论,无外部 API。可在 Codex / CATIMATION / Claude / Claude Code 等任意 agent 环境中作为「技能文件夹」使用。

---

## 里面有什么

- **`SKILL.md`** — skill 主描述(最先读)。
- **`references/methodology.md`** — McKee + Campbell + Aristotle。
- **`references/style-rules.md`** — 好莱坞格式写作规则。
- **`references/workflow.md`** — 与用户协作的工作模式。
- **`references/timing-and-cutting.md`** — 银幕时长估算与删减。
- **`templates/`** — 给你故事用的空白模板。
- **`tools/`** — `.docx` 生成器(剧本、双语、分场大纲),**可选**。

---

## 怎么开始

### 第 1 步:安装

把 `screenwriter/` 文件夹复制到合适位置:Codex 的 `~/.agents/skills/screenwriter/`、Claude 的 `~/.claude/skills/screenwriter/`,或直接放在工作文件旁。也可在 CATIMATION 桌面应用「技能市场」一键安装。

### 第 2 步:告诉 agent

> 「加载 screenwriter skill,我们开始。」

它会读 SKILL.md、方法论、写作规则与工作模式。

### 第 3 步:带来素材

三选一:

**A. 你已有梗概 / 分场大纲 / 场景草稿。**
发文件——agent 读完后会问从哪一点开始。

**B. 你只有一个想法。**
用一两段话讲出来。agent 会先问问题,帮你把梗概拉成型,再做分场大纲,再写场景。

**C. 你只有片名和类型。**
填 `templates/synopsis.template.md` 和 `templates/characters.template.md`。之后迭代推进。

### 第 4 步:按场推进

标准循环:
1. 你按分场大纲点名要某场。
2. agent 给**一个版本 + 论据**。
3. 你给修改意见。
4. agent 点状修改。
5. 场景定稿后,通过 `tools/build_screenplay.js` 导出 `.docx`(可选)。

---

## 导出工具(可选,需要 Node + docx)

这些是普通的 Node 脚本,依赖 npm 包 `docx`。**首次使用前**,在 `tools/` 目录里装一次依赖:

```bash
cd tools
npm install docx
```

> 已与 Claude Cowork 环境解耦:不再需要硬编码 `NODE_PATH=/usr/local/lib/node_modules_global`,也不依赖 `mcp__cowork__create_artifact`。装好 `docx` 后直接 `node xxx.js` 即可。

### 剧本(好莱坞格式)
```bash
cp build_screenplay.js my_scene.js
# 打开 my_scene.js,用 slug/action/character/dial/trans 填 `screenplay` 数组
node my_scene.js
# 得到 screenplay.docx
```

### 双语(对白 + 译文)
```bash
cp build_bilingual.js my_bilingual.js
# 用 ...dialB("主语言", "译文") 填写
node my_bilingual.js
# 得到 screenplay-bilingual.docx
```

### 分场大纲(treatment)
```bash
cp build_treatment.js my_treatment.js
# 用 scene("标题", "正文", "[可选]审计标签") 填写
node my_treatment.js
# 得到 treatment.docx
```

> 若环境没有 Node/docx,跳过工具,直接在聊天里用等宽纯文本输出剧本——方法论照常适用。

---

## 对 skill 的典型请求

| 请求 | agent 做什么 |
|---|---|
| 「写第 5 场」 | 读分场大纲 → 给一个版本 + 论据 |
| 「这不行」 | 问一个收窄的二选一问题 → 新版本 |
| 「做成双语」 | 用 `tools/build_bilingual.js` |
| 「做因果审计」 | 逐场走分场大纲,打 ⚠ 标签 |
| 「能出多少分钟?」 | 按场景类型估算(见 `timing-and-cutting.md`) |
| 「压进 X 分钟」 | 给带具体数字的删减计划 |
| 「让角色 Y 的声音区别于 X」 | 对比台词,提出修改 |

---

## agent 不做的三件事

1. **不写 5 个版本** — 给一个 + 论据。
2. **不「优化」相邻台词** — 只改要求改的。
3. **不描写情绪** — 只写动作动词。

如果它违反——直接说:「一个版本,不是五个」或「只改 X」。

---

## 个性化这个 skill

如果你在同一类型里写很多片子——可以 fork 本 skill,加上:

- **`reference-films.md`** — 参考片清单 + 场景拆解。
- **`my-style.md`** — 你的个人风格偏好(如「不喜欢闪回」「永远收在沉默上」)。
- **`recurring-tropes.md`** — 你反复使用的手法。

skill 就成了你的,而非通用的。
