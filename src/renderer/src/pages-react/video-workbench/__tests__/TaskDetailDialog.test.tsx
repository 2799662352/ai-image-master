// 「任务详情」面板:标识 / 时间 / 结果 / 请求参数 / 历史版本,每个 ID 与地址可一键
// 复制,整份可复制成 JSON;本地成片可在文件夹中显示;Esc / 遮罩 / 关闭都能关。
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VideoWorkbenchCard, VideoWorkbenchVersion } from '../../../../../types/videoWorkbench'
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

  it('按卡片当前展示的版本取数;「历史版本」里可切到别的版本,当前那版标「当前显示」', () => {
    const spec = {
      prompt: 'p',
      model: '2.5' as const,
      resolution: '480p' as const,
      ratio: '16:9' as const,
      duration: 6,
      generateAudio: true,
      mode: 'multimodal_ref' as const,
      webSearch: false,
      referenceBrief: { images: [], videos: [], audios: [] },
    }
    const versions: VideoWorkbenchVersion[] = [
      { id: 'v1', seq: 1, createdAt: Date.now() - 120_000, taskId: 't1', upstreamTaskId: 'cgt-1', localPath: 'D:\\v1.mp4', spec: { ...spec, prompt: '第一版' } },
      { id: 'v2', seq: 2, createdAt: Date.now() - 60_000, taskId: 'task_aSOAy1wEN8qCafX5dvfoVoWal9PENatI', upstreamTaskId: UPSTREAM, localPath: 'D:\\out\\v.mp4', spec },
    ]
    const onSelectVersion = vi.fn()
    render(
      <TaskDetailDialog card={card({ versions })} index={0} versionIdx={0} onSelectVersion={onSelectVersion} onClose={() => {}} />,
    )
    screen.getByRole('dialog', { name: '#01 · 任务详情 · v1/2' })
    const hero = screen.getByTestId('vw-detail-upstreamTaskId')
    expect(hero.textContent).toContain('cgt-1')
    expect(hero.textContent).not.toContain(UPSTREAM)
    expect(screen.getByTestId('vw-detail-request').textContent).toContain('"prompt": "第一版"')

    const v1Row = screen.getByTestId('vw-detail-version-1')
    expect(v1Row.textContent).toContain('当前显示')
    expect(v1Row.querySelector('button')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '查看 v2' }))
    expect(onSelectVersion).toHaveBeenCalledWith(1)
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

describe('TaskDetailDialog · 效果问题反馈入口', () => {
  const GATEWAY_TASK = 'task_aSOAy1wEN8qCafX5dvfoVoWal9PENatI'
  const spec = {
    prompt: 'p',
    model: '2.5' as const,
    resolution: '480p' as const,
    ratio: '16:9' as const,
    duration: 6,
    generateAudio: true,
    mode: 'multimodal_ref' as const,
    webSearch: false,
    referenceBrief: { images: [], videos: [], audios: [] },
  }
  const section = (): HTMLElement | null => screen.queryByTestId('vw-detail-badcase')

  beforeEach(() => {
    ;(window as unknown as { electronAPI: unknown }).electronAPI = {
      shell: { showItemInFolder },
      videoWorkbench: { badcase: { report: vi.fn(), query: vi.fn(async () => ({ ok: true, record: null, rejection: null })) } },
    }
  })

  it('已完成 + Seedance 2.x + 走网关:有「效果问题反馈」一区', () => {
    render(<TaskDetailDialog card={card()} index={0} onClose={() => {}} />)
    expect(section()).not.toBeNull()
    expect(section()!.textContent).toContain('效果问题反馈')
    expect(screen.getByRole('button', { name: '提交 / 查看反馈' })).toBeTruthy()
  })

  it('打开面板本身不会发请求', () => {
    const query = vi.fn()
    ;(window as unknown as { electronAPI: unknown }).electronAPI = { videoWorkbench: { badcase: { report: vi.fn(), query } } }
    render(<TaskDetailDialog card={card()} index={0} onClose={() => {}} />)
    expect(query).not.toHaveBeenCalled()
  })

  it('没资格就整区不出现:未完成 / 失败 / 万相 / 可灵 / 自填 Key / 没提交', () => {
    const ineligible: Array<Partial<VideoWorkbenchCard>> = [
      { status: 'running' },
      { status: 'failed' },
      { status: 'cancelled' },
      { model: 'wan3' },
      { model: 'kling4' },
      { billing: 'own-key' },
      { taskId: undefined },
      { taskId: 'cgt-20260903172200-5n7rt' },
    ]
    for (const patch of ineligible) {
      const { unmount } = render(<TaskDetailDialog card={card(patch)} index={0} onClose={() => {}} />)
      expect(section(), JSON.stringify(patch)).toBeNull()
      unmount()
    }
  })

  it('历史版本:按那一版自己的任务号 / 模型判断,不拿卡片当前的去报', async () => {
    const query = vi.fn(async () => ({ ok: true as const, record: null, rejection: null }))
    ;(window as unknown as { electronAPI: unknown }).electronAPI = { videoWorkbench: { badcase: { report: vi.fn(), query } } }
    const versions: VideoWorkbenchVersion[] = [
      { id: 'v1', seq: 1, createdAt: Date.now() - 120_000, taskId: 'task_v1_old', upstreamTaskId: 'cgt-1', spec },
      { id: 'v2', seq: 2, createdAt: Date.now() - 60_000, taskId: GATEWAY_TASK, upstreamTaskId: UPSTREAM, spec },
    ]
    render(<TaskDetailDialog card={card({ versions })} index={0} versionIdx={0} onClose={() => {}} />)
    expect(section()).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '提交 / 查看反馈' }))
    await waitFor(() => expect(query).toHaveBeenCalledWith('task_v1_old'))
    expect(query).not.toHaveBeenCalledWith(GATEWAY_TASK)
  })

  it('历史版本没记任务号 / 记的不是网关号 / 那一版不是 Seedance 2.x:不出现', () => {
    const mk = (v1: Partial<VideoWorkbenchVersion>): VideoWorkbenchVersion[] => [
      { id: 'v1', seq: 1, createdAt: Date.now() - 120_000, upstreamTaskId: 'cgt-1', spec, taskId: 'task_v1', ...v1 },
      { id: 'v2', seq: 2, createdAt: Date.now() - 60_000, taskId: GATEWAY_TASK, upstreamTaskId: UPSTREAM, spec },
    ]
    for (const v1 of [
      { taskId: undefined },
      { taskId: 'cgt-direct-1' },
      { spec: { ...spec, model: 'wan3' as const } },
    ] as Array<Partial<VideoWorkbenchVersion>>) {
      const { unmount } = render(<TaskDetailDialog card={card({ versions: mk(v1) })} index={0} versionIdx={0} onClose={() => {}} />)
      expect(section(), JSON.stringify(v1)).toBeNull()
      unmount()
    }
  })

  it('重新生成中的卡(最新一版进行中):即使旧版本有资格,看最新版也不出现', () => {
    const versions: VideoWorkbenchVersion[] = [
      { id: 'v1', seq: 1, createdAt: Date.now() - 120_000, taskId: 'task_v1', upstreamTaskId: 'cgt-1', spec },
      { id: 'v2', seq: 2, createdAt: Date.now() - 60_000, taskId: GATEWAY_TASK, upstreamTaskId: UPSTREAM, spec },
    ]
    render(<TaskDetailDialog card={card({ versions, status: 'running' })} index={0} onClose={() => {}} />)
    expect(section()).toBeNull()
  })
})
