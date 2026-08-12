// 没有真实路径的素材(网页拖拽 / 剪贴板这类合成 File)该怎么收。
//
// 分界线不是「图片和视频」,是「字节走不走内存」:
//   有路径 → 主进程从磁盘**流式**传 COS,字节既不进渲染进程堆也不进 IPC,没有体积上限;
//   没路径 → 只能整个读进内存再过一次 IPC,而 Electron 的 IPC 对二进制**没有零拷贝**
//            (所有 IPC 方法都经 v8::ValueSerializer 深拷贝,transfer list 只认
//            MessagePort),于是一份载荷同时存在两份副本。
//
// 图片几 MB,这个代价可以接受,而且剪贴板图片没有别的路可走。视频不行:一条网页拖来的
// 视频会以 base64 常驻 IndexedDB、每次提交再过一遍 IPC,而用户明明只要先右键保存到本地
// 就能换来流式上传。所以视频拒收并指路,图片照旧兜底。
//
// 同样的双档口径在聊天栏已经落地(MentionInput 的 MAX_PATH_ATTACHMENT_BYTES 2GB
// vs MAX_BUFFER_ATTACHMENT_BYTES 100MB),这里只是把工作台补齐 —— 它此前一道闸都没有。

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  resetWorkbenchStoreForTest,
  useVideoWorkbenchStore,
} from '../../../features/video-workbench/store'
import { resetWorkbenchDbForTest } from '../../../features/video-workbench/WorkbenchDb'
import { useToastStore } from '../../../stores/useToastStore'
import VideoWorkbenchPage from '../../VideoWorkbenchPage'

beforeEach(() => {
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
  useToastStore.setState({ toasts: [] })
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

/** 造一张「2.5 + 编辑视频」的卡(图片位与视频位都开着),返回卡片 id。 */
function renderCard(): string {
  const [id] = useVideoWorkbenchStore.getState().addCards([
    { prompt: '改一下这个镜头', model: '2.5', mode: 'edit_video' },
  ])
  useVideoWorkbenchStore.setState({ hydrated: true })
  render(<VideoWorkbenchPage />)
  return id
}

function card(id: string) {
  return useVideoWorkbenchStore.getState().cards.find((c) => c.id === id)!
}

/** jsdom 的 File.size 由内容决定,造不出大文件 —— 直接改写它。 */
function sized(file: File, bytes: number): File {
  Object.defineProperty(file, 'size', { value: bytes })
  return file
}

async function pickFile(label: string, file: File): Promise<void> {
  const input = screen.getByLabelText(label)
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } })
  })
}

describe('没有真实路径的素材', () => {
  it('视频不收,并告诉用户存到本地能换来流式上传', async () => {
    const id = renderCard()
    await pickFile('选择视频素材文件', new File(['x'], 'web.mp4', { type: 'video/mp4' }))

    // 先等提示,再看素材:反过来写的话「素材还是空的」可能只是异步没落地的假通过。
    await waitFor(() =>
      expect(
        useToastStore.getState().toasts.some((t) => t.message.includes('先保存到本地')),
      ).toBe(true),
    )
    expect(card(id).referenceVideos).toEqual([])
  })

  it('图片照旧内联兜底 —— 剪贴板截图没有别的路可走', async () => {
    const id = renderCard()
    await pickFile('选择参考图文件', new File(['x'], 'paste.png', { type: 'image/png' }))

    await waitFor(() => expect(card(id).referenceImages).toHaveLength(1))
    expect(card(id).referenceImages[0].src.startsWith('data:')).toBe(true)
  })

  // 类型档之外还需要体积档,理由和聊天栏那套双档一样:内存那条路必须有上限。
  // 数字取 64MB 而不是聊天栏的 100MB,因为下游不同 —— 工作台的素材要靠
  // `cos:enqueue-upload-bytes` 换成 https,而那条 IPC 的 MAX_IPC_UPLOAD_BYTES
  // 正是 64MB。超过它的图片进来了也永远换不成 https,只会以 base64 一遍遍写进
  // IndexedDB。救不回来的东西,别让它进门。
  it('超过 64MB 的图片也不收 —— 进来了也换不成 https', async () => {
    const id = renderCard()
    await pickFile(
      '选择参考图文件',
      sized(new File(['x'], 'huge.png', { type: 'image/png' }), 65 * 1024 * 1024),
    )

    await waitFor(() =>
      expect(useToastStore.getState().toasts.some((t) => t.message.includes('64MB'))).toBe(true),
    )
    expect(card(id).referenceImages).toEqual([])
  })

  it('有真实路径的大文件不受体积闸影响 —— 它根本不进内存', async () => {
    const id = renderCard()
    ;(window as unknown as { electronAPI?: unknown }).electronAPI = {
      getFilePath: () => 'D:/pics/huge.png',
    }
    await pickFile(
      '选择参考图文件',
      sized(new File(['x'], 'huge.png', { type: 'image/png' }), 500 * 1024 * 1024),
    )

    await waitFor(() => expect(card(id).referenceImages).toHaveLength(1))
    expect(card(id).referenceImages[0].src).toBe('D:/pics/huge.png')
  })

  it('有真实路径的视频照收 —— 它走流式,不受这道闸影响', async () => {
    const id = renderCard()
    ;(window as unknown as { electronAPI?: unknown }).electronAPI = {
      getFilePath: () => 'D:/clips/a.mp4',
    }
    await pickFile('选择视频素材文件', new File(['x'], 'a.mp4', { type: 'video/mp4' }))

    await waitFor(() => expect(card(id).referenceVideos).toHaveLength(1))
    expect(card(id).referenceVideos[0].src).toBe('D:/clips/a.mp4')
  })
})
