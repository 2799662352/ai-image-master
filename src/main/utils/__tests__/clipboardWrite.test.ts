// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  writeImageToClipboard,
  writeTextToClipboard,
  type ClipboardDeps,
} from '../clipboardWrite'

/** 记录构造参数的假 ClipboardItem,模拟 Electron 44+ 的 `new ClipboardItem({ [mime]: Blob })`。 */
class FakeClipboardItem {
  static instances: FakeClipboardItem[] = []
  constructor(public readonly data: Record<string, Blob | string>) {
    FakeClipboardItem.instances.push(this)
  }
}

function makeDeps(overrides: Partial<ClipboardDeps['clipboard']> = {}): {
  deps: ClipboardDeps
  write: ReturnType<typeof vi.fn>
  writeText: ReturnType<typeof vi.fn>
} {
  const write = vi.fn(async () => undefined)
  const writeText = vi.fn(async () => undefined)
  // 故意不提供 writeImage:Electron 44+ 里它不存在,谁调就该直接炸。
  const clipboard = { write, writeText, ...overrides } as ClipboardDeps['clipboard']
  return {
    deps: { clipboard, ClipboardItem: FakeClipboardItem as unknown as ClipboardDeps['ClipboardItem'] },
    write,
    writeText,
  }
}

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

describe('writeImageToClipboard', () => {
  it('把图编码成 PNG,经 clipboard.write([ClipboardItem]) 写入,字节原样', async () => {
    FakeClipboardItem.instances = []
    const { deps, write } = makeDeps()
    const image = { isEmpty: () => false, toPNG: () => Buffer.from(PNG_BYTES) }

    const ok = await writeImageToClipboard(image, deps)

    expect(ok).toBe(true)
    expect(write).toHaveBeenCalledTimes(1)
    const items = write.mock.calls[0][0] as FakeClipboardItem[]
    expect(items).toHaveLength(1)
    expect(Object.keys(items[0].data)).toEqual(['image/png'])
    const blob = items[0].data['image/png'] as Blob
    expect(blob.type).toBe('image/png')
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(PNG_BYTES)
  })

  it('空图:返回 false,不碰剪贴板', async () => {
    const { deps, write } = makeDeps()
    const toPNG = vi.fn(() => Buffer.from(PNG_BYTES))

    const ok = await writeImageToClipboard({ isEmpty: () => true, toPNG }, deps)

    expect(ok).toBe(false)
    expect(toPNG).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it('剪贴板写入失败:向上抛,由调用方包成 { success:false }', async () => {
    const { deps } = makeDeps({ write: vi.fn(async () => { throw new Error('clipboard busy') }) })

    await expect(
      writeImageToClipboard({ isEmpty: () => false, toPNG: () => Buffer.from(PNG_BYTES) }, deps),
    ).rejects.toThrow('clipboard busy')
  })
})

describe('writeTextToClipboard', () => {
  it('调用 clipboard.writeText 并带上原文', () => {
    const { deps, writeText } = makeDeps()
    writeTextToClipboard('https://example.com/a.png', deps)
    expect(writeText).toHaveBeenCalledWith('https://example.com/a.png')
  })

  it('写入失败只交给 onError,不产生未处理的 rejection', async () => {
    const boom = new Error('denied')
    const { deps } = makeDeps({ writeText: vi.fn(async () => { throw boom }) })
    const onError = vi.fn()

    writeTextToClipboard('x', deps, onError)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(onError).toHaveBeenCalledWith(boom)
  })
})
