// 「高级编辑」标注核心单测。
//
// 这些几何计算没有界面可看:橡皮擦错一点点、拍平时坐标没跟着缩放,出来的图看着
// 「差不多」,却会把上游往错的位置引。所以逐条钉住。

import { describe, expect, it, vi } from 'vitest'
import {
  ERASER_RADIUS_PX,
  eraseAnnotationsAtPoint,
  flattenAnnotatedFrameToDataUrl,
  formatTimestamp,
  frameAnnotationLabel,
  paintFrameAnnotation,
  renumberPins,
  type AnnotationPin,
  type AnnotationStroke,
  type FrameAnnotation,
} from '../advancedVideoEdit'

function rect(x: number, y: number, w = 40, h = 30): FrameAnnotation {
  return { kind: 'rect', x, y, w, h, color: '#ef4444', strokeWidth: 3 }
}

function stroke(points: Array<[number, number]>): AnnotationStroke {
  return { kind: 'stroke', points: points.map(([x, y]) => ({ x, y })), color: '#ef4444', strokeWidth: 4 }
}

function pin(x: number, y: number, index: number): AnnotationPin {
  return { kind: 'pin', x, y, index }
}

describe('时间与标签', () => {
  it('formatTimestamp 补零到 MM:SS,负数按 0 处理', () => {
    expect(formatTimestamp(0)).toBe('00:00')
    expect(formatTimestamp(4.9)).toBe('00:04')
    expect(formatTimestamp(65)).toBe('01:05')
    expect(formatTimestamp(-3)).toBe('00:00')
  })

  it('frameAnnotationLabel 就是素材名 / 列表文案的唯一出处', () => {
    expect(frameAnnotationLabel(64)).toBe('01:04 视频帧标注')
  })
})

describe('eraseAnnotationsAtPoint', () => {
  // 橡皮是逐 pointermove 调的:什么都没擦到还造新数组,等于每次移动都让 React
  // 白重渲染一轮标注列表。这条锁的是引用相等,不是内容相等。
  it('没擦到任何东西时返回原数组引用', () => {
    const anns: FrameAnnotation[] = [rect(10, 10)]
    expect(eraseAnnotationsAtPoint(anns, { x: 500, y: 500 }, ERASER_RADIUS_PX)).toBe(anns)
  })

  it('擦到矩形边框 → 整条删掉(命中的是边不是填充区)', () => {
    const anns: FrameAnnotation[] = [rect(10, 10, 40, 30)]
    // 左上角边框上
    expect(eraseAnnotationsAtPoint(anns, { x: 10, y: 12 }, ERASER_RADIUS_PX)).toHaveLength(0)
    // 矩形正中间是空的,不该命中
    expect(eraseAnnotationsAtPoint(anns, { x: 30, y: 25 }, 2)).toBe(anns)
  })

  it('擦笔画中段 → 拆成两条,而不是整条消失', () => {
    // 采样要够密:命中一条线段会连带删掉它的两个端点,点距远大于橡皮半径时
    // 一擦就会把整条抹平(下一条用例锁的正是那个行为)。
    const points: Array<[number, number]> = []
    for (let x = 0; x <= 100; x += 5) points.push([x, 0])
    const out = eraseAnnotationsAtPoint([stroke(points)], { x: 50, y: 0 }, 6)

    expect(out).toHaveLength(2)
    const [a, b] = out as AnnotationStroke[]
    // 擦口两侧各自成段,首尾端点仍在
    expect(a.points[0]).toEqual({ x: 0, y: 0 })
    expect(b.points[b.points.length - 1]).toEqual({ x: 100, y: 0 })
    // 擦口附近的点被清掉了
    expect(a.points.every((p) => p.x < 45)).toBe(true)
    expect(b.points.every((p) => p.x > 55)).toBe(true)
  })

  // 只判采样点的话,橡皮落在两点之间会「怎么擦都擦不掉」。这条锁线段命中:
  // 两点式笔画在中点被擦时整条消失 —— 只判点的实现会原样留着。
  it('橡皮落在两个采样点之间也算命中', () => {
    const anns: FrameAnnotation[] = [stroke([[0, 0], [100, 0]])]
    const out = eraseAnnotationsAtPoint(anns, { x: 50, y: 1 }, 6)
    expect(out).not.toBe(anns)
    expect(out).toHaveLength(0)
  })

  it('删掉中间的定位钉后重新编号 —— 提示词按序号指代,断号会指错', () => {
    const anns: FrameAnnotation[] = [pin(10, 10, 1), pin(50, 50, 2), pin(90, 90, 3)]
    const out = eraseAnnotationsAtPoint(anns, { x: 50, y: 50 }, ERASER_RADIUS_PX)
    expect(out.map((a) => (a.kind === 'pin' ? a.index : null))).toEqual([1, 2])
  })

  it('renumberPins 不动非钉标注,也不为已连续的序号造新对象', () => {
    const p1 = pin(1, 1, 1)
    const r = rect(0, 0)
    const out = renumberPins([p1, r])
    expect(out[0]).toBe(p1)
    expect(out[1]).toBe(r)
  })
})

/** 只记录调用的假 ctx —— 断言坐标/线宽有没有跟着缩放。 */
function fakeCtx() {
  const calls: Array<{ fn: string; args: unknown[] }> = []
  const ctx = {
    calls,
    lineWidth: 0,
    strokeStyle: '',
    fillStyle: '',
    font: '',
    lineJoin: '',
    lineCap: '',
    textAlign: '',
    textBaseline: '',
    strokeRect: (...args: unknown[]) => calls.push({ fn: 'strokeRect', args }),
    fillText: (...args: unknown[]) => calls.push({ fn: 'fillText', args }),
    beginPath: () => calls.push({ fn: 'beginPath', args: [] }),
    moveTo: (...args: unknown[]) => calls.push({ fn: 'moveTo', args }),
    lineTo: (...args: unknown[]) => calls.push({ fn: 'lineTo', args }),
    stroke: () => calls.push({ fn: 'stroke', args: [] }),
    arc: (...args: unknown[]) => calls.push({ fn: 'arc', args }),
    fill: () => calls.push({ fn: 'fill', args: [] }),
    closePath: () => calls.push({ fn: 'closePath', args: [] }),
  }
  return ctx as unknown as CanvasRenderingContext2D & { calls: typeof calls; lineWidth: number }
}

describe('paintFrameAnnotation 缩放', () => {
  // 标注坐标记在**显示空间**,拍平却要按视频原始分辨率出图。漏乘 sx/sy 的话
  // 图能出来、位置全错,而且肉眼在缩略图上看不出来。
  it('矩形坐标与线宽按 sx/sy 缩放', () => {
    const ctx = fakeCtx()
    paintFrameAnnotation(ctx, rect(10, 20, 30, 40), 2, 2)
    const call = ctx.calls.find((c) => c.fn === 'strokeRect')
    expect(call?.args).toEqual([20, 40, 60, 80])
    expect(ctx.lineWidth).toBe(6)
  })

  it('文字位置跟随缩放,空文本回落到默认字样', () => {
    const ctx = fakeCtx()
    paintFrameAnnotation(
      ctx,
      { kind: 'text', x: 5, y: 6, text: '', color: '#fff', fontSize: 20 },
      3,
      3,
    )
    const call = ctx.calls.find((c) => c.fn === 'fillText')
    expect(call?.args).toEqual(['文字', 15, 18])
  })

  it('单点笔画不画 —— 画出来是个看不见的点,只会污染撤销栈', () => {
    const ctx = fakeCtx()
    paintFrameAnnotation(ctx, stroke([[1, 1]]))
    expect(ctx.calls.some((c) => c.fn === 'stroke')).toBe(false)
  })

  it('箭头比直线多画两笔箭头脚', () => {
    const base = { kind: 'line' as const, x1: 0, y1: 0, x2: 50, y2: 0, color: '#fff', strokeWidth: 3 }
    const plain = fakeCtx()
    paintFrameAnnotation(plain, { ...base, arrowHead: false })
    const arrow = fakeCtx()
    paintFrameAnnotation(arrow, { ...base, arrowHead: true })
    expect(arrow.calls.filter((c) => c.fn === 'lineTo').length)
      .toBeGreaterThan(plain.calls.filter((c) => c.fn === 'lineTo').length)
  })
})

/** 假视频元素:jsdom 没有真解码,这里只需要 readyState / 尺寸 / currentTime。 */
function fakeVideo(patch: Partial<HTMLVideoElement> = {}): HTMLVideoElement {
  return {
    readyState: 4,
    videoWidth: 1920,
    videoHeight: 1080,
    duration: 10,
    currentTime: 3,
    addEventListener: () => {},
    removeEventListener: () => {},
    ...patch,
  } as unknown as HTMLVideoElement
}

describe('flattenAnnotatedFrameToDataUrl', () => {
  it('视频还没就绪就抽帧 → 报人话,而不是画出一张空白图', async () => {
    await expect(
      flattenAnnotatedFrameToDataUrl({
        video: fakeVideo({ readyState: 1 }),
        displayWidth: 640,
        displayHeight: 360,
        annotations: [],
        timeSec: 1,
      }),
    ).rejects.toThrow('视频尚未就绪')
  })

  it('按视频原始分辨率出图,并把显示坐标缩放上去', async () => {
    const drawImage = vi.fn()
    const strokeRect = vi.fn()
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage,
        strokeRect,
        lineJoin: '',
        lineCap: '',
        lineWidth: 0,
        strokeStyle: '',
      }),
      toDataURL: () => 'data:image/jpeg;base64,ok',
    } as unknown as HTMLCanvasElement
    const spy = vi.spyOn(document, 'createElement').mockReturnValue(canvas)

    const frame = await flattenAnnotatedFrameToDataUrl({
      video: fakeVideo(),
      displayWidth: 960, // 视频 1920 → 缩放系数 2
      displayHeight: 540,
      annotations: [rect(10, 20, 30, 40)],
      timeSec: 3,
    })

    expect(frame.dataUrl).toBe('data:image/jpeg;base64,ok')
    expect(canvas.width).toBe(1920)
    expect(canvas.height).toBe(1080)
    // 出图尺寸要带回去:界面拿它告诉用户「这张就是 1920×1080」——「糊不糊」得是
    // 一个能看见的数字,否则只能靠猜(而真正的上限是源视频,不是我们这段代码)。
    expect(frame.width).toBe(1920)
    expect(frame.height).toBe(1080)
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1920, 1080)
    expect(strokeRect).toHaveBeenCalledWith(20, 40, 60, 80)
    spy.mockRestore()
  })

  // 跨域视频会污染 canvas,原始报错只有一句 "Tainted canvases may not be exported"。
  it('canvas 被跨域污染时给出可操作的中文错误', async () => {
    const err = new Error('Tainted canvases may not be exported.')
    err.name = 'SecurityError'
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: () => {}, lineJoin: '', lineCap: '' }),
      toDataURL: () => {
        throw err
      },
    } as unknown as HTMLCanvasElement
    const spy = vi.spyOn(document, 'createElement').mockReturnValue(canvas)

    await expect(
      flattenAnnotatedFrameToDataUrl({
        video: fakeVideo(),
        displayWidth: 960,
        displayHeight: 540,
        annotations: [],
        timeSec: 3,
      }),
    ).rejects.toThrow('未开放跨域')
    spy.mockRestore()
  })
})
