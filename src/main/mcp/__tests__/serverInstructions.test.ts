import { describe, expect, it } from 'vitest'
import { CATIMATION_SERVER_INSTRUCTIONS } from '../serverInstructions'

/**
 * MCP 的 server `instructions`(InitializeResult 字段)是「工具描述装不下的东西」
 * 的去处:跨工具的先后关系、全局约束、并发安全边界。
 *
 * 为什么值得单独钉:MCP 官方做过一次 40 会话对照实验(2025-11-03
 * using-server-instructions),GPT-5-Mini 走对多步工作流的比例 20% → 80%,
 * 而 Claude Sonnet-4 本来就有 90–100%。我们跑的正是差的那一档(codex 走 GPT,
 * 自建网关还挂 Qwen/Grok),所以这段文字对我们的收益远大于「Claude 上试着还行」
 * 给人的直觉。
 *
 * Codex 侧的硬要求(developers.openai.com/codex/mcp):
 * 「Keep the first 512 characters self-contained」——codex 在决定怎么用这个
 * server 时可能只看得到开头。
 */
describe('CATIMATION_SERVER_INSTRUCTIONS', () => {
  it('前 512 字符自包含:工作台改动的选择表 + apply 的硬边界都在里面', () => {
    const head = CATIMATION_SERVER_INSTRUCTIONS.slice(0, 512)
    for (const tool of [
      'video_workbench_patch_prompt',
      'video_workbench_update_task',
      'video_workbench_set_spec',
      'video_workbench_move_task',
      'video_workbench_apply',
    ]) {
      expect(head, `${tool} 必须出现在前 512 字符里`).toContain(tool)
    }
    // apply 的硬闸是「零写入拒绝」，不是建议 —— 开头就得说清，否则模型照旧拿它改提示词。
    expect(head).toMatch(/STRUCTURE ONLY|rejects/)
  })

  // 官方反模式:「too long and detailed（500 words）」。instructions 每次会话都注入，
  // 长度就是常驻成本。
  it('保持简短', () => {
    expect(CATIMATION_SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(1200)
  })

  // 并发是跨工具属性:单卡写彼此可交换所以能并行，move 不行。任何单个工具的
  // description 都说不全这件事，正是 instructions 该装的东西。
  it('写明 move 是并发的例外', () => {
    expect(CATIMATION_SERVER_INSTRUCTIONS).toMatch(/parallel/i)
    expect(CATIMATION_SERVER_INSTRUCTIONS).toContain('video_workbench_move_task')
  })

  // 官方反模式:「Don't repeat tool descriptions」。这里挑一句只属于单个工具的
  // 实现细节做哨兵 —— 它出现在 instructions 里就说明开始抄描述了。
  it('不抄单个工具的描述细节', () => {
    expect(CATIMATION_SERVER_INSTRUCTIONS).not.toMatch(/referenceImages ≤9|oldText must appear/)
  })
})
