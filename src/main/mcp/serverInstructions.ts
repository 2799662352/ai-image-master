/**
 * MCP server `instructions`(InitializeResult 字段,客户端可并入系统提示)。
 *
 * 这里只装**工具描述装不下的东西**:跨工具的选择关系、并发安全边界、全局约束。
 * MCP 官方把「重复 tool description」列为头号反模式(2026-07-28 规范原文:
 * "should avoid duplicating details already present in tool descriptions"),
 * 所以某个工具自己的参数上限、素材规则一律留在它自己的 description 里。
 *
 * 为什么值得写:官方 40 会话对照实验里,GPT-5-Mini 走对多步工作流的比例
 * 20% → 80%,而 Claude Sonnet-4 本来就 90–100%。我们跑的正是差的那一档
 * (codex 走 GPT,自建网关还挂 Qwen/Grok),所以收益远大于「我们自己试着还行」。
 *
 * 前 512 字符必须自包含 —— codex 在决定怎么用这个 server 时可能只看得到开头
 * (developers.openai.com/codex/mcp)。所以选择表排在最前面,寒暄一律没有。
 */
export const CATIMATION_SERVER_INSTRUCTIONS = [
  'Workbench card edits — pick the tool by SIZE OF CHANGE: a few words of a prompt → '
  + 'video_workbench_patch_prompt; one card, several fields → video_workbench_update_task; '
  + 'the same spec across many cards → video_workbench_set_spec; reordering a whole page → '
  + 'video_workbench_reorder (one call); moving a single card → video_workbench_move_task; '
  + 'adding or removing cards → video_workbench_add_tasks / '
  + 'video_workbench_remove_tasks. video_workbench_apply is STRUCTURE ONLY: it rejects prompt '
  + 'edits to existing cards with zero writes, and exists for atomic whole-board rebuilds.',

  'Per-card writes touch different cards and are safe in parallel. Reordering is order-dependent '
  + 'and is the exception: never issue video_workbench_move_task calls in parallel.',

  'Every tool result is silently truncated at ~10k tokens, so read the workbench in layers: projects, '
  + 'page summaries, video_workbench_status fields:"concise", then detailed cards or full prompts only '
  + 'for cards you name. Engineered prompts all open alike, so a truncated head barely distinguishes '
  + 'cards — the one-line notes (video_workbench_set_project_summary / _set_board_summary / '
  + '_set_card_summary) are what keep the upper layers worth reading.',
].join('\n\n')
