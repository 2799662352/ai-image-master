import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, within, fireEvent } from '@testing-library/react'
import { LayerStackViewer, layerBoxStyle, type LayerStackEntry } from '../LayerStackViewer'
import { groupResultItems } from '../ResultGrid'
import type { ResultUploadMeta } from '../../../stores/useGenerateStore'

afterEach(() => cleanup())

// useDisplaySrc 会走 blob 物化 / IPC；查看器的行为与 src 无关，直通即可。
vi.mock('../../../hooks/useDisplaySrc', () => ({
  useDisplaySrc: (url: string) => url,
}))

function layerMeta(
  id: string,
  zIndex: number,
  extra: Partial<ResultUploadMeta['layer']> = {},
): ResultUploadMeta {
  return {
    id,
    modelUrl: `https://x/${id}.png`,
    uploadStatus: 'uploaded',
    layerGroupId: 'g1',
    layer: { zIndex, ...extra },
  }
}

/** 把 store 侧的 meta + url 摊成查看器的中性入参（同 ResultGrid 里的适配）。 */
function toEntries(metas: ResultUploadMeta[], urls: string[]): LayerStackEntry[] {
  return metas.map((m, i) => ({
    id: m.id,
    url: urls[i],
    zIndex: m.layer?.zIndex ?? 0,
    ...(m.layer?.name ? { name: m.layer.name } : {}),
    ...(m.layer?.description ? { description: m.layer.description } : {}),
    ...(m.layer?.boundingBox ? { boundingBox: m.layer.boundingBox } : {}),
  }))
}

/** 底图 + 两层。故意乱序传入，组件必须自己排。 */
const METAS = [
  layerMeta('top', 2, { name: '标题文字' }),
  layerMeta('base', 0),
  layerMeta('mid', 1, { name: '前景人物', description: '站立的女性' }),
]
const URLS = ['https://x/top.png', 'https://x/base.png', 'https://x/mid.png']

/**
 * 2026-08-24 对 5.0 Pro 的真机响应（1024×1024 底图，自动全拆）。
 * 图层**不是整幅**，是按 bbox 裁切后放大的，所以叠加必须按 bbox 定位：
 *   星星 bbox 130×124 → 图层 502×484（≈3.87×）
 *   文字 bbox 833×171 → 图层 1301×268（≈1.56×，比底图还宽）
 * 直接 inset-0 摞会把这个小星星拉成全画幅。
 */
const REAL_METAS: ResultUploadMeta[] = [
  layerMeta('base', 0),
  layerMeta('star', 1, {
    name: '白色实心五角星图标',
    boundingBox: { absolute: [832, 840, 962, 964], normalized: [813, 820, 938, 940] },
  }),
  layerMeta('hello', 2, {
    name: 'HELLO白色粗体文字',
    boundingBox: { absolute: [96, 85, 929, 256], normalized: [94, 83, 906, 249] },
  }),
]
const REAL_URLS = ['https://x/base.png', 'https://x/star.png', 'https://x/hello.png']

describe('LayerStackViewer', () => {
  it('列表自上而下 = 从最上层到最下层（PS/Figma 铁律，与 store 的升序相反）', () => {
    render(<LayerStackViewer layers={toEntries(METAS, URLS)} onClose={() => {}} />)

    const rows = within(screen.getByTestId('layer-list')).getAllByRole('listitem')
    // 传入是 top/base/mid，store 里是升序(base→mid→top)，列表必须是 top→mid→base
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('标题文字'),
      expect.stringContaining('前景人物'),
      expect.stringContaining('底图'),
    ])
  })

  it('z0 显示成「底图」而不是「图层 0」', () => {
    render(<LayerStackViewer layers={toEntries(METAS, URLS)} onClose={() => {}} />)
    expect(screen.getByText('底图')).toBeTruthy()
    expect(screen.queryByText('图层 0')).toBeNull()
  })

  it('没有 name 的图层兜底成「图层 N」，不显示空标题', () => {
    render(
      <LayerStackViewer
        layers={toEntries(
          [layerMeta('base', 0), layerMeta('l1', 1)],
          ['https://x/base.png', 'https://x/l1.png'],
        )}
        onClose={() => {}}
      />,
    )
    expect(screen.getByText('图层 1')).toBeTruthy()
  })

  it('叠加预览按 zIndex 升序渲染（后面的 DOM 覆盖前面的 = 正确叠放顺序）', () => {
    render(<LayerStackViewer layers={toEntries(METAS, URLS)} onClose={() => {}} />)

    const canvas = screen.getByTestId('layer-preview-canvas')
    const srcs = [...canvas.querySelectorAll('img')].map((img) => img.getAttribute('src'))
    expect(srcs).toEqual(['https://x/base.png', 'https://x/mid.png', 'https://x/top.png'])
  })

  it('底图撑起坐标系（流式布局），图层绝对定位贴上去', () => {
    render(<LayerStackViewer layers={toEntries(REAL_METAS, REAL_URLS)} onClose={() => {}} />)

    const base = screen.getByTestId('layer-base-image')
    // 底图不能 absolute —— 它得撑起容器高度，bbox 百分比才有对齐的对象
    expect(base.className).not.toContain('absolute')
    expect(base.getAttribute('src')).toBe('https://x/base.png')
  })

  it('图层按 bbox 的千分比定位缩放，而不是 inset-0 铺满（实测:层是裁切放大的）', () => {
    render(<LayerStackViewer layers={toEntries(REAL_METAS, REAL_URLS)} onClose={() => {}} />)

    const positioned = screen.getAllByTestId('layer-overlay-positioned')
    expect(positioned).toHaveLength(2)

    // 星星 normalized [813,820,938,940] → left 81.3% top 82% 宽 12.5% 高 12%
    const star = positioned.find((el) => el.getAttribute('src') === 'https://x/star.png')!
    expect(star.style.left).toBe('81.3%')
    expect(star.style.top).toBe('82%')
    expect(star.style.width).toBe('12.5%')
    expect(star.style.height).toBe('12%')
    // 填满这个框:contain 会在框内再留白一次，把图层缩得比它该在的位置小
    expect(star.style.objectFit).toBe('fill')
  })

  it('没有 bbox 的图层退回整幅（尽力而为，别让它凭空消失）', () => {
    render(<LayerStackViewer layers={toEntries(METAS, URLS)} onClose={() => {}} />)
    // METAS 三层都没给 bbox，除底图外两层都走整幅兜底
    expect(screen.getAllByTestId('layer-overlay-fullbleed')).toHaveLength(2)
    expect(screen.queryAllByTestId('layer-overlay-positioned')).toHaveLength(0)
  })

  it('单层查看看的是原始裁切图，不做 bbox 定位', () => {
    render(<LayerStackViewer layers={toEntries(REAL_METAS, REAL_URLS)} onClose={() => {}} />)

    fireEvent.click(screen.getByText('白色实心五角星图标'))

    const canvas = screen.getByTestId('layer-preview-canvas')
    const imgs = [...canvas.querySelectorAll('img')]
    expect(imgs).toHaveLength(1)
    expect(imgs[0].getAttribute('src')).toBe('https://x/star.png')
    // 单层看的是裁切图本身，不套 bbox；contain 保证不变形
    expect(imgs[0].className).toContain('object-contain')
    expect(imgs[0].style.left).toBe('')
  })
})

describe('layerBoxStyle', () => {
  it('normalized 是 0–1000 千分比 → 除以 10 得百分比（实测印证:832/1024≈81.3%）', () => {
    expect(layerBoxStyle({ normalized: [813, 820, 938, 940] })).toEqual({
      left: '81.3%',
      top: '82%',
      width: '12.5%',
      height: '12%',
    })
  })

  it('只有 absolute 时放弃定位 —— 不知道底图多大就换算不出百分比', () => {
    expect(layerBoxStyle({ absolute: [832, 840, 962, 964] })).toBeNull()
  })

  it('底图 / 缺 bbox → null，调用方按整幅处理', () => {
    expect(layerBoxStyle(undefined)).toBeNull()
    expect(layerBoxStyle({})).toBeNull()
  })

  it('坏 bbox（宽高非正 / 元素不足 / 非数字）一律放弃定位，不渲染成 0 尺寸让层消失', () => {
    expect(layerBoxStyle({ normalized: [500, 500, 500, 900] })).toBeNull()
    expect(layerBoxStyle({ normalized: [900, 500, 100, 900] })).toBeNull()
    expect(layerBoxStyle({ normalized: [1, 2, 3] })).toBeNull()
    expect(layerBoxStyle({ normalized: [1, 2, 3, null as unknown as number] })).toBeNull()
  })

  it('默认全部可见 —— 打开就该看到还原后的完整画面', () => {
    render(<LayerStackViewer layers={toEntries(METAS, URLS)} onClose={() => {}} />)
    expect(screen.getByTestId('layer-preview-mode').textContent).toContain('3/3 层可见')
  })

  it('眼睛开关隐藏该层，预览里用 visibility 隐藏而不是卸载', () => {
    render(<LayerStackViewer layers={toEntries(METAS, URLS)} onClose={() => {}} />)

    fireEvent.click(screen.getByLabelText('隐藏前景人物'))

    expect(screen.getByTestId('layer-preview-mode').textContent).toContain('2/3 层可见')
    const canvas = screen.getByTestId('layer-preview-canvas')
    // 仍然在 DOM 里（切回来不用重新解码），只是不可见
    const mid = [...canvas.querySelectorAll('img')].find(
      (img) => img.getAttribute('src') === 'https://x/mid.png',
    )
    expect(mid).toBeTruthy()
    expect(mid!.getAttribute('style')).toContain('visibility: hidden')
  })

  it('点行进入单层查看，只渲染那一层', () => {
    render(<LayerStackViewer layers={toEntries(METAS, URLS)} onClose={() => {}} />)

    fireEvent.click(screen.getByTitle('站立的女性'))

    expect(screen.getByTestId('layer-preview-mode').textContent).toContain('单层：前景人物')
    const canvas = screen.getByTestId('layer-preview-canvas')
    const srcs = [...canvas.querySelectorAll('img')].map((img) => img.getAttribute('src'))
    expect(srcs).toEqual(['https://x/mid.png'])
  })

  it('Esc 逐级退出：单层态先回叠加，不直接关窗', () => {
    const onClose = vi.fn()
    render(<LayerStackViewer layers={toEntries(METAS, URLS)} onClose={onClose} />)

    fireEvent.click(screen.getByTitle('站立的女性'))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByTestId('layer-preview-mode').textContent).toContain('叠加预览')

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('讲清计费口径 —— 用户最容易误判的就是「一次拆分算几张钱」', () => {
    render(<LayerStackViewer layers={toEntries(METAS, URLS)} onClose={() => {}} />)
    expect(screen.getByText(/1 底图 \+ 2 图层/)).toBeTruthy()
    expect(screen.getByText('按张计费')).toBeTruthy()
  })
})

describe('groupResultItems', () => {
  it('普通结果一张一格（不分组时行为完全不变）', () => {
    const items = groupResultItems(['a.png', 'b.png'], [
      { id: '1', modelUrl: 'a.png', uploadStatus: 'uploaded' },
      { id: '2', modelUrl: 'b.png', uploadStatus: 'uploaded' },
    ])
    expect(items).toEqual([{ index: 0 }, { index: 1 }])
  })

  it('没有 meta 时按 urls 逐张出格', () => {
    expect(groupResultItems(['a.png', 'b.png'])).toEqual([{ index: 0 }, { index: 1 }])
  })

  it('同一组图层收成一张卡片，成员齐全', () => {
    const items = groupResultItems(URLS, METAS)
    expect(items).toHaveLength(1)
    expect(items[0].group).toHaveLength(3)
  })

  it('卡片封面用底图 —— 拿透明图层当封面等于一张空白卡', () => {
    // 传入顺序里 top(z2) 在前，封面必须让位给 base(z0)
    const items = groupResultItems(URLS, METAS)
    expect(items[0].index).toBe(1)
    expect(URLS[items[0].index]).toBe('https://x/base.png')
  })

  it('图层组与普通结果混排时保留各自的原索引（放大预览/重编辑按下标回调）', () => {
    const urls = ['plain.png', ...URLS, 'plain2.png']
    const metas: ResultUploadMeta[] = [
      { id: 'p1', modelUrl: 'plain.png', uploadStatus: 'uploaded' },
      ...METAS,
      { id: 'p2', modelUrl: 'plain2.png', uploadStatus: 'uploaded' },
    ]
    const items = groupResultItems(urls, metas)
    expect(items).toHaveLength(3)
    expect(items[0]).toEqual({ index: 0 })
    expect(items[1].group?.map((g) => g.index)).toEqual([1, 2, 3])
    expect(items[2]).toEqual({ index: 4 })
  })

  it('两次拆分互不混淆（按 layerGroupId 分，不按相邻）', () => {
    const metas: ResultUploadMeta[] = [
      { id: 'a', modelUrl: 'a', uploadStatus: 'uploaded', layerGroupId: 'g1', layer: { zIndex: 0 } },
      { id: 'b', modelUrl: 'b', uploadStatus: 'uploaded', layerGroupId: 'g2', layer: { zIndex: 0 } },
      { id: 'c', modelUrl: 'c', uploadStatus: 'uploaded', layerGroupId: 'g1', layer: { zIndex: 1 } },
    ]
    const items = groupResultItems(['a', 'b', 'c'], metas)
    expect(items).toHaveLength(2)
    expect(items[0].group?.map((g) => g.meta.id)).toEqual(['a', 'c'])
    expect(items[1].group?.map((g) => g.meta.id)).toEqual(['b'])
  })
})
