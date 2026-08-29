import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSendMessagePayload } from '../../../../../types/agent'
import { MentionInput } from '../MentionInput'
import { useAgentChatStore } from '../store'

afterEach(cleanup)

function clipboardDataWith(files: File[], text = ''): DataTransfer {
  return {
    files: files as unknown as FileList,
    items: files.map((file) => ({
      kind: 'file',
      type: file.type,
      getAsFile: () => file,
    })) as unknown as DataTransferItemList,
    types: files.length > 0 ? ['Files'] : ['text/plain'],
    getData: (type: string) => (type === 'text/plain' ? text : ''),
    setData: () => {},
  } as unknown as DataTransfer
}

function screenshotFile(): { file: File; bytes: Uint8Array } {
  const bytes = new Uint8Array([137, 80, 78, 71])
  const file = new File([bytes], 'image.png', { type: 'image/png' })
  Object.defineProperty(file, 'arrayBuffer', {
    configurable: true,
    value: vi.fn(async () => bytes.buffer.slice(0)),
  })
  return { file, bytes }
}

describe('MentionInput clipboard screenshots', () => {
  // 参数**必须**声明出来。写成 `vi.fn(async () => …)` 时,推断出的调用签名是零参 ——
  // 于是 `mock.calls` 的元素类型是空元组 `[]`,`calls[0][0]` 既越界(TS2493)、类型又是
  // `undefined`(往 AgentSendMessagePayload 强转触发 TS2352)。声明参数之后
  // `calls[0][0]` 天然就是 payload 类型,下面那个 `as` 也就不需要了。
  const sendMessage = vi.fn(async (_payload: AgentSendMessagePayload) => ({
    threadId: 'thread-1',
  }))

  beforeEach(() => {
    sendMessage.mockClear()
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        agent: { sendMessage, cancel: vi.fn() },
        getFilePath: vi.fn(() => ''),
      },
    })
    useAgentChatStore.setState({
      input: '',
      attachments: [],
      pendingReferences: [],
      isRunning: false,
      error: undefined,
    } as never)
  })

  it('turns a pasted screenshot into an in-memory image attachment and sends it', async () => {
    const { file, bytes } = screenshotFile()
    render(<MentionInput />)
    const textarea = screen.getByRole('textbox')

    const allowedDefaultPaste = fireEvent.paste(textarea, {
      clipboardData: clipboardDataWith([file]),
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(allowedDefaultPaste).toBe(false)
    const [attachment] = useAgentChatStore.getState().attachments
    expect(attachment).toMatchObject({
      name: 'image.png',
      mime: 'image/png',
      size: file.size,
    })
    expect(Array.from(new Uint8Array(attachment.buffer!))).toEqual(Array.from(bytes))
    expect(attachment.path).toBeUndefined()
    expect(useAgentChatStore.getState().pendingReferences).toEqual([])

    fireEvent.submit(textarea.closest('form')!)
    await new Promise((resolve) => setTimeout(resolve, 0))

    const payload = sendMessage.mock.calls[0][0]
    expect(payload.attachments?.[0]).toMatchObject({
      name: 'image.png',
      mime: 'image/png',
      size: file.size,
    })
  })

  it('leaves ordinary text paste to the native textarea behavior', () => {
    render(<MentionInput />)
    const textarea = screen.getByRole('textbox')

    const allowedDefaultPaste = fireEvent.paste(textarea, {
      clipboardData: clipboardDataWith([], 'normal text'),
    })

    expect(allowedDefaultPaste).toBe(true)
    expect(useAgentChatStore.getState().attachments).toEqual([])
  })
})
