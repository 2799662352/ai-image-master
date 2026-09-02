import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexUserInputPrompt, parseUserInputQuestions } from '../CodexUserInputPrompt'
import { CODEX_REQUEST_USER_INPUT_METHOD } from '../../../../../types/agent'

afterEach(cleanup)

// 线上形状照 app-server-protocol v2 `ToolRequestUserInputParams`（camelCase）。
function requestWith(questions: unknown[]) {
  return {
    id: '7',
    threadId: 'thread-1',
    method: CODEX_REQUEST_USER_INPUT_METHOD,
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-1',
      isBlocking: true,
      questions,
    },
    createdAt: '2026-09-02T00:00:00.000Z',
  }
}

const styleQuestion = {
  id: 'style',
  header: '风格',
  question: '这批狗狗图要什么风格？',
  isOther: false,
  isSecret: false,
  options: [
    { label: '写实电影感', description: '像剧照' },
    { label: '扁平插画', description: '矢量风' },
  ],
}

describe('CodexUserInputPrompt', () => {
  it('单题有选项且不许自定义:点选项即提交,答案是选项 label', () => {
    const onRespond = vi.fn()
    render(<CodexUserInputPrompt request={requestWith([styleQuestion])} onRespond={onRespond} />)

    expect(screen.getByText('这批狗狗图要什么风格？')).toBeTruthy()
    expect(screen.getByText('风格')).toBeTruthy()
    // 即时模式不显示「提交」按钮 —— 少一次点击。
    expect(screen.queryByRole('button', { name: '提交' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /写实电影感/ }))

    expect(onRespond).toHaveBeenCalledWith({
      id: '7',
      approved: true,
      answers: { style: { answers: ['写实电影感'] } },
    })
  })

  it('isOther 允许自定义:输入文本后提交,文本是答案', () => {
    const onRespond = vi.fn()
    render(
      <CodexUserInputPrompt
        request={requestWith([{ ...styleQuestion, isOther: true }])}
        onRespond={onRespond}
      />,
    )

    const submit = screen.getByRole('button', { name: '提交' })
    expect((submit as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(screen.getByLabelText('或自定义'), { target: { value: '赛博朋克霓虹' } })
    expect((submit as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(submit)

    expect(onRespond).toHaveBeenCalledWith({
      id: '7',
      approved: true,
      answers: { style: { answers: ['赛博朋克霓虹'] } },
    })
  })

  it('isOther 下点了选项再打字:以文字为准,不把两半都算进答案', () => {
    const onRespond = vi.fn()
    render(
      <CodexUserInputPrompt
        request={requestWith([{ ...styleQuestion, isOther: true }])}
        onRespond={onRespond}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /扁平插画/ }))
    fireEvent.change(screen.getByLabelText('或自定义'), { target: { value: '水彩' } })
    fireEvent.click(screen.getByRole('button', { name: '提交' }))

    expect(onRespond).toHaveBeenCalledWith(
      expect.objectContaining({ answers: { style: { answers: ['水彩'] } } }),
    )
  })

  it('多题:全部作答前「提交」不可点;提交时每题一条', () => {
    const onRespond = vi.fn()
    const countQuestion = {
      id: 'count',
      header: '数量',
      question: '出几张？',
      isOther: false,
      isSecret: false,
      options: [{ label: '1 张', description: '' }, { label: '3 张', description: '' }],
    }
    render(
      <CodexUserInputPrompt request={requestWith([styleQuestion, countQuestion])} onRespond={onRespond} />,
    )
    const submit = screen.getByRole('button', { name: '提交' }) as HTMLButtonElement

    fireEvent.click(screen.getByRole('button', { name: /写实电影感/ }))
    expect(submit.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /3 张/ }))
    expect(submit.disabled).toBe(false)
    fireEvent.click(submit)

    expect(onRespond).toHaveBeenCalledWith({
      id: '7',
      approved: true,
      answers: { style: { answers: ['写实电影感'] }, count: { answers: ['3 张'] } },
    })
  })

  it('没有选项的题只给输入框;isSecret 用 password 框', () => {
    render(
      <CodexUserInputPrompt
        request={requestWith([
          { id: 'key', header: '', question: '粘贴你的 API Key', isOther: true, isSecret: true, options: null },
        ])}
        onRespond={vi.fn()}
      />,
    )
    const input = screen.getByLabelText('粘贴你的 API Key') as HTMLInputElement
    expect(input.type).toBe('password')
    expect(screen.queryByRole('group')).toBeNull()
  })

  it('「跳过 / 你来定」= 空答案表,approved:false', () => {
    const onRespond = vi.fn()
    render(<CodexUserInputPrompt request={requestWith([styleQuestion])} onRespond={onRespond} />)

    fireEvent.click(screen.getByRole('button', { name: /跳过/ }))

    expect(onRespond).toHaveBeenCalledWith({ id: '7', approved: false, answers: {} })
  })

  it('params 里没有 questions 时不崩,仍能跳过', () => {
    const onRespond = vi.fn()
    render(<CodexUserInputPrompt request={requestWith([])} onRespond={onRespond} />)
    expect(screen.getByText(/没有附带问题内容/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /跳过/ }))
    expect(onRespond).toHaveBeenCalledWith({ id: '7', approved: false, answers: {} })
  })
})

describe('parseUserInputQuestions', () => {
  it('缺 id 或 question 的条目整条丢弃;缺 header/isOther/isSecret 补默认', () => {
    const parsed = parseUserInputQuestions({
      questions: [
        { id: 'a', question: 'A?' },
        { id: '', question: 'no id' },
        { id: 'b' },
        'garbage',
        null,
      ],
    })
    expect(parsed).toEqual([
      { id: 'a', header: '', question: 'A?', isOther: false, isSecret: false, options: null },
    ])
  })

  it('options 里没有 label 的丢弃;options 缺失时为 null 而不是 []', () => {
    const parsed = parseUserInputQuestions({
      questions: [
        {
          id: 'a',
          question: 'A?',
          options: [{ label: 'x', description: 'd' }, { description: 'no label' }, 42],
        },
        { id: 'b', question: 'B?' },
      ],
    })
    expect(parsed[0].options).toEqual([{ label: 'x', description: 'd' }])
    expect(parsed[1].options).toBeNull()
  })

  it('questions 不是数组时返回空', () => {
    expect(parseUserInputQuestions({})).toEqual([])
    expect(parseUserInputQuestions({ questions: 'nope' })).toEqual([])
  })
})
