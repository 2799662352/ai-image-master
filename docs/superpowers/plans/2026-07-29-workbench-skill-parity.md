# 视频工作台 skill 同等待遇 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 agent 走视频工作台时和走 `generate_video` 一样会触发 `catimation-video` skill,并把参考素材口径与两个默认开关补齐。

**Architecture:** 双向挂钩 —— skill 的 frontmatter description 认领「视频工作台」这个触发面,工作台的建卡类 MCP 工具描述反过来回指 skill 并写死素材口径;卡片默认值只改一行。skill 源在 `resources/plugins/**`,生成物与顶层镜像一律由脚本产出,禁止手改。

**Tech Stack:** TypeScript / Electron 主进程 MCP 工具层 / React 渲染层 zustand store / Vitest / Node 审计脚本。

## Global Constraints

- skill frontmatter `description` ≤ **480 字符**(`scripts/lib/skill-architecture-validator.mjs:23`),本轮新文案 464 字符。
- description 禁用:`MUST … EVERY time`、`ANY images/videos`、`每次必用/每次必须/每次都要/任何图片/任何视频/所有图片/所有视频`(同文件 L48)。
- `src/main/agent/generated/firstPartySkills.generated.ts` 与顶层 `skills/` 镜像是**生成物**,只能由 `npm run skills:gen` 产出。
- 不做参考素材时长探测,不做 UI 计算,不拦截超限提交 —— 只写口径。
- 不追溯翻转已存库老卡的 `webSearch`。
- 工作目录:`d:\tecx\text\temp-aim-worktrees\wb-skill-parity`(分支 `feat/workbench-skill-parity`,基线 `f5217f3`,依赖已装好)。

---

### Task 1: 卡片默认联网开、配音默认钉死

**Files:**
- Modify: `src/renderer/src/features/video-workbench/cardSpec.ts:106`
- Test: `src/renderer/src/features/video-workbench/__tests__/storeModes.test.ts`

**Interfaces:**
- Consumes: 无(第一个任务)。
- Produces: `normalizeSpec(input)` 的 `webSearch` 缺省语义由「缺省关」改为「缺省开,显式 `false` 才关」。`buildCard(input, order, boardId?)` 经由 `normalizeSpec` 继承该语义。后续任务不依赖本任务。

- [ ] **Step 1: 改掉两处会红的旧断言,并补三条新断言**

在 `storeModes.test.ts` 把 L25–31 这个 `describe` 块整体替换为:

```ts
describe('buildCard 新字段默认值', () => {
  it('缺省 mode=multimodal_ref、webSearch=true、配音开、seed 不出现', () => {
    const card = buildCard({}, 0)
    expect(card.mode).toBe('multimodal_ref')
    expect(card.webSearch).toBe(true)
    expect(card.generateAudio).toBe(true)
    expect(card.seed).toBeUndefined()
  })

  it('显式关闭仍然生效:联网与配音都能被显式关掉', () => {
    expect(buildCard({ webSearch: false }, 0).webSearch).toBe(false)
    expect(buildCard({ generateAudio: false }, 0).generateAudio).toBe(false)
  })

  it('非法 mode 回退全能参考;seed 越界收敛', () => {
    expect(buildCard({ mode: 'bogus' as any }, 0).mode).toBe('multimodal_ref')
    expect(buildCard({ seed: 99999999999 }, 0).seed).toBe(4294967295)
    expect(buildCard({ seed: -3 }, 0).seed).toBeUndefined()
  })
})
```

再把 L160 那条 `'默认卡不携带 seed/webSearch/firstFrame 字段'` 整条替换为:

```ts
  it('默认卡携带 webSearch:true,但不携带 seed/firstFrame', async () => {
    const submit = mockSubmit()
    const store = useVideoWorkbenchStore.getState()
    const [id] = store.addCards([{ prompt: '一只狗', referenceImages: ['dog.png'] }])
    await store.startCards([id])
    const payload = submit.mock.calls[0][0] as Record<string, unknown>
    expect(payload.webSearch).toBe(true)
    expect('seed' in payload).toBe(false)
    expect('firstFrame' in payload).toBe(false)
    expect(payload.referenceImages).toEqual(['dog.png'])
  })
```

- [ ] **Step 2: 补一条「老卡不被追溯翻转」的水合测试**

先把 `storeModes.test.ts` 顶部的 import 补上(现有那行是 `import { resetWorkbenchDbForTest } from '../WorkbenchDb'`):

```ts
import { getWorkbenchDb, resetWorkbenchDbForTest } from '../WorkbenchDb'
```

然后在文件末尾追加:

```ts
describe('联网默认值不追溯老卡', () => {
  it('库里没有 webSearch 字段的老卡,水合后仍是关闭', async () => {
    const raw: Record<string, unknown> = { ...buildCard({ prompt: '老卡' }, 0), id: 'c-old' }
    delete raw.webSearch
    await getWorkbenchDb().put(raw as never)

    await useVideoWorkbenchStore.getState().ensureHydrated()
    const card = useVideoWorkbenchStore.getState().cards.find((c) => c.id === 'c-old')!
    expect(card.webSearch).toBe(false)
  })
})
```

- [ ] **Step 3: 跑测试确认变红**

Run: `npx vitest run src/renderer/src/features/video-workbench/__tests__/storeModes.test.ts`

Expected: FAIL。至少两条:`expected false to be true`(缺省 webSearch)、`expected undefined to be true`(payload.webSearch)。「老卡」那条此时应当已经是绿的(因为默认值还没改),这是对照组。

- [ ] **Step 4: 改默认值(一行)**

`src/renderer/src/features/video-workbench/cardSpec.ts:106`,把

```ts
    webSearch: input.webSearch === true,
```

改成

```ts
    webSearch: input.webSearch !== false,
```

- [ ] **Step 5: 跑测试确认变绿**

Run: `npx vitest run src/renderer/src/features/video-workbench/__tests__/storeModes.test.ts`

Expected: PASS,全部用例通过。

- [ ] **Step 6: 跑整个工作台套件查回归**

Run: `npx vitest run src/renderer/src/features/video-workbench`

Expected: PASS。若 `workbenchIR.test.ts` 因「声明式替换」语义出现 `webSearch` 相关红灯,按新默认值修正断言 —— IR 省略 `webSearch` 现在等于「联网开」,这是设计预期,不是 bug。

- [ ] **Step 7: 提交**

```bash
git add src/renderer/src/features/video-workbench/cardSpec.ts src/renderer/src/features/video-workbench/__tests__/storeModes.test.ts
git commit -m "feat(workbench): 新卡默认开联网,并把配音默认值钉进测试"
```

---

### Task 2: 工作台建卡类工具描述回指 skill 并写死素材口径

**Files:**
- Modify: `src/main/mcp/tools/videoWorkbenchTools.ts`(四处 description:L273 `add_tasks`、L307 `update_task`、L328 `start`、L419 `apply`)
- Test: `src/main/mcp/tools/__tests__/videoWorkbenchTools.test.ts`

**Interfaces:**
- Consumes: 无(不依赖 Task 1)。
- Produces: 四个工具的 description 文本契约 —— `add_tasks` 与 `start` 含字面量 `catimation-video`;`add_tasks`、`update_task`、`apply` 含字面量 `≤15s`。Task 3 的 skill 正文与这里的措辞互为呼应,但无代码依赖。

- [ ] **Step 1: 写失败的描述契约测试**

在 `videoWorkbenchTools.test.ts` 末尾追加(`capture` / `toolByName` 是该文件已有的辅助函数):

```ts
describe('工具描述:回指 skill 与素材口径', () => {
  it('add_tasks 与 start 点名 catimation-video', () => {
    const { tools, server, router } = capture()
    registerVideoWorkbenchTools(server, router)
    for (const name of ['video_workbench_add_tasks', 'video_workbench_start']) {
      expect(toolByName(tools, name).config.description).toContain('catimation-video')
    }
  })

  it('建卡类工具写死每卡素材口径(≤3 段、合计 ≤15s)', () => {
    const { tools, server, router } = capture()
    registerVideoWorkbenchTools(server, router)
    for (const name of ['video_workbench_add_tasks', 'video_workbench_update_task', 'video_workbench_apply']) {
      const desc = toolByName(tools, name).config.description
      expect(desc).toContain('referenceVideos ≤3')
      expect(desc).toContain('≤15s')
      expect(desc).toContain('referenceAudios ≤3')
    }
  })

  it('只读工具不被塞进这些纪律(省上下文预算)', () => {
    const { tools, server, router } = capture()
    registerVideoWorkbenchTools(server, router)
    for (const name of ['video_workbench_status', 'video_workbench_export', 'video_workbench_remove_tasks']) {
      expect(toolByName(tools, name).config.description).not.toContain('catimation-video')
    }
  })
})
```

- [ ] **Step 2: 跑测试确认变红**

Run: `npx vitest run src/main/mcp/tools/__tests__/videoWorkbenchTools.test.ts`

Expected: FAIL,前两条报 `expected '…' to contain 'catimation-video'` / `'≤15s'`;第三条应当已经绿(只读工具本来就没有这些字)。

- [ ] **Step 3: 改 `add_tasks` 描述(L274 起),在原文最前面加两句**

```ts
  server.registerTool('video_workbench_add_tasks', {
    description:
      'Batch output surface of the catimation-video skill — load that skill first, grade the request ' +
      '(快速/标准/专业/制片) and write the prompt with the same discipline as generate_video. ' +
      'Per card the material caps are identical too: referenceImages ≤9, referenceVideos ≤3 and ≤15s ' +
      'in total, referenceAudios ≤3 and ≤15s in total. ' +
      'Add one or more video task cards to the 「生成视频」 workbench page (the scroll-style concurrent ' +
```

其余原文一字不动。

- [ ] **Step 4: 改 `update_task` 描述(L308 起),在末尾那句 view_image 纪律之后追加一句**

把原描述最后一行

```ts
      'the prompt — same reason as on add_tasks: the render follows the picture, not the filename.',
```

改成

```ts
      'the prompt — same reason as on add_tasks: the render follows the picture, not the filename. ' +
      'Material caps per card: referenceImages ≤9, referenceVideos ≤3 and ≤15s in total, ' +
      'referenceAudios ≤3 and ≤15s in total.',
```

- [ ] **Step 5: 改 `start` 描述(L329 起),在原文最前面加一句**

```ts
  server.registerTool('video_workbench_start', {
    description:
      'Batch output surface of the catimation-video skill (load it for grading and prompt discipline). ' +
      'Start rendering workbench cards (concurrent). Omit cardIds to start EVERY startable card on the ' +
```

其余原文一字不动。

- [ ] **Step 6: 改 `apply` 描述(L420 起),在 “Rules that matter” 列表里加一条**

在 `• 'id' present = edit that existing card/board…` 那条之后插入:

```ts
      + '• Material caps per card: referenceImages ≤9, referenceVideos ≤3 and ≤15s in total, '
      + 'referenceAudios ≤3 and ≤15s in total.\n'
```

- [ ] **Step 7: 跑测试确认变绿**

Run: `npx vitest run src/main/mcp/tools/__tests__/videoWorkbenchTools.test.ts`

Expected: PASS,该文件全部用例通过(含原有的 7 个工具行为用例)。

- [ ] **Step 8: 提交**

```bash
git add src/main/mcp/tools/videoWorkbenchTools.ts src/main/mcp/tools/__tests__/videoWorkbenchTools.test.ts
git commit -m "feat(mcp): 工作台建卡工具回指 catimation-video 并写死素材口径"
```

---

### Task 3: skill 认领工作台触发面

**Files:**
- Modify: `resources/plugins/catimation-video/skills/catimation-video/SKILL.md`(frontmatter description、L17 起的开场、L68 那句 “All modes share ONE tool”、`## 模式与素材规则` 一节末尾新增小节)
- 生成物(**不要手改**,由脚本产出):`src/main/agent/generated/firstPartySkills.generated.ts`、`skills/catimation-video/SKILL.md`

**Interfaces:**
- Consumes: Task 2 定下的工具措辞(`video_workbench_*` 的职责划分),正文引用时保持一致。
- Produces: 无代码接口。产出的是 description 触发词集合:新增 `视频工作台` / `批量出片` / `多镜`。

- [ ] **Step 1: 记录审计基线**

Run: `npm run audit:skill-arch`

Expected: `violations by code:` 下 `total: 0`。这是改动前的基线,后面要保持 0。

- [ ] **Step 2: 换掉 frontmatter description**

把文件开头的整段 description 替换为:

```yaml
description: >-
  FIRST-CHOICE video generator and the ONLY top-level video orchestrator in
  CATIMATION. Trigger whenever the user asks to generate / render a video or
  animation, animate a still, or says 生成视频 / 图生视频 / 让它动起来 / 视频编辑 /
  视频延长 / 视频工作台 / 批量出片 / 多镜. Covers text/still-to-video, omni-reference
  (全能参考, default), editing and extension on both output surfaces
  (generate_video one-shot + video_workbench_* batch), and grades every request
  快速/标准/专业/制片 before loading other skills.
```

- [ ] **Step 3: 立刻验字数与禁词**

Run: `npm run audit:skill-arch`

Expected: 仍然 `total: 0`。若报 `DESCRIPTION_TOO_LONG`,说明替换时多带了空白 —— 折叠后应为 464 字符,上限 480。

- [ ] **Step 4: 改开场,把「唯一工具」改成「两条出片面」**

把 L17–18 的

```markdown
When the user wants a video, call the **`generate_video`** tool from the
`catimation` MCP server.
```

替换为

```markdown
When the user wants a video, pick the output surface first: **`generate_video`**
(single shot, delivered straight into the chat) or the **`video_workbench_*`**
tools(「生成视频」工作台页:多卡批量、逐卡改参数、用户看着卡片渲染)。两者都在
`catimation` MCP server 上,共用本 skill 的分级与提示词纪律。走 `generate_video` 时:
```

紧随其后的 “It submits the render and blocks for roughly 75s…” 保持原样。

- [ ] **Step 5: 改 L68 那句「所有模式共用一个工具」**

把

```markdown
All modes share ONE tool (`generate_video`) — pick by inputs + prompt:
```

替换为

```markdown
All modes work on **both** surfaces(`generate_video` 与 `video_workbench_*`)
— pick by inputs + prompt:
```

- [ ] **Step 6: 在 `## 模式与素材规则` 一节末尾(「真人脸」那段之后、`## 角色片 / 多镜` 之前)插入新小节**

```markdown
### 两条出片面怎么选

- **`generate_video`**:单镜、一次性、用户没点名工作台。成片直接进聊天并落历史页。
- **`video_workbench_*`**:多镜批量、用户已经在「生成视频」工作台、需要逐卡改参数或反复
  重跑。先 `video_workbench_add_tasks` 建卡(默认只填不跑,`autoStart:true` 才立即渲染);
  批次跑完会主动推「[视频工作台] 批次渲染完成」,**别轮询** `video_workbench_status`。
  跨多卡的整理/重排/换规格用 `video_workbench_export` → 改 JSON → `video_workbench_apply`。
- 两条面共用**同一套** STEP 0 分级、上面那组素材 caps 与素材引用铁律 —— 工作台不是例外。
  有参考图时同样先 `view_image` 看图再写 prompt。
```

- [ ] **Step 7: 跑同步脚本产出生成物与镜像**

Run: `npm run skills:gen`

Expected: 命令成功退出。`git status` 应出现 `src/main/agent/generated/firstPartySkills.generated.ts` 与 `skills/catimation-video/SKILL.md` 的改动。**不要手改这两个文件。**

- [ ] **Step 8: 验零漂移 + 审计 + 架构测试**

Run: `npm run skills:gen:check && npm run audit:skill-arch && npm run test:skill-arch`

Expected: `skills:gen:check` 无漂移退出 0;审计 `total: 0`;`test:skill-arch` 全绿。

- [ ] **Step 9: 提交**

```bash
git add resources/plugins/catimation-video/skills/catimation-video/SKILL.md src/main/agent/generated/firstPartySkills.generated.ts skills/catimation-video/SKILL.md
git commit -m "feat(skill): catimation-video 认领视频工作台触发面"
```

---

### Task 4: 全量验收与开 PR

**Files:** 无新增改动,只跑校验。

**Interfaces:**
- Consumes: Task 1–3 的全部产出。
- Produces: 一个可合并的 PR。

- [ ] **Step 1: 类型检查**

Run: `npm run typecheck`

Expected: 无**新增**错误。基线上若已有既存错误,与本轮改动无关的照旧,不要顺手修。

- [ ] **Step 2: 跑受影响的三套测试**

Run: `npx vitest run src/renderer/src/features/video-workbench src/main/mcp/tools/__tests__/videoWorkbenchTools.test.ts`

Expected: 全绿。

- [ ] **Step 3: 构建**

Run: `npm run build:vite`

Expected: 构建成功。

- [ ] **Step 4: 推分支并开 PR**

```bash
git push -u origin feat/workbench-skill-parity
gh pr create --base main --title "feat: 视频工作台与 generate_video 的 skill 同等待遇" --body-file docs/superpowers/specs/2026-07-29-workbench-skill-parity-design.md
```

Expected: 返回 PR 链接。等 Quality Gate 七个 job 全绿再合。已知 flake:`Codex protocol client stopped`(单测 job 拆卸阶段的未捕获 rejection,重跑即绿)。

---

## Self-Review 记录

**Spec 覆盖:** spec 的三节设计分别落在 Task 3(skill 描述与正文)、Task 2(工具描述与素材口径)、Task 1(默认值),验收清单落在 Task 4 与 Task 3 Step 8。

**一处对 spec 的修正:** spec 的「风险」一节提出「测试里断言 description ≤480」。实施时发现这条是**冗余**的 ——
`scripts/lib/skill-architecture-validator.mjs:23` 的 `maxDescriptionChars: 480` 已经由
`npm run audit:skill-arch` 强制执行,而该命令就是 CI 的 `Quality Gate / Skill Architecture` job。
再写一条同义断言违反 DRY,故不落任务;字数保护由 Task 3 Step 3 与 Step 8 的审计承担。

**另一处发现:** spec 说「正文顺带把 ≤3/≤15s 口径写进去」,实际 SKILL.md L63–64 **早已写着**
`referenceVideos ≤3 段、合计 ≤15s;referenceAudios ≤3 段、合计 ≤15s`。所以正文无需新增该口径,
Task 3 的新小节只需声明「工作台不是例外,共用同一组 caps」,缺口实际只在工具描述侧(Task 2)。
