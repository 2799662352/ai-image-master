import { describe, expect, it } from 'vitest'
import { CodexNotificationRouter } from '../codexNotificationRouter'

/**
 * `item/fileChange/patchUpdated` 之前一条都没接,只会掉进「unhandled
 * notification」日志。它和 `outputDelta` 是并列注册的通知(在 codex 二进制的
 * 方法表里紧挨着),但带的是**结构化累积的 `changes` 数组** —— 形状与
 * `item/completed` 相同,因此有真实路径、支持多文件、是真的 unified diff,
 * 比裸文本的 outputDelta 好得多。
 */
describe('fileChange patchUpdated 结构化流式', () => {
  it('把累积的 changes 整体合并进卡片', () => {
    const router = new CodexNotificationRouter()

    expect(
      router.route('item/fileChange/patchUpdated', {
        threadId: 't',
        itemId: 'fc-1',
        changes: [
          { path: 'src/a.ts', kind: 'edit', unifiedDiff: '@@ -1 +1 @@\n-old\n+new\n' },
          { path: 'src/b.ts', kind: 'create', unifiedDiff: '@@ -0,0 +1 @@\n+hi\n' },
        ],
      }),
    ).toEqual({
      type: 'item_delta',
      threadId: 't',
      itemId: 'fc-1',
      itemType: 'fileEdit',
      patch: {
        kind: 'mergeFields',
        fields: {
          changes: [
            { path: 'src/a.ts', operation: 'edit', diff: '@@ -1 +1 @@\n-old\n+new\n', added: 1, removed: 1 },
            { path: 'src/b.ts', operation: 'create', diff: '@@ -0,0 +1 @@\n+hi\n', added: 1, removed: 0 },
          ],
          totalAdded: 2,
          totalRemoved: 1,
        },
      },
    })
  })

  it('形状不对时安静地丢掉,不往卡片里塞垃圾', () => {
    const router = new CodexNotificationRouter()

    expect(router.route('item/fileChange/patchUpdated', { threadId: 't', itemId: 'fc-1' })).toBeNull()
    expect(router.route('item/fileChange/patchUpdated', { threadId: 't', changes: [] })).toBeNull()
  })

  /**
   * 两条通道可能同时来。结构化的那份是权威 —— 一旦见过 patchUpdated,就不再
   * 把裸文本往 changes[0] 上追加,否则两边会互相覆盖、卡片来回跳。
   * 但兜底缓存要继续攒:completed 时若 gateway 仍旧漏发 unifiedDiff,还得靠它。
   */
  it('见过 patchUpdated 之后,outputDelta 不再往渲染层发,但兜底照攒', () => {
    const router = new CodexNotificationRouter()

    router.route('item/fileChange/patchUpdated', {
      threadId: 't',
      itemId: 'fc-1',
      changes: [{ path: 'src/a.ts', kind: 'edit', unifiedDiff: '@@ -1 +1 @@\n-old\n' }],
    })

    expect(
      router.route('item/fileChange/outputDelta', { threadId: 't', itemId: 'fc-1', delta: '@@ -1 +1 @@\n+new\n' }),
    ).toBeNull()

    // 另一个 item 不受影响。
    expect(
      router.route('item/fileChange/outputDelta', { threadId: 't', itemId: 'fc-2', delta: '@@ -9 +9 @@\n+x\n' }),
    ).toMatchObject({ type: 'item_delta', itemId: 'fc-2' })

    // 兜底缓存仍然收到了 fc-1 的那段文本。
    expect(
      router.route('item/completed', {
        threadId: 't',
        item: { id: 'fc-1', type: 'fileChange', changes: [{ path: 'src/a.ts', kind: 'edit' }] },
      }),
    ).toMatchObject({ final: { changes: [{ path: 'src/a.ts', diff: '@@ -1 +1 @@\n+new\n' }] } })
  })

  /**
   * item/started 已经给了完整快照,它同样是权威来源 —— 后续的裸文本不能再往
   * 上追加,否则同一份 diff 会被拼两遍、+N/−N 直接翻倍。
   *
   * 这个洞是「先有 patchUpdated 抑制、后加 item/started 快照」留下的:抑制集
   * 合当初只在 patchUpdated 分支填,新增第二个快照源时没跟着扩。
   */
  it('item/started 带了 changes 之后,outputDelta 不再往上追加', () => {
    const router = new CodexNotificationRouter()

    router.route('item/started', {
      threadId: 't',
      item: {
        id: 'fc-1',
        type: 'fileChange',
        changes: [{ path: 'src/a.ts', kind: 'edit', unifiedDiff: '@@ -1 +1 @@\n-old\n+new\n' }],
      },
    })

    expect(
      router.route('item/fileChange/outputDelta', {
        threadId: 't',
        itemId: 'fc-1',
        delta: '@@ -1 +1 @@\n-old\n+new\n',
      }),
    ).toBeNull()
  })

  it('turn 结束后清掉抑制标记,下一轮的同名 item 不受影响', () => {
    const router = new CodexNotificationRouter()

    router.route('item/fileChange/patchUpdated', {
      threadId: 't',
      itemId: 'fc-1',
      changes: [{ path: 'src/a.ts', kind: 'edit', unifiedDiff: '-old\n' }],
    })
    router.route('turn/completed', { threadId: 't', turn: { id: 'turn-1' } })

    expect(
      router.route('item/fileChange/outputDelta', { threadId: 't', itemId: 'fc-1', delta: '@@ -1 +1 @@\n+new\n' }),
    ).toMatchObject({ type: 'item_delta' })
  })
})
