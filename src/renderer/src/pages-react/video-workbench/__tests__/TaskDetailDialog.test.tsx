// 「任务详情」面板:标识 / 时间 / 结果 / 请求参数 / 历史版本,每个 ID 与地址可一键
// 复制,整份可复制成 JSON;本地成片可在文件夹中显示;Esc / 遮罩 / 关闭都能关。
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VideoWorkbenchCard } from '../../../../../types/videoWorkbench'
import { buildCard } from '../../../features/video-workbench/cardSpec'
import { TaskDetailDialog } from '../TaskDetailDialog'

const UPSTREAM = 'cgt-20260903172200-5n7rt'
const writeText = vi.fn(async (_text: string) => {})
const showItemInFolder = vi.fn()

function card(patch: Partial<VideoWorkbenchCard> = {}): VideoWorkbenchCard {
  return {
    ...buildCard({ prompt: '一只赛博猫在雨夜奔跑', model: '2.5', resolution: '480p', duration: 6 }, 3),
    id: 'card0000aa',
    status: 'succeeded',
    taskId: 'task_aSOAy1wEN8qCafX5dvfoVoWal9PENatI',
    upstreamTaskId: UPSTREAM,
    clientId: 'wb-abc',
    billing: 'platform',
    startedAt: Date.now() - 65_000,
    localPath: 'D:\\out\\v.mp4',
    remoteUrl: 'https://cos.example/v.mp4',
    persistence: 'done',
    completionTokens: 81234,
    ...patch,
  }
}

beforeEach(() => {
  writeText.mockClear()
  showItemInFolder.mockClear()
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = { shell: { showItemInFolder } }
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

describe('TaskDetailDialog', () => {
  it('把上游任务号摆在最显眼处,复制它写进剪贴板', () => {
    render(<TaskDetailDialog card={card()} index={3} onClose={() => {}} />)
    const dialog = screen.getByRole('dialog', { name: '#04 · 任务详情' })
    expect(dialog.textContent).toContain(UPSTREAM)
    expect(dialog.textContent).toContain('task_aSOAy1wEN8qCafX5dvfoVoWal9PENatI')
    expect(dialog.textContent).toContain('火山引擎')

    const hero = screen.getByTestId('vw-detail-upstreamTaskId')
    expect(hero.className).toContain('vw-detail-hero')
    fireEvent.click(hero.querySelector('button[aria-label="复制 上游任务 ID"]')!)
    expect(writeText).toHaveBeenCalledWith(UPSTREAM)
    expect(hero.textContent).toContain('已复制')
  })

  it('请求参数以 JSON 块展示并可复制;「复制全部」给整份 JSON(含 upstreamTaskId)', () => {
    render(<TaskDetailDialog card={card({ seed: 42 })} index={0} onClose={() => {}} />)
    const pre = screen.getByTestId('vw-detail-request')
    expect(pre.textContent).toContain('"seed": 42')
    expect(pre.textContent).toContain('"resolution": "480p"')

    fireEvent.click(screen.getByRole('button', { name: '复制参数' }))
    expect(JSON.parse(writeText.mock.calls[0][0])).toMatchObject({ seed: 42, model: '2.5' })

    fireEvent.click(screen.getByRole('button', { name: '复制全部(JSON)' }))
    const all = JSON.parse(writeText.mock.calls[1][0])
    expect(all.ids.upstreamTaskId).toBe(UPSTREAM)
    expect(all.request.seed).toBe(42)
  })

  it('本地成片给「在文件夹中显示」;云端地址可复制', () => {
    render(<TaskDetailDialog card={card()} index={0} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '在文件夹中显示' }))
    expect(showItemInFolder).toHaveBeenCalledWith('D:\\out\\v.mp4')
    fireEvent.click(screen.getByLabelText('复制 成片(云端)'))
    expect(writeText).toHaveBeenCalledWith('https://cos.example/v.mp4')
  })

  it('缺失的值显示占位、不给复制按钮', () => {
    render(
      <TaskDetailDialog
        card={card({ status: 'queued', upstreamTaskId: undefined, localPath: undefined, remoteUrl: undefined, persistence: 'idle', completionTokens: undefined })}
        index={0}
        onClose={() => {}}
      />,
    )
    const hero = screen.getByTestId('vw-detail-upstreamTaskId')
    expect(hero.textContent).toContain('网关尚未回传')
    expect(hero.querySelector('button')).toBeNull()
    expect(screen.queryByRole('button', { name: '在文件夹中显示' })).toBeNull()
  })

  it('Esc / 点遮罩 / 关闭按钮都能关', () => {
    const onClose = vi.fn()
    render(<TaskDetailDialog card={card()} index={0} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
    fireEvent.mouseDown(screen.getByTestId('vw-detail-backdrop'))
    expect(onClose).toHaveBeenCalledTimes(3)
    // 点面板内部不算点遮罩
    fireEvent.mouseDown(screen.getByRole('dialog', { name: '#01 · 任务详情' }))
    expect(onClose).toHaveBeenCalledTimes(3)
  })
})
