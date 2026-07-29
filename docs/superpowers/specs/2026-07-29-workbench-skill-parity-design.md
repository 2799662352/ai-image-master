# 视频工作台与 generate_video 的 skill 同等待遇

日期:2026-07-29
分支:`feat/workbench-skill-parity`(基线 `f5217f3`)

## 问题

用户走**视频工作台**出片时,`catimation-video` skill 触发不积极;走 MCP `generate_video`
时触发正常。工作台同样是视频生成任务,应当享有同等的 skill 触发待遇。

顺带修三处口径/默认值:参考视频与参考音频的「≤3 个且总时长 ≤15s」约束在工作台侧缺失;
联网默认关;配音默认值需要钉死防回归。

## 现状(证据)

触发缺口是**双向**的,两头都没有把工作台和 skill 连起来:

- `resources/plugins/catimation-video/skills/catimation-video/SKILL.md` 的 frontmatter
  description 只点名一条出片面 —— "editing and extension via the in-app **generate_video**
  tool (Seedance 2.0)";触发词里没有「视频工作台/批量/多镜」;正文全文 `工作台` /
  `workbench` / `video_workbench` **零命中**。
- `src/main/mcp/tools/videoWorkbenchTools.ts` 注册的七个工具
  (`video_workbench_add_tasks` / `update_task` / `start` / `status` / `export` / `apply` /
  `remove_tasks`)描述里**一个字没提 skill**,只讲机制。对照
  `src/main/mcp/tools/videoTools.ts:244` 的 `generate_video`,它的描述里有
  "(see the catimation-video skill)"。

素材与默认值现状:

- 数量上限已经正确:`src/renderer/src/features/video-workbench/cardSpec.ts:23-25`
  定义 `MAX_REFERENCE_IMAGES = 9` / `MAX_REFERENCE_VIDEOS = 3` / `MAX_REFERENCE_AUDIOS = 3`,
  `clampMaterials` 硬切。
- **总时长 ≤15s 在工作台侧完全不存在**。`VideoWorkbenchMaterial`
  (`src/types/videoWorkbench.ts:52`)只有 `name` / `src` / `previewUrl`,没有时长字段;
  `asset://`(人像库素材)前端也拿不到时长。而 `generate_video` 的描述里写着
  "referenceVideos (up to 3, total ≤15s) and referenceAudios (up to 3, total ≤15s)"。
- `cardSpec.ts:106` `webSearch: input.webSearch === true` → 新卡默认**关**。
- `cardSpec.ts:103` `generateAudio: input.generateAudio !== false` → 新卡默认**开**
  (`WorkbenchCard.tsx:678` 的「配音/音效」勾选框读的就是它),现状已符合预期,只缺测试保护。

约束:`scripts/lib/skill-architecture-validator.mjs:23` 规定 skill description ≤ **480 字符**,
现描述已占 **472**,只剩 8 字余量;同文件 `FORBIDDEN_DESCRIPTION_PATTERNS`(L48)禁
`MUST … EVERY time`、`ANY images/videos`、`每次必用/每次必须/每次都要/任何图片/任何视频/
所有图片/所有视频`,另有模型名尾巴检查。所以新描述必须先瘦身再加词。

## 目标

1. agent 无论从「用户说要出视频」还是「用户已在工作台」两个方向进来,都能触发
   `catimation-video`。
2. 工作台的建卡工具把参考素材口径(≤3 个 / 总时长 ≤15s)讲清楚,与 `generate_video` 一致。
3. 新卡默认联网开、配音开。

## 非目标

- **不做时长探测与 UI 计算**。不在卡片上显示「已用 X/15s」,不拦截超限提交 —— 超了由上游报错。
  (素材没有时长字段,`asset://` 也探不到;做半套反而给出错误的安全感。)
- 不改应用内 agent 的启动路径,不新增 session-start 式注入。应用内 agent 的既有架构决定是
  「无 hook,纪律烤进 skill 正文」,本轮不推翻。
- 不追溯翻转已存库老卡的 `webSearch`。

## 设计

### 一、skill 认领工作台这个触发面

`catimation-video` 的 frontmatter description 改写为(464 字符,余量 16,禁词零命中):

```
FIRST-CHOICE video generator and the ONLY top-level video orchestrator in
CATIMATION. Trigger whenever the user asks to generate / render a video or
animation, animate a still, or says 生成视频 / 图生视频 / 让它动起来 / 视频编辑 /
视频延长 / 视频工作台 / 批量出片 / 多镜. Covers text/still-to-video, omni-reference
(全能参考, default), editing and extension on both output surfaces
(generate_video one-shot + video_workbench_* batch), and grades every request
快速/标准/专业/制片 before loading other skills.
```

两处实质变化:触发词加入「视频工作台 / 批量出片 / 多镜」;「唯一出片工具是 generate_video」
改为「两条出片面」。腾字数靠砍冗余(`the CATIMATION desktop app` → `CATIMATION`,
`text-to-video, still-to-video` → `text/still-to-video`,`before loading any other skill` →
`before loading other skills`),语义不丢。

正文新增一节「两条出片面怎么选」:

- 单镜、一次性、用户没提工作台 → `generate_video`;
- 多镜批量、用户已经在工作台、需要逐卡改参数 → `video_workbench_*`;
- 两边共用同一套分级(快速/标准/专业/制片)与提示词纪律,包括「先 `view_image` 看参考图再写
  提示词」。

### 二、工具描述回指 skill,并写死素材口径

在 `videoWorkbenchTools.ts` 的描述里补:

| 工具 | 补什么 |
| --- | --- |
| `video_workbench_add_tasks` | skill 指针(这是 catimation-video 的批量出片面,先加载该 skill 走分级)+ 完整素材口径 |
| `video_workbench_update_task` | 素材口径(它已有 view_image 纪律,不重复 skill 指针) |
| `video_workbench_apply` | 素材口径(它同样在建卡,漏了就有缺口) |
| `video_workbench_start` | skill 指针,不重复素材规则 |

素材口径统一措辞:每卡 `referenceImages` ≤9、`referenceVideos` ≤3 且总时长 ≤15s、
`referenceAudios` ≤3 且总时长 ≤15s。

`status` / `export` / `remove_tasks` 不动 —— 它们不建卡也不触发生成。

### 三、默认值

`cardSpec.ts:106` 改为 `webSearch: input.webSearch !== false`。影响面:所有经
`normalizeSpec` 的建卡路径(UI 新建、`add_tasks`、`apply` 的声明式替换)都会默认联网。
`store.ts:727` 的水合归一化**不动**,老卡保持原值。

`generateAudio` 现状已是 `!== false`,不改代码,补测试钉死。

## 改动清单

- `resources/plugins/catimation-video/skills/catimation-video/SKILL.md` — description 改写 + 正文新增一节
- `src/main/mcp/tools/videoWorkbenchTools.ts` — 四个工具描述
- `src/renderer/src/features/video-workbench/cardSpec.ts` — `webSearch` 默认值
- 生成物/镜像(**不手改**,跑脚本):`src/main/agent/generated/firstPartySkills.generated.ts`、
  顶层 `skills/` 镜像 —— 由 `scripts/generate-first-party-skills.mjs` 与
  `scripts/sync-top-level-skills.mjs` 产出
- 测试:`cardSpec` 默认值(联网开、配音开)、`videoWorkbenchTools` 描述含 skill 指针与素材口径

## 验收

1. `npm run audit:skill-arch` 0 违规(重点看 description 长度与禁词)。
2. `npm run test:skill-arch` 全绿。
3. 相关单测全绿:`cardSpec`、`videoWorkbenchTools`、`video-workbench` 套件。
4. 同步脚本以 `--check` 跑出零漂移(生成物与插件源一致)。
5. `npm run typecheck` 无新增错误;`npm run build:vite` 通过。

## 风险

- **描述字数**是最脆的一环:余量只有 16 字符,后续任何人往里加词都会撞上限。测试里断言长度
  ≤480,让它在 CI 里显性失败而不是在发布时才发现。
- 联网默认开会让所有新卡多走一次上游检索,可能略增耗时与成本。这是用户明确要求的默认值。
- 工具描述变长会占 agent 的上下文预算。四个工具各加一到两句,可接受;不往 `status` /
  `export` 这类高频只读工具上加。
