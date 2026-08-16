import { describe, expect, it } from 'vitest'
import { CodexNotificationRouter } from '../codexNotificationRouter'

/**
 * 在此之前 `item/fileChange/outputDelta` 只往内部 Map 里攒字符串,一律返回
 * null —— 攒的那份唯一的用途是在 `item/completed` 时给缺 `unifiedDiff` 的
 * gateway 兜底。也就是说 diff 的字节在改动进行中就已经躺在主进程里了,只是
 * 谁都没往渲染层递。用户看到的因此是「Applying changes... 空卡」挂很久,然后
 * 整块 diff 啪地一下出现。
 *
 * 这组用例锁住:攒照旧攒(兜底不能坏),但同时要把增量发出去。
 */
describe('fileChange 流式透传', () => {
  it('outputDelta 在继续攒兜底文本的同时发出 item_delta', () => {
    const router = new CodexNotificationRouter()

    expect(
      router.route('item/fileChange/outputDelta', {
        threadId: 't',
        itemId: 'fc-1',
        delta: '@@ -1 +1 @@\n',
      }),
    ).toEqual({
      type: 'item_delta',
      threadId: 't',
      itemId: 'fc-1',
      itemType: 'fileEdit',
      patch: { kind: 'appendText', field: 'diff', text: '@@ -1 +1 @@\n' },
    })

    // 兜底通道必须原样保留:第二段增量继续累加,completed 时拼出完整 diff。
    router.route('item/fileChange/outputDelta', {
      threadId: 't',
      itemId: 'fc-1',
      delta: '-old\n+new\n',
    })

    expect(
      router.route('item/completed', {
        threadId: 't',
        item: { id: 'fc-1', type: 'fileChange', changes: [{ path: 'src/a.ts', kind: 'edit' }] },
      }),
    ).toMatchObject({
      final: {
        changes: [{ path: 'src/a.ts', diff: '@@ -1 +1 @@\n-old\n+new\n', added: 1, removed: 1 }],
      },
    })
  })

  it('itemId 或文本为空时仍然返回 null', () => {
    const router = new CodexNotificationRouter()

    expect(router.route('item/fileChange/outputDelta', { threadId: 't', delta: 'x' })).toBeNull()
    expect(router.route('item/fileChange/outputDelta', { threadId: 't', itemId: 'fc-1', delta: '' })).toBeNull()
  })

  it('item/started 带上 path,好让卡片在第一个增量到达前就有文件名', () => {
    const router = new CodexNotificationRouter()

    expect(
      router.route('item/started', {
        threadId: 't',
        item: { id: 'fc-1', type: 'fileChange', path: 'src/a.ts' },
      }),
    ).toEqual({
      type: 'item_started',
      threadId: 't',
      itemId: 'fc-1',
      itemType: 'fileEdit',
      payload: { path: 'src/a.ts' },
    })
  })

  it('没有 path 时 payload 保持为空,不编造文件名', () => {
    const router = new CodexNotificationRouter()

    expect(
      router.route('item/started', {
        threadId: 't',
        item: { id: 'fc-1', type: 'fileChange' },
      }),
    ).toEqual({
      type: 'item_started',
      threadId: 't',
      itemId: 'fc-1',
      itemType: 'fileEdit',
      payload: {},
    })
  })
})
