// 「效果问题反馈」面板:只在点击时查询、一个任务只报一次(被拒先重查)、受理后可能暂时查不到、
// 刷新失败保留旧记录、附件只渲染 https。主进程那一侧(请求 / 解析)在 videoBadcase/client.test.ts。
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  VideoBadcaseQueryResult,
  VideoBadcaseRecord,
  VideoBadcaseReportInput,
  VideoBadcaseReportResult,
} from '../../../../../types/videoBadcase'
import {
  BADCASE_ALREADY_SUBMITTED_NOTICE,
  BADCASE_PENDING_NOTICE,
  VideoBadcasePanel,
} from '../VideoBadcasePanel'

const report = vi.fn<(input: VideoBadcaseReportInput) => Promise<VideoBadcaseReportResult>>()
const query = vi.fn<(taskId: string) => Promise<VideoBadcaseQueryResult>>()

const RECORD: VideoBadcaseRecord = {
  badcaseTypes: ['style_drift', 'some_future_type'],
  feedback: '风格飘了\n第二行',
  problemLabel: '风格',
  status: 'processing',
  submitTime: '2026-10-29T08:00:00Z',
  solution: null,
}

const NO_RECORD: VideoBadcaseQueryResult = { ok: true, record: null, rejection: null }
const found = (record: VideoBadcaseRecord = RECORD): VideoBadcaseQueryResult => ({ ok: true, record, rejection: null })
const failed = (message: string): { ok: false; code: 'NETWORK'; message: string } => ({ ok: false, code: 'NETWORK', message })

beforeEach(() => {
  report.mockReset()
  query.mockReset()
  ;(window as unknown as { electronAPI: unknown }).electronAPI = { videoWorkbench: { badcase: { report, query } } }
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

const openPanel = async (): Promise<void> => {
  fireEvent.click(screen.getByRole('button', { name: '提交 / 查看反馈' }))
}

const fillForm = (text: string): void => {
  fireEvent.change(screen.getByLabelText('问题描述'), { target: { value: text } })
}

describe('打开', () => {
  it('挂载时只摆入口,不发任何请求(不轮询、不预查)', () => {
    render(<VideoBadcasePanel taskId="task_1" />)
    expect(screen.getByRole('button', { name: '提交 / 查看反馈' })).toBeTruthy()
    expect(query).not.toHaveBeenCalled()
    expect(report).not.toHaveBeenCalled()
  })

  it('点开:查一次;没记录 → 出表单', async () => {
    query.mockResolvedValue(NO_RECORD)
    render(<VideoBadcasePanel taskId="task_1" />)
    await openPanel()
    expect(await screen.findByLabelText('问题描述')).toBeTruthy()
    expect(query).toHaveBeenCalledTimes(1)
    expect(query).toHaveBeenCalledWith('task_1')
  })

  it('点开:已有记录 → 直接展示,问题类型翻成中文,没见过的类型原样显示', async () => {
    query.mockResolvedValue(found())
    render(<VideoBadcasePanel taskId="task_1" />)
    await openPanel()
    const card = await screen.findByTestId('vw-bc-record')
    expect(screen.getByTestId('vw-bc-status').textContent).toBe('处理中')
    expect(card.textContent).toContain('风格漂移')
    expect(card.textContent).toContain('some_future_type')
    expect(card.textContent).toContain('风格飘了')
    expect(screen.queryByLabelText('问题描述')).toBeNull()
  })

  it('已处理 + 处理方案:附件只渲染 https 链接,带 noopener noreferrer', async () => {
    query.mockResolvedValue(
      found({
        ...RECORD,
        status: 'done',
        solution: {
          text: '已修复,请重新生成',
          attachments: [
            { type: 'video', url: 'https://cos.example/fixed.mp4', mimeType: 'video/mp4', name: 'fixed.mp4' },
            { type: 'link', url: 'javascript:alert(1)', mimeType: '', name: 'evil' },
            { type: 'link', url: 'http://plain.example/x', mimeType: '', name: 'plain' },
          ],
        },
      }),
    )
    render(<VideoBadcasePanel taskId="task_1" />)
    await openPanel()
    const solution = await screen.findByTestId('vw-bc-solution')
    expect(screen.getByTestId('vw-bc-status').textContent).toBe('已处理')
    expect(solution.textContent).toContain('已修复,请重新生成')
    const links = solution.querySelectorAll('a')
    expect(links).toHaveLength(1)
    expect(links[0].getAttribute('href')).toBe('https://cos.example/fixed.mp4')
    expect(links[0].getAttribute('rel')).toBe('noopener noreferrer')
    expect(links[0].getAttribute('target')).toBe('_blank')
  })

  it('查询失败:留在入口 + 报错,可以再点', async () => {
    query.mockResolvedValueOnce(failed('连不上网关,请检查网络后重试。')).mockResolvedValueOnce(NO_RECORD)
    render(<VideoBadcasePanel taskId="task_1" />)
    await openPanel()
    expect((await screen.findByRole('alert')).textContent).toContain('连不上网关')
    await openPanel()
    expect(await screen.findByLabelText('问题描述')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('任务不存在(40002):直接给原因,不摆一个注定被拒的表单', async () => {
    query.mockResolvedValue({ ok: true, record: null, rejection: { code: 40002, message: '请切换到提交这张卡时的计费池' } })
    render(<VideoBadcasePanel taskId="task_1" />)
    await openPanel()
    expect((await screen.findByRole('alert')).textContent).toContain('计费池')
    expect(screen.queryByLabelText('问题描述')).toBeNull()
  })

  it('没有 preload 桥(老壳子):给「请升级」而不是抛', async () => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI
    render(<VideoBadcasePanel taskId="task_1" />)
    await openPanel()
    expect((await screen.findByRole('alert')).textContent).toContain('升级')
  })

  it('IPC 抛了(主进程 handler 异常):给通用提示,不白屏', async () => {
    query.mockRejectedValue(new Error('boom'))
    render(<VideoBadcasePanel taskId="task_1" />)
    await openPanel()
    expect((await screen.findByRole('alert')).textContent).toContain('请稍后重试')
  })
})

describe('提交', () => {
  const openForm = async (): Promise<void> => {
    query.mockResolvedValueOnce(NO_RECORD)
    await openPanel()
    await screen.findByLabelText('问题描述')
  }
  const submitBtn = (): HTMLButtonElement => screen.getByRole('button', { name: '提交反馈' }) as HTMLButtonElement

  it('描述为空 / 全是空白:提交按钮禁用', async () => {
    render(<VideoBadcasePanel taskId="task_1" />)
    await openForm()
    expect(submitBtn().disabled).toBe(true)
    fillForm('   ')
    expect(submitBtn().disabled).toBe(true)
    fillForm('角色变脸')
    expect(submitBtn().disabled).toBe(false)
  })

  it('超过 5000 字:禁用并标红计数;按字符数而不是 UTF-16 长度', async () => {
    render(<VideoBadcasePanel taskId="task_1" />)
    await openForm()
    fillForm('😀'.repeat(5000))
    expect(submitBtn().disabled).toBe(false)
    fillForm('😀'.repeat(5001))
    expect(submitBtn().disabled).toBe(true)
  })

  it('类型可多选可取消(role=checkbox);提交带上去空白的描述 / 类型 / 联系方式', async () => {
    report.mockResolvedValue({ ok: true, outcome: 'accepted', caseId: 'case-1' })
    render(<VideoBadcasePanel taskId="task_1" />)
    await openForm()
    query.mockResolvedValueOnce(found())

    const chip = (name: string): HTMLElement => screen.getByRole('checkbox', { name })
    fireEvent.click(chip('风格漂移'))
    fireEvent.click(chip('其他'))
    fireEvent.click(chip('其他')) // 取消
    expect(chip('风格漂移').getAttribute('aria-checked')).toBe('true')
    expect(chip('其他').getAttribute('aria-checked')).toBe('false')

    fillForm('  风格飘了  ')
    fireEvent.change(screen.getByLabelText('联系方式'), { target: { value: ' a@b.c ' } })
    fireEvent.click(submitBtn())

    await waitFor(() => expect(report).toHaveBeenCalledTimes(1))
    expect(report).toHaveBeenCalledWith({
      taskId: 'task_1',
      feedback: '风格飘了',
      badcaseTypes: ['style_drift'],
      contactInfo: 'a@b.c',
    })
  })

  it('不填联系方式:contactInfo 字段不出现', async () => {
    report.mockResolvedValue({ ok: true, outcome: 'accepted', caseId: null })
    render(<VideoBadcasePanel taskId="task_1" />)
    await openForm()
    query.mockResolvedValueOnce(found())
    fillForm('x')
    fireEvent.click(submitBtn())
    await waitFor(() => expect(report).toHaveBeenCalled())
    expect(report.mock.calls[0][0]).not.toHaveProperty('contactInfo')
  })

  it('受理后立即查一次:查得到 → 直接展示记录', async () => {
    report.mockResolvedValue({ ok: true, outcome: 'accepted', caseId: 'case-1' })
    render(<VideoBadcasePanel taskId="task_1" />)
    await openForm()
    query.mockResolvedValueOnce(found())
    fillForm('x')
    fireEvent.click(submitBtn())
    expect(await screen.findByTestId('vw-bc-record')).toBeTruthy()
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('受理但还查不到:进「已提交,等待同步」而不是报错;「刷新状态」再查,查到就展示', async () => {
    report.mockResolvedValue({ ok: true, outcome: 'accepted', caseId: 'case-1' })
    render(<VideoBadcasePanel taskId="task_1" />)
    await openForm()
    query.mockResolvedValueOnce(NO_RECORD) // 受理后的即时查询:还没同步
    fillForm('x')
    fireEvent.click(submitBtn())

    expect(await screen.findByText(BADCASE_PENDING_NOTICE)).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByLabelText('问题描述')).toBeNull() // 不能再出表单:上游一个任务只收一次

    query.mockResolvedValueOnce(found())
    fireEvent.click(screen.getByRole('button', { name: '刷新状态' }))
    expect(await screen.findByTestId('vw-bc-record')).toBeTruthy()
  })

  it('被拒后重查一次:查到记录 → 展示并说明「已提交过」', async () => {
    report.mockResolvedValue({ ok: true, outcome: 'rejected', rejection: { code: 40010, message: 'already submitted' } })
    render(<VideoBadcasePanel taskId="task_1" />)
    await openForm()
    query.mockResolvedValueOnce(found())
    fillForm('x')
    fireEvent.click(submitBtn())
    expect(await screen.findByTestId('vw-bc-record')).toBeTruthy()
    expect(screen.getByText(BADCASE_ALREADY_SUBMITTED_NOTICE)).toBeTruthy()
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('被拒且确实没记录:展示拒绝原因,表单与已填内容保留', async () => {
    report.mockResolvedValue({ ok: true, outcome: 'rejected', rejection: { code: 40011, message: '任务状态不允许反馈' } })
    render(<VideoBadcasePanel taskId="task_1" />)
    await openForm()
    query.mockResolvedValueOnce(NO_RECORD)
    fillForm('我写了很长的描述')
    fireEvent.click(submitBtn())
    expect((await screen.findByRole('alert')).textContent).toContain('任务状态不允许反馈')
    expect((screen.getByLabelText('问题描述') as HTMLTextAreaElement).value).toBe('我写了很长的描述')
  })

  it('被拒后的重查本身失败:仍展示拒绝原因,不吞掉', async () => {
    report.mockResolvedValue({ ok: true, outcome: 'rejected', rejection: { code: 40011, message: '任务状态不允许反馈' } })
    render(<VideoBadcasePanel taskId="task_1" />)
    await openForm()
    query.mockResolvedValueOnce(failed('网络不通'))
    fillForm('x')
    fireEvent.click(submitBtn())
    expect((await screen.findByRole('alert')).textContent).toContain('任务状态不允许反馈')
  })

  it('整个请求失败:报错、表单保留、可再点提交', async () => {
    report.mockResolvedValueOnce({ ok: false, code: 'CHANNEL_UNAVAILABLE', message: '网关暂未对当前账号开通「效果问题反馈」，请联系管理员。' })
    render(<VideoBadcasePanel taskId="task_1" />)
    await openForm()
    fillForm('x')
    fireEvent.click(submitBtn())
    expect((await screen.findByRole('alert')).textContent).toContain('暂未对当前账号开通')
    expect((screen.getByLabelText('问题描述') as HTMLTextAreaElement).value).toBe('x')
    expect(submitBtn().disabled).toBe(false)
    expect(query).toHaveBeenCalledTimes(1) // 失败不会触发「重查」
  })

  it('提交中按钮禁用:连点只发一次', async () => {
    let resolveReport!: (r: VideoBadcaseReportResult) => void
    report.mockImplementation(() => new Promise<VideoBadcaseReportResult>((r) => (resolveReport = r)))
    render(<VideoBadcasePanel taskId="task_1" />)
    await openForm()
    query.mockResolvedValueOnce(found())
    fillForm('x')
    fireEvent.click(submitBtn())
    fireEvent.click(screen.getByRole('button', { name: '提交中…' }))
    fireEvent.click(screen.getByRole('button', { name: '提交中…' }))
    expect(report).toHaveBeenCalledTimes(1)
    resolveReport({ ok: true, outcome: 'accepted', caseId: 'c' })
    expect(await screen.findByTestId('vw-bc-record')).toBeTruthy()
  })

  it('取消回到入口,已填内容还在', async () => {
    render(<VideoBadcasePanel taskId="task_1" />)
    await openForm()
    fillForm('先写着')
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    query.mockResolvedValueOnce(NO_RECORD)
    await openPanel()
    expect(((await screen.findByLabelText('问题描述')) as HTMLTextAreaElement).value).toBe('先写着')
  })
})

describe('刷新状态', () => {
  it('查到新进度就换上', async () => {
    query.mockResolvedValueOnce(found())
    render(<VideoBadcasePanel taskId="task_1" />)
    await openPanel()
    await screen.findByTestId('vw-bc-record')

    query.mockResolvedValueOnce(found({ ...RECORD, status: 'done', solution: { text: '搞定', attachments: [] } }))
    fireEvent.click(screen.getByRole('button', { name: '刷新状态' }))
    await waitFor(() => expect(screen.getByTestId('vw-bc-status').textContent).toBe('已处理'))
    expect(screen.getByTestId('vw-bc-solution').textContent).toContain('搞定')
  })

  it('刷新失败:保留旧记录,在上面提示「刷新失败」', async () => {
    query.mockResolvedValueOnce(found())
    render(<VideoBadcasePanel taskId="task_1" />)
    await openPanel()
    await screen.findByTestId('vw-bc-record')

    query.mockResolvedValueOnce(failed('请求超时,请稍后再试。'))
    fireEvent.click(screen.getByRole('button', { name: '刷新状态' }))
    expect((await screen.findByRole('alert')).textContent).toContain('刷新失败')
    expect(screen.getByTestId('vw-bc-record').textContent).toContain('风格飘了')
  })

  it('刷新返回「没记录」:不清掉旧记录,只提示', async () => {
    query.mockResolvedValueOnce(found())
    render(<VideoBadcasePanel taskId="task_1" />)
    await openPanel()
    await screen.findByTestId('vw-bc-record')

    query.mockResolvedValueOnce(NO_RECORD)
    fireEvent.click(screen.getByRole('button', { name: '刷新状态' }))
    expect(await screen.findByText('暂未查到处理进度,请稍后再试。')).toBeTruthy()
    expect(screen.getByTestId('vw-bc-record')).toBeTruthy()
  })
})

describe('卸载', () => {
  it('回包在卸载之后到:不报 React 警告、不抛', async () => {
    let resolveQuery!: (r: VideoBadcaseQueryResult) => void
    query.mockImplementation(() => new Promise<VideoBadcaseQueryResult>((r) => (resolveQuery = r)))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { unmount } = render(<VideoBadcasePanel taskId="task_1" />)
    await openPanel()
    unmount()
    resolveQuery(found())
    await Promise.resolve()
    expect(errSpy).not.toHaveBeenCalled()
    errSpy.mockRestore()
  })
})
