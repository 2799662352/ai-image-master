// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/react'
import BatchRefDrop from './BatchRefDrop'
import type { BatchRefImage } from '../../stores/useBatchStore'

// 受控的上传桩:记录并发峰值,用一个可控延时模拟"读图+压缩/上传"耗时。
let inFlight = 0
let maxInFlight = 0
const uploadMock = vi.fn(async (file: File) => {
  inFlight++
  maxInFlight = Math.max(maxInFlight, inFlight)
  await new Promise((r) => setTimeout(r, 20))
  inFlight--
  return {
    ok: true,
    viaCos: false,
    cosSkipped: true,
    src: `data:image/png;base64,${file.name}`,
    compressed: false,
    originalSize: file.size,
    fileSize: file.size,
  }
})

vi.mock('../../utils/refImageUpload', () => ({
  uploadRefImageOriginalFirst: (file: File) => uploadMock(file),
}))

vi.mock('../../stores/useToastStore', () => ({
  useToastStore: (sel: any) => sel({ addToast: vi.fn() }),
}))

function makeFile(name: string): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' })
}

function renderDrop(onAdd: (img: BatchRefImage) => void) {
  return render(
    <BatchRefDrop images={[]} onAdd={onAdd} onRemove={() => {}} onClear={() => {}} />,
  )
}

describe('BatchRefDrop 并发上传', () => {
  beforeEach(() => {
    inFlight = 0
    maxInFlight = 0
    uploadMock.mockClear()
  })

  it('多张同时上传是并发的(不再一张张串行阻塞),且按输入顺序 onAdd', async () => {
    const added: string[] = []
    const onAdd = (img: BatchRefImage) => {
      added.push(img.base64)
    }
    const { container } = renderDrop(onAdd)
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    expect(input).toBeTruthy()

    const files = ['a.png', 'b.png', 'c.png', 'd.png'].map(makeFile)
    fireEvent.change(input, { target: { files } })

    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(4))
    // 并发的核心证据:同一时刻有多于 1 个上传在飞(串行实现下峰值恒为 1)。
    expect(maxInFlight).toBeGreaterThan(1)

    await waitFor(() => expect(added).toHaveLength(4))
    // 顺序保留:onAdd 按输入文件顺序追加。
    expect(added).toEqual([
      'data:image/png;base64,a.png',
      'data:image/png;base64,b.png',
      'data:image/png;base64,c.png',
      'data:image/png;base64,d.png',
    ])
  })
})
