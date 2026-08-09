# 工作台提示词局部编辑 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `video_workbench_patch_prompt`,让模型改一段提示词里的几个词时不必重吐全文。

**Architecture:** 一个 MCP 工具,走既有的 main → `router.call` → renderer `AgentToolExecutor` → `useVideoWorkbenchStore` 路径。核心逻辑是精确字符串替换 + 唯一性校验,写入复用 `store.updateCard`(它已经会跳过生成中的卡)。

**Tech Stack:** TypeScript、zod、`@modelcontextprotocol/server`、Vitest。

**设计依据:** `docs/superpowers/specs/2026-08-09-workbench-prompt-patch-design.md`

## Global Constraints

- 失败一律**零写入**,且错误信息里带上提示词全文 —— 模型不必再发一次 `export` 就能自纠。
- **不做正则、不做模糊匹配。** 改错一个词不会编译失败,会安静地生成一条错的视频,而那要花钱。
- **不加 `replaceAll`,不加 read-before-edit。** 见 spec「我们比代码编辑器简单在哪」。
- 工具 schema 顶层字段**不得使用 union**(会生成 `anyOf`,客户端校验器支持参差),也不得出现 `undefined` 字段 —— 两条都有守护测试钉着(`toolAnnotations.test.ts`)。
- 新工具注解用 `WRITE_IDEMPOTENT`(就地改同一张卡,重复调不叠加)。

---

## File Structure

- `src/main/mcp/tools/videoWorkbenchTools.ts` — 工具注册(描述、inputSchema、outputSchema、annotations)。追加在 `video_workbench_set_spec` 之后。
- `src/renderer/src/features/agent-chat/AgentToolExecutor.ts` — 两处:工具名白名单(L322 附近)、执行分支(L454 附近的 switch)。
- `src/renderer/src/features/agent-chat/__tests__/AgentToolExecutor.videoWorkbench.test.ts` — 行为测试(主战场)。
- `src/main/mcp/tools/__tests__/videoWorkbenchTools.test.ts` — schema / 注册面测试。

纯函数 `patchPromptText` 放在 executor 同文件内(它只有十几行且只有这一个消费者,单开文件反而增加跳转成本)。

---

## Task 1: 纯函数 `patchPromptText` —— 匹配与唯一性

**Files:**
- Modify: `src/renderer/src/features/agent-chat/AgentToolExecutor.ts`
- Test: `src/renderer/src/features/agent-chat/__tests__/AgentToolExecutor.videoWorkbench.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `patchPromptText(prompt: string, oldText: string, newText: string): { ok: true; prompt: string } | { ok: false; count: number }`

- [ ] **Step 1: 写失败的测试**

在测试文件末尾追加:

```ts
import { patchPromptText } from '../AgentToolExecutor'

describe('patchPromptText', () => {
  it('唯一命中时替换并回全文', () => {
    const r = patchPromptText('镜头 dolly in 缓缓推进', 'dolly in', 'rack focus')
    expect(r).toEqual({ ok: true, prompt: '镜头 rack focus 缓缓推进' })
  })

  it('newText 为空串 = 删除该片段', () => {
    expect(patchPromptText('a BAD b', ' BAD', '')).toEqual({ ok: true, prompt: 'a b' })
  })

  // 歧义时宁可拒绝也不猜:改错一个词不会报错，会安静生成一条错的视频，而那要花钱。
  it('多处命中时拒绝并回命中次数', () => {
    expect(patchPromptText('推进，然后推进', '推进', '拉远')).toEqual({ ok: false, count: 2 })
  })

  it('未命中时拒绝', () => {
    expect(patchPromptText('镜头缓缓推进', 'zoom in', 'x')).toEqual({ ok: false, count: 0 })
  })

  // 不做正则:用户提示词里出现正则元字符是常态（括号、点、星号）。
  it('把 oldText 当字面量，不当正则', () => {
    expect(patchPromptText('曝光 (f/2.8) 浅景深', '(f/2.8)', '(f/8)'))
      .toEqual({ ok: true, prompt: '曝光 (f/8) 浅景深' })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```powershell
npx vitest run src/renderer/src/features/agent-chat/__tests__/AgentToolExecutor.videoWorkbench.test.ts
```

Expected: FAIL — `patchPromptText is not a function`(导出不存在)

- [ ] **Step 3: 写最小实现**

在 `AgentToolExecutor.ts` 顶层(靠近其它纯 helper 处)加:

```ts
/**
 * 提示词的精确字符串替换。照 Claude Code 的 Edit 工具:精确匹配、不做正则、
 * 要求全文唯一。歧义时拒绝而不是猜 —— 改错一个词不会像代码那样编译失败，
 * 会安静地生成一条错的视频，而那是要花钱的。
 */
export function patchPromptText(
  prompt: string,
  oldText: string,
  newText: string,
): { ok: true; prompt: string } | { ok: false; count: number } {
  if (!oldText) return { ok: false, count: 0 }
  // split 计数而不是正则:提示词里括号/点/星号是常态，当成正则会误伤。
  const parts = prompt.split(oldText)
  const count = parts.length - 1
  if (count !== 1) return { ok: false, count }
  return { ok: true, prompt: parts[0] + newText + parts[1] }
}
```

- [ ] **Step 4: 跑测试确认通过**

```powershell
npx vitest run src/renderer/src/features/agent-chat/__tests__/AgentToolExecutor.videoWorkbench.test.ts
```

Expected: PASS(5 个新用例全绿,既有用例不受影响)

- [ ] **Step 5: 反证唯一性校验真的在起作用**

把 Step 3 的 `if (count !== 1)` 临时改成 `if (count === 0)`,重跑。

Expected: 「多处命中时拒绝」这条变红。确认后改回。

- [ ] **Step 6: 提交**

```powershell
git add src/renderer/src/features/agent-chat/AgentToolExecutor.ts src/renderer/src/features/agent-chat/__tests__/AgentToolExecutor.videoWorkbench.test.ts
git commit -m "feat(workbench): add exact-match prompt patching helper"
```

---

## Task 2: executor 分支 —— 接上 store

**Files:**
- Modify: `src/renderer/src/features/agent-chat/AgentToolExecutor.ts`(白名单 L322 附近 + switch L454 附近)
- Test: `src/renderer/src/features/agent-chat/__tests__/AgentToolExecutor.videoWorkbench.test.ts`

**Interfaces:**
- Consumes: `patchPromptText`(Task 1);`useVideoWorkbenchStore.getState().updateCard(id, patch) => boolean`
- Produces: 工具名 `video_workbench_patch_prompt`,成功返回 `{ prompt: string }`

- [ ] **Step 1: 写失败的测试**

追加(沿用该文件既有的 store 初始化写法):

```ts
describe('video_workbench_patch_prompt', () => {
  it('改动落地并回改后全文', async () => {
    const [id] = useVideoWorkbenchStore.getState().addCards([{ prompt: '镜头 dolly in 推进' }])
    const r = await executeAgentTool('video_workbench_patch_prompt', {
      cardId: id, oldText: 'dolly in', newText: 'rack focus',
    }) as { prompt: string }

    expect(r.prompt).toBe('镜头 rack focus 推进')
    expect(useVideoWorkbenchStore.getState().cards.find((c) => c.id === id)!.prompt)
      .toBe('镜头 rack focus 推进')
  })

  // 错误信息必须带全文:模型据此自纠，省掉一次 export 往返。
  it('多处命中时零写入，并把全文带回去', async () => {
    const [id] = useVideoWorkbenchStore.getState().addCards([{ prompt: '推进，然后推进' }])
    await expect(executeAgentTool('video_workbench_patch_prompt', {
      cardId: id, oldText: '推进', newText: '拉远',
    })).rejects.toThrow(/2 处|推进，然后推进/)
    expect(useVideoWorkbenchStore.getState().cards.find((c) => c.id === id)!.prompt)
      .toBe('推进，然后推进')
  })

  it('未命中时零写入', async () => {
    const [id] = useVideoWorkbenchStore.getState().addCards([{ prompt: '镜头推进' }])
    await expect(executeAgentTool('video_workbench_patch_prompt', {
      cardId: id, oldText: 'zoom', newText: 'x',
    })).rejects.toThrow(/镜头推进/)
  })

  it('卡不存在时报错', async () => {
    await expect(executeAgentTool('video_workbench_patch_prompt', {
      cardId: 'nope', oldText: 'a', newText: 'b',
    })).rejects.toThrow(/nope/)
  })

  // updateCard 本身就跳过 preparing/queued/running，这里确认失败被如实上报而不是静默成功。
  it('生成中的卡拒绝改动', async () => {
    const [id] = useVideoWorkbenchStore.getState().addCards([{ prompt: '镜头推进' }])
    useVideoWorkbenchStore.setState((s) => ({
      cards: s.cards.map((c) => (c.id === id ? { ...c, status: 'running' as const } : c)),
    }))
    await expect(executeAgentTool('video_workbench_patch_prompt', {
      cardId: id, oldText: '推进', newText: '拉远',
    })).rejects.toThrow(/生成中/)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```powershell
npx vitest run src/renderer/src/features/agent-chat/__tests__/AgentToolExecutor.videoWorkbench.test.ts
```

Expected: FAIL — 未知工具名

- [ ] **Step 3: 加进白名单**

在 L322 附近那组 `case 'video_workbench_set_spec':` 的工具名列表里,紧邻加一行:

```ts
      case 'video_workbench_patch_prompt':
```

- [ ] **Step 4: 写执行分支**

在 L454 附近的 switch 里,`case 'video_workbench_set_spec': {` 之后追加:

```ts
      case 'video_workbench_patch_prompt': {
        const cardId = typeof params.cardId === 'string' ? params.cardId : ''
        const oldText = typeof params.oldText === 'string' ? params.oldText : ''
        const newText = typeof params.newText === 'string' ? params.newText : ''
        if (!cardId) throw new Error('video_workbench_patch_prompt: cardId is required')
        if (!oldText) throw new Error('video_workbench_patch_prompt: oldText 不能为空')

        const card = useVideoWorkbenchStore.getState().cards.find((c) => c.id === cardId)
        if (!card) throw new Error(`video_workbench_patch_prompt: 卡片 ${cardId} 不存在`)

        const patched = patchPromptText(card.prompt, oldText, newText)
        if (!patched.ok) {
          // 带上全文:模型据此把 oldText 写长一点重来，不必再发一次 export。
          throw new Error(
            `video_workbench_patch_prompt: oldText 在该卡提示词中命中 ${patched.count} 处，`
            + '需要恰好 1 处。把 oldText 写长一点以唯一定位；整段重写请用 '
            + `video_workbench_update_task。当前提示词全文:\n${card.prompt}`,
          )
        }

        const ok = store.updateCard(cardId, { prompt: patched.prompt })
        if (!ok) throw new Error(`video_workbench_patch_prompt: 卡片 ${cardId} 生成中，未改动`)
        return { prompt: patched.prompt, workbench: workbenchSummary() }
      }
```

- [ ] **Step 5: 跑测试确认通过**

```powershell
npx vitest run src/renderer/src/features/agent-chat/__tests__/AgentToolExecutor.videoWorkbench.test.ts
```

Expected: PASS(全部用例)

- [ ] **Step 6: 提交**

```powershell
git add src/renderer/src/features/agent-chat/AgentToolExecutor.ts src/renderer/src/features/agent-chat/__tests__/AgentToolExecutor.videoWorkbench.test.ts
git commit -m "feat(workbench): wire patch_prompt through the tool executor"
```

---

## Task 3: MCP 工具注册

**Files:**
- Modify: `src/main/mcp/tools/videoWorkbenchTools.ts`(追加在 `video_workbench_set_spec` 注册块之后,约 L613)
- Test: `src/main/mcp/tools/__tests__/videoWorkbenchTools.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `video_workbench_patch_prompt` 路由名;既有 `okResult` / `errorResult` / `extractCodexThreadId` / `WRITE_IDEMPOTENT` / `workbenchSummarySchema`
- Produces: 注册到 `McpServer` 的工具

- [ ] **Step 1: 写失败的测试**

沿用该文件既有的 `capture()` / `toolByName()` 写法(见文件内 L27-L40、L739 的先例):

```ts
it('注册了 patch_prompt，且顶层字段都是朴素标量', () => {
  const { tools } = capture()
  const tool = toolByName(tools, 'video_workbench_patch_prompt')
  const shape = (tool.config.inputSchema as any).shape
  expect(Object.keys(shape).sort()).toEqual(['cardId', 'newText', 'oldText'])
  // 顶层 union 会生成 anyOf，客户端校验器支持参差 —— duration:-1 就栽在这上面过。
  for (const key of Object.keys(shape)) {
    expect(shape[key]).toBeDefined()
  }
})
```

- [ ] **Step 2: 跑测试确认失败**

```powershell
npx vitest run src/main/mcp/tools/__tests__/videoWorkbenchTools.test.ts
```

Expected: FAIL — `tool` 为 undefined

- [ ] **Step 3: 注册工具**

```ts
  server.registerTool('video_workbench_patch_prompt', {
    description:
      'Change PART of one card\'s prompt by exact string replacement — the tool for "把第 3 张的 '
      + 'dolly in 改成 rack focus".\n'
      + 'USE THIS INSTEAD OF update_task when you are editing a few words. update_task takes the whole '
      + 'prompt, so re-emitting 200 characters to change 8 of them costs you the decode time for all 200 '
      + '— and long re-emissions are exactly where models start eliding content.\n'
      + 'oldText must appear EXACTLY ONCE in that card\'s prompt. It is matched literally: no regex, no '
      + 'fuzzy matching. If it matches 0 or 2+ times the call is REJECTED with zero writes and the full '
      + 'current prompt in the error, so you can lengthen oldText and retry without calling export.\n'
      + 'newText may be empty to delete the fragment. For a genuine full rewrite, use '
      + 'video_workbench_update_task instead — stuffing the entire prompt into oldText is strictly worse.',
    inputSchema: z.object({
      cardId: z.string().describe('Card to edit. Get ids from video_workbench_status.'),
      oldText: z.string().describe(
        'Exact text to replace. Must occur exactly once in the card prompt. Matched literally.',
      ),
      newText: z.string().describe('Replacement text. Empty string deletes the fragment.'),
    }),
    annotations: WRITE_IDEMPOTENT,
    outputSchema: z.looseObject({
      prompt: z.string().describe('The full prompt after the edit — check it landed as you intended.'),
      workbench: workbenchSummarySchema,
    }),
  }, async (params, ctx?: unknown) => {
    try {
      const result = await router.call(
        'video_workbench_patch_prompt',
        params as Record<string, unknown>,
        extractCodexThreadId(ctx),
      ) as { prompt: string }
      return okResult([`✓ video_workbench_patch_prompt → prompt updated.`], result)
    } catch (error) {
      return errorResult('video_workbench_patch_prompt', error)
    }
  })
```

- [ ] **Step 4: 跑测试确认通过**

```powershell
npx vitest run src/main/mcp/tools/__tests__/videoWorkbenchTools.test.ts src/main/mcp/tools/__tests__/toolAnnotations.test.ts
```

Expected: PASS —— 尤其 `toolAnnotations.test.ts` 的两条守护(无 `undefined` 字段、顶层无 union)必须通过。

- [ ] **Step 5: 提交**

```powershell
git add src/main/mcp/tools/videoWorkbenchTools.ts src/main/mcp/tools/__tests__/videoWorkbenchTools.test.ts
git commit -m "feat(workbench): register video_workbench_patch_prompt"
```

---

## Task 4: 给 update_task 指路 + 全量回归

**Files:**
- Modify: `src/main/mcp/tools/videoWorkbenchTools.ts`(`video_workbench_update_task` 的 description)

**Interfaces:**
- Consumes: Task 3 注册好的工具名
- Produces: 无

工具选择靠描述竞争 —— 只加新工具而不在旧工具里指路,模型多半继续用旧的。这一点在
`apply` 那轮已经吃过一次亏。

- [ ] **Step 1: 在 update_task 描述里加一句**

在其 description 开头附近插入:

```ts
      + 'To change only a few words of the prompt, use video_workbench_patch_prompt instead — it takes '
      + 'just the old and new fragment rather than the entire prompt.\n'
```

- [ ] **Step 2: 全量回归**

```powershell
npx vitest run src/main/mcp src/renderer/src/features/agent-chat src/renderer/src/features/video-workbench
```

Expected: 全绿,无未处理 rejection。

- [ ] **Step 3: 类型闸**

```powershell
node scripts/ci/typecheck-baseline.mjs
```

Expected: `0 new`

- [ ] **Step 4: 提交**

```powershell
git add src/main/mcp/tools/videoWorkbenchTools.ts
git commit -m "docs(workbench): point update_task at patch_prompt for small edits"
```

---

## Task 5: `video_workbench_move_task` —— 补上退役 apply 的最后一块

**Files:**
- Modify: `src/main/mcp/tools/videoWorkbenchTools.ts`
- Modify: `src/renderer/src/features/agent-chat/AgentToolExecutor.ts`(白名单 + switch)
- Test: `src/renderer/src/features/agent-chat/__tests__/AgentToolExecutor.videoWorkbench.test.ts`

**Interfaces:**
- Consumes: `useVideoWorkbenchStore.getState().moveCard(id: string, toIndex: number): void`
- Produces: 工具 `video_workbench_move_task`,返回 `{ order: string[] }`(改动后的卡片 id 顺序)

`apply` 目前是**唯一**能重排顺序的工具。不补这块就退不掉它。

- [ ] **Step 1: 写失败的测试**

```ts
describe('video_workbench_move_task', () => {
  it('把卡片移到指定位置并回新顺序', async () => {
    const ids = useVideoWorkbenchStore.getState().addCards([
      { prompt: 'a' }, { prompt: 'b' }, { prompt: 'c' },
    ])
    const r = await executeAgentTool('video_workbench_move_task', {
      cardId: ids[2], toIndex: 0,
    }) as { order: string[] }

    expect(r.order).toEqual([ids[2], ids[0], ids[1]])
  })

  it('卡不存在时报错', async () => {
    await expect(executeAgentTool('video_workbench_move_task', { cardId: 'nope', toIndex: 0 }))
      .rejects.toThrow(/nope/)
  })

  it('toIndex 越界时报错而不是静默夹紧', async () => {
    const ids = useVideoWorkbenchStore.getState().addCards([{ prompt: 'a' }])
    await expect(executeAgentTool('video_workbench_move_task', { cardId: ids[0], toIndex: 5 }))
      .rejects.toThrow(/toIndex/)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```powershell
npx vitest run src/renderer/src/features/agent-chat/__tests__/AgentToolExecutor.videoWorkbench.test.ts
```

Expected: FAIL — 未知工具名

- [ ] **Step 3: 加白名单 + 执行分支**

白名单加 `case 'video_workbench_move_task':`;switch 里加:

```ts
      case 'video_workbench_move_task': {
        const cardId = typeof params.cardId === 'string' ? params.cardId : ''
        const toIndex = typeof params.toIndex === 'number' ? params.toIndex : -1
        if (!cardId) throw new Error('video_workbench_move_task: cardId is required')

        const cards = useVideoWorkbenchStore.getState().cards
        if (!cards.some((c) => c.id === cardId)) {
          throw new Error(`video_workbench_move_task: 卡片 ${cardId} 不存在`)
        }
        // 越界报错而不是夹紧:夹紧会让「移到第 5 位」静默变成「移到末位」，
        // 模型拿到成功回执却得到了没要的顺序，比失败更难查。
        if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= cards.length) {
          throw new Error(
            `video_workbench_move_task: toIndex ${toIndex} 越界，当前 ${cards.length} 张卡（0..${cards.length - 1}）`,
          )
        }

        store.moveCard(cardId, toIndex)
        return {
          order: useVideoWorkbenchStore.getState().cards.map((c) => c.id),
          workbench: workbenchSummary(),
        }
      }
```

- [ ] **Step 4: 注册 MCP 工具**

```ts
  server.registerTool('video_workbench_move_task', {
    description:
      'Move ONE card to a new position. Use this instead of video_workbench_apply for reordering — '
      + 'apply is declarative over the whole board, so reordering through it means round-tripping every '
      + 'card.\n'
      + 'DO NOT issue several move calls in parallel. Unlike prompt/spec edits, moves are order-dependent: '
      + 'two concurrent moves race and the final order is undefined. Move one card, read the returned '
      + 'order, then decide the next move.',
    inputSchema: z.object({
      cardId: z.string().describe('Card to move. Get ids from video_workbench_status.'),
      toIndex: z.number().int().min(0).describe('0-based target position on the active board.'),
    }),
    annotations: WRITE_IDEMPOTENT,
    outputSchema: z.looseObject({
      order: z.array(z.string()).describe('Card ids in their new order — verify before the next move.'),
      workbench: workbenchSummarySchema,
    }),
  }, async (params, ctx?: unknown) => {
    try {
      const result = await router.call(
        'video_workbench_move_task',
        params as Record<string, unknown>,
        extractCodexThreadId(ctx),
      ) as { order: string[] }
      return okResult([`✓ video_workbench_move_task → ${result.order.length} card(s) reordered.`], result)
    } catch (error) {
      return errorResult('video_workbench_move_task', error)
    }
  })
```

- [ ] **Step 5: 跑测试确认通过**

```powershell
npx vitest run src/renderer/src/features/agent-chat/__tests__/AgentToolExecutor.videoWorkbench.test.ts src/main/mcp/tools/__tests__/toolAnnotations.test.ts
```

Expected: PASS

- [ ] **Step 6: 提交**

```powershell
git add src/main/mcp/tools/videoWorkbenchTools.ts src/renderer/src/features/agent-chat/AgentToolExecutor.ts src/renderer/src/features/agent-chat/__tests__/AgentToolExecutor.videoWorkbench.test.ts
git commit -m "feat(workbench): add per-card move so reordering no longer needs apply"
```

---

## Task 6: apply 降级为结构工具 —— 硬禁批量改提示词

**Files:**
- Modify: `src/renderer/src/features/video-workbench/workbenchIR.ts`(硬闸)
- Modify: `src/main/mcp/tools/videoWorkbenchTools.ts`(description)
- Test: `src/renderer/src/features/video-workbench/__tests__/workbenchIR.test.ts`

**为什么是降级而不是删除。** 单卡工具补齐后 `apply` 在能力上基本冗余了,但它有一件
单卡工具做不到的事:**跨多张卡的原子性**。17 次单卡调用如果第 9 次失败,看板停在
改了一半的状态;`apply` 是全有或全无。保留它作为"整板重建"的兜底。

**但光改描述不够。** 描述是建议,模型可以不听 —— `apply` 自称"多卡改动首选"那次就是
这么把用户拖进 RUNNING 里的。所以这一轮加**硬闸**:

> `apply` 不得修改**已存在卡片**的提示词。

新建卡(IR 里没有 id)可以带提示词,否则没法建;但只要某个 id 已存在、且携带的提示词
与现状不同 → **整份拒绝、零写入**,并点名该用哪个工具。这样"整板提示词往返"在结构上
就不可能发生,而不是靠模型自觉。

- [ ] **Step 1: 写失败的测试**

在 `workbenchIR.test.ts` 追加:

```ts
describe('apply 硬禁改已有卡的提示词', () => {
  it('已存在的卡携带不同提示词时整份拒绝、零写入', () => {
    const before = snapshot()
    expect(() => applyWorkbenchIR({
      boards: [{ cards: [{ id: existingId, prompt: '换了的提示词' }] }],
    })).toThrow(/patch_prompt/)
    expect(snapshot()).toEqual(before)
  })

  it('提示词与现状一致时放行（重排常常会原样带上）', () => {
    expect(() => applyWorkbenchIR({
      boards: [{ cards: [{ id: existingId, prompt: currentPrompt }] }],
    })).not.toThrow()
  })

  it('新建卡可以带提示词', () => {
    expect(() => applyWorkbenchIR({
      boards: [{ cards: [{ prompt: '全新的卡' }] }],
    })).not.toThrow()
  })

  it('只占位条目不受影响', () => {
    expect(() => applyWorkbenchIR({
      boards: [{ cards: [{ id: existingId }] }],
    })).not.toThrow()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```powershell
npx vitest run src/renderer/src/features/video-workbench/__tests__/workbenchIR.test.ts
```

Expected: FAIL — 第一条不抛错

- [ ] **Step 3: 加硬闸**

在 `workbenchIR.ts` 的 apply 主流程里,写入之前:

```ts
  // 硬禁「批量改提示词」。描述里劝过一轮没用 —— apply 是声明式的，模型很容易
  // 顺手把整板提示词都带上，而那正是最慢、最容易中途崩掉的一条路。
  // 新建卡不受限（没有提示词就建不出来）；一致的提示词也放行（重排常原样带上）。
  const promptEdits = claims.filter((c) => {
    if (c.prompt === undefined || c.id === undefined) return false
    const cur = current.get(c.id)
    return cur !== undefined && cur.prompt !== c.prompt
  })
  if (promptEdits.length > 0) {
    const ids = promptEdits.map((c) => c.id).join(', ')
    throw new Error(
      `video_workbench_apply 不能改已有卡片的提示词（${promptEdits.length} 张：${ids}）。`
      + '改几个词用 video_workbench_patch_prompt；整段重写用 video_workbench_update_task。'
      + 'apply 只负责结构：新建、重排、删除。零写入，看板未改动。',
    )
  }
```

- [ ] **Step 4: 跑测试确认通过**

```powershell
npx vitest run src/renderer/src/features/video-workbench/__tests__/workbenchIR.test.ts
```

Expected: PASS(4 条全绿,既有 apply 用例中凡是「改已有卡提示词」的需按新契约改写并
在注释里写明为什么翻)

- [ ] **Step 5: 改写 apply 的描述开头**

在其 description 最前面插入:

```ts
      'STRUCTURE ONLY — this tool CANNOT change the prompt of an existing card. Attempting it is '
      + 'rejected with zero writes.\n'
      + 'Pick the per-card tool instead:\n'
      + '  · a few words of a prompt → video_workbench_patch_prompt\n'
      + '  · one card, several fields → video_workbench_update_task\n'
      + '  · same spec across many cards → video_workbench_set_spec\n'
      + '  · reordering → video_workbench_move_task\n'
      + '  · adding / removing → video_workbench_add_tasks / video_workbench_remove_tasks\n'
      + 'What apply is still for: rebuilding a board wholesale in one atomic shot — all cards change or '
      + 'none do, which no sequence of per-card calls can guarantee. Everything else is faster and safer '
      + 'per-card, because apply is declarative over the WHOLE board.\n'
```

- [ ] **Step 6: 全量回归**

```powershell
npx vitest run src/main/mcp src/renderer/src/features/agent-chat src/renderer/src/features/video-workbench
```

Expected: 全绿

- [ ] **Step 7: 反证硬闸真的在拦**

临时把 Step 3 的 `throw` 注释掉,重跑 `workbenchIR.test.ts`。

Expected: 「整份拒绝、零写入」那条变红。确认后改回。

- [ ] **Step 8: 提交**

```powershell
git add src/renderer/src/features/video-workbench/workbenchIR.ts src/renderer/src/features/video-workbench/__tests__/workbenchIR.test.ts src/main/mcp/tools/videoWorkbenchTools.ts
git commit -m "feat(workbench): reject prompt edits to existing cards in apply"
```

---

## 并发安全性(为什么单卡工具可以不限并发)

`updateCard` / `patch_prompt` / `set_spec` 走的都是 `set((state) => ...)`。zustand 的
函数式 set 是**原子**的 —— updater 在调用时刻拿到最新 state,两个并发调用不会互相
丢更新。加上它们改的是不同卡,天然可交换,所以并发安全。

**唯一的例外是 `move_task`**,已在其描述里写明不要并发。这不是实现缺陷:重排本身
没有交换律,两个并发 move 的最终顺序在数学上就是不确定的。

## Self-Review

**Spec 覆盖**:接口(Task 3)、Match 校验(Task 1)、Uniqueness 校验(Task 1)、卡不存在
/ 生成中(Task 2)、失败零写入 + 回全文(Task 2)、`newText: ''` 删除(Task 1)、反证
(Task 1 Step 5)、滥用缓解(Task 3 描述里的「stuffing the entire prompt into oldText
is strictly worse」+ Task 4 指路)。

**未覆盖且刻意留下**:spec「验收」一节要求的**埋点量基线**。它需要先有一版可用的工具
才能对照量测,且涉及 Anthropic 建议的四个指标(调用耗时 / 调用数 / token / 错误率),
属于独立工作项 —— 建议这四个任务落地后单开一轮,不要塞进本计划假装完成。

**类型一致性**:`patchPromptText` 的返回类型在 Task 1 定义、Task 2 消费,字段名
`ok` / `prompt` / `count` 三处一致;工具名 `video_workbench_patch_prompt` 在 Task 2
白名单、Task 2 switch、Task 3 注册、Task 3 router.call 四处一致。
