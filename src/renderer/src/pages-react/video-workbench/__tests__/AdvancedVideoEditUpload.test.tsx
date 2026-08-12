// 标注帧回填卡片之后,会不会被素材转存接管。
//
// 这条钉的是「别在第二个地方再实现一遍上传」:弹层只产出 data: 参考图,剩下的交给
// materialTransfer —— 和粘贴进来的图同一条路,落同一个桶,回来同样把 src 换成 https。
// 曾经在弹层里单独调过一次 COS 上传,结果是同一件事有两处实现,而粘贴图那份毛病
// (base64 进 IndexedDB、提交时才中转、人像库登记再中转一遍)一个也没修到。
//
// jsdom 里没有 2d 上下文,拍平必然失败,所以只把 flatten 换成替身;上传这一段用真的
// 模块,只在最外层(preload 桥)插桩 —— 验证的是接线,不是 canvas 像素。

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetWorkbenchStoreForTest,
  useVideoWorkbenchStore,
} from '../../../features/video-workbench/store'
import { resetMaterialTransfersForTest } from '../../../features/video-workbench/materialTransfer'
import { resetWorkbenchDbForTest } from '../../../features/video-workbench/WorkbenchDb'
import VideoWorkbenchPage from '../../VideoWorkbenchPage'

/** 'fake' 的 base64 —— 4 字节,够验证「字节被解出来了」。 */
const FRAME_DATA_URL = 'data:image/jpeg;base64,ZmFrZQ=='

vi.mock('../../../features/video-workbench/advancedVideoEdit', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../../features/video-workbench/advancedVideoEdit')
  >()
  return {
    ...actual,
    flattenAnnotatedFrameToDataUrl: vi.fn(async () => ({
      dataUrl: FRAME_DATA_URL,
      width: 1280,
      height: 720,
    })),
  }
})

interface BridgeCalls {
  bytes: Array<{ requestId: string; bytes: ArrayBuffer; mimeType?: string }>
  fromUrl: Array<{ requestId: string; sourceUrl: string }>
}

function installCosBridge(): BridgeCalls {
  const calls: BridgeCalls = { bytes: [], fromUrl: [] }
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = {
    cos: {
      enqueueUploadBytes: (requestId: string, bytes: ArrayBuffer, mimeType?: string) => {
        calls.bytes.push({ requestId, bytes, mimeType })
        return Promise.resolve({ queued: true })
      },
      enqueueUploadFromUrl: (requestId: string, sourceUrl: string) => {
        calls.fromUrl.push({ requestId, sourceUrl })
        return Promise.resolve({ queued: true })
      },
      onUploadResult: () => () => {},
    },
  }
  return calls
}

beforeEach(() => {
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
  resetMaterialTransfersForTest()
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

/** 造一张「2.5 + 编辑视频 + 有视频素材」的卡并铺到页面上,返回卡片 id。 */
function renderEditableCard(): string {
  const [id] = useVideoWorkbenchStore.getState().addCards([
    {
      prompt: '改一下这个镜头',
      model: '2.5',
      mode: 'edit_video',
      referenceVideos: [{ name: 'a.mp4', src: 'https://cdn/a.mp4' }],
    },
  ])
  useVideoWorkbenchStore.setState({ hydrated: true })
  render(<VideoWorkbenchPage />)
  return id
}

/** 开弹层 → 用定位钉点一下(最省事的一条标注)→ 添加这一帧 → 保存到卡片。 */
async function annotateAndSave(): Promise<void> {
  const open = await screen.findByTestId('vw-advanced-edit-open')
  await act(async () => {
    open.click()
  })
  await act(async () => {
    screen.getByRole('button', { name: '定位钉' }).click()
  })
  act(() => {
    fireEvent.pointerDown(screen.getByTestId('vw-ave-canvas'), {
      pointerId: 1,
      clientX: 30,
      clientY: 40,
    })
  })
  await act(async () => {
    screen.getByRole('button', { name: /添加这一帧/ }).click()
  })
  await act(async () => {
    screen.getByRole('button', { name: '保存到卡片' }).click()
  })
}

describe('标注帧回填卡片', () => {
  it('进卡片后由素材转存接管,走字节通道 —— base64 不跨进程', async () => {
    const calls = installCosBridge()
    const id = renderEditableCard()
    await annotateAndSave()

    const card = useVideoWorkbenchStore.getState().cards.find((c) => c.id === id)
    expect(card?.referenceImages).toHaveLength(1)
    // 转存回来之前,卡片先用内联那份撑着(缩略图立刻能看)
    expect(card?.referenceImages[0].src).toBe(FRAME_DATA_URL)

    await vi.waitFor(() => expect(calls.bytes).toHaveLength(1))
    expect(calls.bytes[0].requestId.startsWith('vwmaterial:')).toBe(true)
    expect(calls.bytes[0].mimeType).toBe('image/jpeg')
    expect(calls.bytes[0].bytes.byteLength).toBe(4)
    expect(calls.fromUrl).toHaveLength(0)
  })

  it('添加帧时把实际出图像素说出来 —— 「清不清楚」该是个数字', async () => {
    const { useToastStore } = await import('../../../stores/useToastStore')
    useToastStore.setState({ toasts: [] })
    installCosBridge()
    renderEditableCard()
    await annotateAndSave()
    expect(useToastStore.getState().toasts.some((t) => t.message.includes('1280×720'))).toBe(true)
  })
})
