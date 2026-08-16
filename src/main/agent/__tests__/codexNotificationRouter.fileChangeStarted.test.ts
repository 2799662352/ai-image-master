import { describe, expect, it } from 'vitest'
import { CodexNotificationRouter } from '../codexNotificationRouter'

/**
 * 上游 README 的 fileChange 审批时序第 1 步写得很直白:
 *
 *   `item/started` — emits a `fileChange` item with `changes` (diff chunk
 *   summaries) and `status: "inProgress"`. **Show the proposed edits and paths
 *   to the user.**
 *
 * 也就是说完整的提议改动在 item/started 当场就有了 —— 无条件、不依赖任何
 * feature flag、也不依赖 gateway 是否转发那两条增量通知。而我们此前只从这条
 * 里取了 `path`,把 `changes` 整个扔掉,然后一直空卡等到 item/completed。
 * 「空卡挂几十秒再整块弹出」的最直接成因就在这里。
 */
describe('fileChange item/started 带出提议改动', () => {
  it('把 changes 一并交给渲染层,而不是只给一个 path', () => {
    const router = new CodexNotificationRouter()

    expect(
      router.route('item/started', {
        threadId: 't',
        item: {
          id: 'fc-1',
          type: 'fileChange',
          status: 'inProgress',
          changes: [
            { path: 'src/a.ts', kind: 'edit', unifiedDiff: '@@ -1 +1 @@\n-old\n+new\n' },
            { path: 'src/b.ts', kind: 'create', unifiedDiff: '@@ -0,0 +1 @@\n+hi\n' },
          ],
        },
      }),
    ).toEqual({
      type: 'item_started',
      threadId: 't',
      itemId: 'fc-1',
      itemType: 'fileEdit',
      payload: {
        changes: [
          { path: 'src/a.ts', operation: 'edit', diff: '@@ -1 +1 @@\n-old\n+new\n', added: 1, removed: 1 },
          { path: 'src/b.ts', operation: 'create', diff: '@@ -0,0 +1 @@\n+hi\n', added: 1, removed: 0 },
        ],
      },
    })
  })

  it('没有 changes 时退回原来的 path 占位', () => {
    const router = new CodexNotificationRouter()

    expect(
      router.route('item/started', {
        threadId: 't',
        item: { id: 'fc-1', type: 'fileChange', path: 'src/a.ts' },
      }),
    ).toMatchObject({ payload: { path: 'src/a.ts' } })
  })

  it('changes 是空数组时也退回 path,不塞一个空列表', () => {
    const router = new CodexNotificationRouter()

    expect(
      router.route('item/started', {
        threadId: 't',
        item: { id: 'fc-1', type: 'fileChange', changes: [], path: 'src/a.ts' },
      }),
    ).toMatchObject({ payload: { path: 'src/a.ts' } })
  })
})
