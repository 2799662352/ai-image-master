/**
 * 生成页结果区 · 状态卡族(设计稿 M5):
 *   运行中 → 失败 → 完成(新在前);点「开始生成」的一瞬间 RUN 卡就在第一格;
 *   失败卡带「重试 / 复制错误 / ×」;完成卡 ↺ EDIT / ↓ / × / 点图放大照旧。
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerateRun, ResultUploadMeta } from '../../../stores/useGenerateStore'
import { ResultGrid } from '../ResultGrid'

vi.mock('../../../components/shared/image-editors/ImageEditToolbar', () => ({ default: () => null }))
vi.mock('../../../components/shared/image-editors/ImageEditorModal', () => ({ default: () => null }))
vi.mock('../LayerStackViewer', () => ({ LayerStackViewer: () => null }))

afterEach(() => cleanup())

const COS = 'https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/image-history/2026/09/15/'
const snapshot = (prompt: string) => ({ prompt, ratio: '1:1', referenceImages: [], modelKey: 'gpt-image-2.5-flare' })

function meta(id: string, createdAt: number, prompt: string): ResultUploadMeta {
  return { id, modelUrl: `${COS}${id}.png`, cosUrl: `${COS}${id}.png`, uploadStatus: 'uploaded', snapshot: snapshot(prompt), createdAt, elapsedMs: 24_900, resolution: '2K', modelKey: 'gpt-image-2.5-flare' }
}

function run(id: string, status: GenerateRun['status'], prompt: string, startedAt: number, error?: string): GenerateRun {
  return {
    id,
    status,
    startedAt,
    prompt,
    modelKey: 'gpt-image-2.5-flare',
    ratio: '16:9',
    resolution: '2K',
    count: 1,
    error,
    snapshot: snapshot(prompt),
    overrides: { prompt, referenceImages: [], resolution: '2K', ratio: '16:9', count: 1, quality: 'auto', transparentBackground: false, layerDecomposition: false },
  }
}

describe('ResultGrid · status card family', () => {
  it('orders cards running → failed → done (newest first) and numbers them by creation order', () => {
    const urls = [`${COS}a.png`, `${COS}b.png`]
    const metas = [meta('a', 1000, '春'), meta('b', 2000, '夏')]
    const runs = [run('r2', 'running', '冬', 4000), run('r1', 'error', '秋', 3000, 'HTTP 500')]
    render(<ResultGrid urls={urls} meta={metas} runs={runs} />)

    const cards = Array.from(document.querySelectorAll('[data-status]'))
    expect(cards.map((c) => c.getAttribute('data-status'))).toEqual(['running', 'error', 'done', 'done'])
    // Prompts follow the same order; done cards newest first (夏 before 春).
    expect(cards.map((c) => c.querySelector('p')?.textContent)).toEqual(['冬', '秋', '夏', '春'])
    // Sequence numbers: results #001/#002 by insertion, runs continue after them.
    expect(cards.map((c) => c.textContent?.match(/#\d{3}/)?.[0])).toEqual(['#004', '#003', '#002', '#001'])
  })

  it('RUN card shows the model label, ratio, resolution and an elapsed counter with the expected time', () => {
    render(
      <ResultGrid
        urls={[]}
        runs={[run('r1', 'running', '一只猫', Date.now())]}
        expectedSecondsFor={() => 20}
        modelLabelFor={(k) => (k === 'gpt-image-2.5-flare' ? 'Flare' : k)}
      />,
    )
    const card = screen.getByTestId('run-card-r1')
    expect(within(card).getByText('RUN')).toBeTruthy()
    expect(within(card).getByText('生成中')).toBeTruthy()
    expect(within(card).getByTestId('status-card-elapsed').textContent).toMatch(/^\d+s \/ ~20s$/)
    expect(within(card).getByText('Flare · 16:9 · 2K · 进行中')).toBeTruthy()
    // No × / 重试 on a running card — nothing to dismiss yet.
    expect(within(card).queryByRole('button', { name: '移除' })).toBeNull()
    expect(within(card).queryByRole('button', { name: '重试' })).toBeNull()
  })

  it('ERR card exposes the reason, 重试 → onRetryRun, × → onDismissRun, ↺ EDIT → the run snapshot', () => {
    const onRetryRun = vi.fn()
    const onDismissRun = vi.fn()
    const onEditFromResult = vi.fn()
    render(
      <ResultGrid
        urls={[]}
        runs={[run('r1', 'error', '一只猫', 1000, 'HTTP 400 · invalid_mask_image_format')]}
        onRetryRun={onRetryRun}
        onDismissRun={onDismissRun}
        onEditFromResult={onEditFromResult}
      />,
    )
    const card = screen.getByTestId('run-card-r1')
    expect(within(card).getByText('ERR')).toBeTruthy()
    expect(within(card).getByText('HTTP 400 · invalid_mask_image_format')).toBeTruthy()
    fireEvent.click(within(card).getByRole('button', { name: '重试' }))
    expect(onRetryRun).toHaveBeenCalledWith('r1')
    fireEvent.click(within(card).getByRole('button', { name: '移除' }))
    expect(onDismissRun).toHaveBeenCalledWith('r1')
    fireEvent.click(within(card).getByRole('button', { name: /重编辑/ }))
    expect(onEditFromResult).toHaveBeenCalledWith(snapshot('一只猫'))
  })

  it('done card: meta line, ↺ EDIT with the result snapshot, × → onRemoveResult, click → onPreview(index)', () => {
    const onRemoveResult = vi.fn()
    const onPreview = vi.fn()
    const onEditFromResult = vi.fn()
    render(
      <ResultGrid
        urls={[`${COS}a.png`]}
        meta={[meta('a', 1000, '春')]}
        onRemoveResult={onRemoveResult}
        onPreview={onPreview}
        onEditFromResult={onEditFromResult}
        modelLabelFor={() => 'Flare'}
      />,
    )
    const card = screen.getByTestId('result-card-a')
    expect(within(card).getByText('OK')).toBeTruthy()
    expect(within(card).getByText('Flare · 1:1 · 2K · 24.9s')).toBeTruthy()
    fireEvent.click(within(card).getByRole('button', { name: '移除' }))
    expect(onRemoveResult).toHaveBeenCalledWith('a')
    fireEvent.click(within(card).getByRole('button', { name: /重编辑/ }))
    expect(onEditFromResult).toHaveBeenCalledWith(snapshot('春'))
    fireEvent.click(card.querySelector('.cursor-zoom-in')!)
    expect(onPreview).toHaveBeenCalledWith(0)
  })

  it('shows the hatch empty slot only when there are neither results nor runs', () => {
    const { rerender } = render(<ResultGrid urls={[]} runs={[]} />)
    expect(screen.getByTestId('result-grid-empty')).toBeTruthy()
    expect(screen.getByText('OUTPUT_SLOT · EMPTY')).toBeTruthy()

    rerender(<ResultGrid urls={[]} runs={[run('r1', 'running', 'x', Date.now())]} />)
    expect(screen.queryByTestId('result-grid-empty')).toBeNull()
    expect(screen.getByTestId('run-card-r1')).toBeTruthy()
  })
})
