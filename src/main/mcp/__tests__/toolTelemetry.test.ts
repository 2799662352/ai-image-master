import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TOOL_ERROR_REASON_MAX,
  buildToolCallRecord,
  recordToolCall,
  setToolTelemetrySink,
} from '../toolTelemetry'

/**
 * 埋点存在的理由:这一轮把「改几个词」从「重发整板」压成单卡调用,理由是省 decode。
 * 在有数字之前那只是推理。Anthropic 建议测的四项里,耗时/次数/错误率都能在我们这侧
 * 测到 —— 我们就是那个 MCP server。
 *
 * 字段名照抄 OTel GenAI 语义约定的 execute_tool span,将来接真后端时改的是传输、
 * 不是字段。
 */

afterEach(() => {
  setToolTelemetrySink(null)
})

describe('buildToolCallRecord', () => {
  it('成功调用:语义约定的字段齐全，且不带 error.*', () => {
    const r = buildToolCallRecord({
      name: 'video_workbench_patch_prompt',
      durationMs: 12.4,
      threadId: 'thr_1',
      now: new Date('2026-08-10T00:00:00.000Z'),
    })

    expect(r).toEqual({
      'event.timestamp': '2026-08-10T00:00:00.000Z',
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'video_workbench_patch_prompt',
      'gen_ai.tool.type': 'function',
      duration_ms: 12,
      'thread.id': 'thr_1',
    })
  })

  it('失败调用:带上低基数的 error.type 与剥掉工具名前缀的原因', () => {
    const r = buildToolCallRecord({
      name: 'video_workbench_reorder',
      durationMs: 3,
      error: new Error('video_workbench_reorder: cardIds 必须是该页卡片的完整集合'),
    })

    expect(r['error.type']).toBe('Error')
    // 工具名已经单独成字段了，留在原因里只会浪费那 80 字符的额度。
    expect(r['error.reason']).toBe('cardIds 必须是该页卡片的完整集合')
  })

  /**
   * 这条是隐私边界,不是格式偏好。
   *
   * patch_prompt 命中不唯一时会把**提示词全文**放进错误里 —— 那是它能让模型自纠
   * 的关键。但错误信息一旦原样落盘,用户写的内容就进了日志文件。截断保证只留下
   * 「命中 N 处」这类固定措辞。
   */
  it('提示词全文不会跟着错误进日志', () => {
    const secret = '雨夜霓虹下的赛博朋克街头长镜头，主角穿红色风衣'
    const r = buildToolCallRecord({
      name: 'video_workbench_patch_prompt',
      durationMs: 1,
      error: new Error(
        'video_workbench_patch_prompt: oldText 在该卡提示词中命中 2 处，需要恰好 1 处。'
        + `把 oldText 写长一点以唯一定位；整段重写请用 video_workbench_update_task。当前提示词全文:\n${secret}`,
      ),
    })

    expect(r['error.reason']!.length).toBeLessThanOrEqual(TOOL_ERROR_REASON_MAX)
    expect(r['error.reason']).not.toContain(secret)
    expect(r['error.reason']).not.toContain('赛博朋克')
    // 但仍然分得清是哪一类失败。
    expect(r['error.reason']).toContain('命中 2 处')
  })

  it('非 Error 抛出物也记得下来', () => {
    const r = buildToolCallRecord({ name: 'x', durationMs: 0, error: 'boom' })
    expect(r['error.type']).toBe('string')
    expect(r['error.reason']).toBe('boom')
  })

  it('耗时取整且不为负（系统时钟回拨过也别写出负数）', () => {
    expect(buildToolCallRecord({ name: 'x', durationMs: -5 }).duration_ms).toBe(0)
  })
})

describe('recordToolCall', () => {
  it('没装 sink 时是空操作', () => {
    expect(() => recordToolCall({ name: 'x', durationMs: 1 })).not.toThrow()
  })

  it('装了就把记录交给 sink', () => {
    const sink = vi.fn()
    setToolTelemetrySink(sink)
    recordToolCall({ name: 'video_workbench_move_task', durationMs: 7 })

    expect(sink).toHaveBeenCalledTimes(1)
    expect(sink.mock.calls[0][0]['gen_ai.tool.name']).toBe('video_workbench_move_task')
  })

  // 磁盘满、流已关闭 —— 都不该让模型拿不到工具结果。
  it('sink 抛错不会外泄', () => {
    setToolTelemetrySink(() => {
      throw new Error('disk full')
    })
    expect(() => recordToolCall({ name: 'x', durationMs: 1 })).not.toThrow()
  })
})
