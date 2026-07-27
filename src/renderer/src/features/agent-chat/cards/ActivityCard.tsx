import { useState } from 'react'
import type { ActivityItem, PlanStep } from '../../../../../types/agent-timeline'
import { useFileExplorerStore } from '../../file-explorer/store'
import { referencesFromTimelineItem } from '../references/referenceUtils'

/**
 * Catch-all card rendered for any Codex `item.type` we don't yet have a
 * dedicated renderer for. Without this, MCP tool calls, web searches, file
 * reads, plan updates, and context compactions used to be invisible — the
 * agent looked frozen between "Thinking…" and the final reply.
 *
 * The card stays small (single-line pill) by default and expands when there
 * is a `detail` payload worth showing. It draws an icon per `kind`, a label,
 * and a status dot that flips from spinner → ✓ → ⚠ as the lifecycle moves
 * from running → success / error.
 */
export function ActivityCard({ item }: { item: ActivityItem }) {
  const status = item.endedAt ? item.status ?? 'success' : item.status ?? 'running'
  const isRunning = status === 'running'
  const hasDetail = typeof item.detail === 'string' && item.detail.length > 0
  const [expanded, setExpanded] = useState(false)
  const openReference = useFileExplorerStore((state) => state.openReference)
  const references = referencesFromTimelineItem(item)

  // Plan tool calls always get a dedicated PlanCard slot — even when we
  // haven't extracted any structured steps yet. The placeholder state is
  // much more legible than the generic "TOOL plan running" chip + raw-args
  // evidence panel that we used to show. Same slot-reservation idea
  // Cursor / Codex CLI use: the card appears the moment the model says
  // "I'm planning", then fills in as steps arrive.
  if (item.kind === 'plan') {
    return <PlanCard item={item} steps={item.steps ?? []} status={status} />
  }

  // Delegation gets its own slot for the same reason plans do: the generic
  // chip would say "collab agent tool call" and hide the only information the
  // user can get about work that is happening on another thread entirely.
  if (item.delegation) {
    return <DelegationCard delegation={item.delegation} status={status} />
  }

  const icon = pickIcon(item.kind)
  const accent = pickAccent(status)
  const label = item.label ?? item.kind

  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => hasDetail && setExpanded((v) => !v)}
        className={[
          'flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition',
          accent.border,
          accent.bg,
          accent.text,
          hasDetail ? 'hover:brightness-125' : 'cursor-default',
        ].join(' ')}
        aria-expanded={hasDetail ? expanded : undefined}
      >
        {isRunning ? (
          <span className={`inline-block h-3 w-3 animate-spin rounded-full border ${accent.spinner}`} />
        ) : (
          <span className="text-xs leading-none">{accent.glyph}</span>
        )}
        <span className="text-[10px] uppercase tracking-[0.18em] opacity-70">{icon}</span>
        <span className="truncate font-medium">{label}</span>
        {hasDetail ? <span className="ml-1 text-[9px] opacity-60">{expanded ? '▾' : '▸'}</span> : null}
      </button>
      {expanded && hasDetail ? (
        <div className="mt-1 max-h-[200px] overflow-y-auto rounded border border-zinc-800/60 bg-zinc-950/50 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-zinc-400 whitespace-pre-wrap break-all">
          {item.detail}
        </div>
      ) : null}
      {references.length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {references.map((reference) => (
            <button
              key={reference.id}
              type="button"
              onClick={() => void openReference(reference)}
              className="rounded border border-cyan-500/30 px-2 py-0.5 text-[10px] text-cyan-200 hover:bg-cyan-500/10"
            >
              Open details
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/**
 * Renders one multi-agent delegation: what was handed off, to how many agents,
 * and what each said back.
 *
 * Why this exists rather than a link into the child conversation: a spawned
 * agent runs on its own codex thread, which this chat is not subscribed to and
 * which upstream deliberately keeps read-only for the parent (openai/codex
 * #33841). The parent's own tool item is therefore the whole story — and it
 * does carry the payload that matters, because `agentsStates` reports each
 * child's status and final message back to the parent.
 */
function DelegationCard({
  delegation,
  status,
}: {
  delegation: NonNullable<ActivityItem['delegation']>
  status: NonNullable<ActivityItem['status']>
}) {
  const { tool, prompt, model, agents } = delegation
  const count = agents.length
  const isLive = status === 'running' || agents.some((agent) => agent.status === 'running')
  const borderTone =
    status === 'error'
      ? 'border-red-500/30'
      : status === 'cancelled'
        ? 'border-amber-500/25'
        : isLive
          ? 'border-cyan-500/30'
          : 'border-emerald-500/25'

  return (
    <div className="my-1.5">
      <div className={'rounded-md border bg-zinc-950/50 ' + borderTone} role="group" aria-label="Delegated agents">
        <div className="flex items-center gap-2 px-2.5 py-1.5 text-[11px]">
          <span
            className={'text-[12px] leading-none ' + (isLive ? 'text-cyan-300' : 'text-emerald-300')}
            aria-hidden="true"
          >
            {'\u21C9'}
          </span>
          <span className="font-medium text-zinc-200">{humanizeTool(tool)}</span>
          {count > 0 ? (
            <span className="text-zinc-500 tabular-nums">
              {count} agent{count > 1 ? 's' : ''}
            </span>
          ) : null}
          {model ? (
            <span className="rounded border border-zinc-700/70 px-1 py-px text-[10px] text-zinc-400">
              {model}
            </span>
          ) : null}
          {isLive ? (
            <span className="ml-auto h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-300" aria-hidden="true" />
          ) : null}
        </div>
        {prompt ? (
          <p className="border-t border-white/[0.04] px-2.5 py-1.5 text-[12px] leading-[1.5] text-zinc-400">
            {prompt}
          </p>
        ) : null}
        {count > 0 ? (
          <ul className="m-0 list-none space-y-1 border-t border-white/[0.04] px-2.5 py-2" role="list">
            {agents.map((agent, index) => (
              <li
                key={agent.threadId}
                className="flex items-start gap-2 text-[12px] leading-[1.5]"
                aria-label={`Agent ${index + 1}: ${agent.status ?? 'running'}`}
              >
                <span
                  className={
                    'mt-[3px] inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[11px] leading-none '
                    + (agent.status === 'completed' ? 'text-emerald-300' : 'text-cyan-300 animate-pulse')
                  }
                  aria-hidden="true"
                >
                  {agent.status === 'completed' ? '\u2713' : '\u25CB'}
                </span>
                {/* V2 names its agents by path (`/root/pong_agent`); V1 has
                    only ids, and a raw UUID is worse than no label. */}
                {agent.name ? (
                  <span className="shrink-0 font-mono text-[11px] text-zinc-400">{agent.name}</span>
                ) : null}
                <span className="min-w-0 flex-1 break-words text-zinc-300">
                  {agent.message ?? (agent.status === 'completed' ? 'done' : 'working…')}
                </span>
                {agent.tokens ? (
                  <span
                    className="shrink-0 text-[10px] tabular-nums text-zinc-500"
                    title={`${agent.tokens.input.toLocaleString()} in / ${agent.tokens.output.toLocaleString()} out`}
                  >
                    {(agent.tokens.input + agent.tokens.output).toLocaleString()} tok
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  )
}

/** `spawnAgent` → `spawn agent`; upstream's camelCase reads badly in a card. */
function humanizeTool(tool: string): string {
  return tool.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
}

function pickIcon(kind: string): string {
  switch (kind) {
    case 'mcpToolCall':
      return 'mcp'
    case 'webSearch':
      return 'web'
    case 'dynamicToolCall':
    case 'collabToolCall':
      return 'tool'
    case 'imageView':
      return 'img'
    case 'plan':
      return 'plan'
    case 'enteredReviewMode':
    case 'exitedReviewMode':
      return 'review'
    case 'contextCompaction':
      return 'ctx'
    default:
      return 'act'
  }
}

function pickAccent(status: NonNullable<ActivityItem['status']>): {
  border: string
  bg: string
  text: string
  spinner: string
  glyph: string
} {
  switch (status) {
    case 'running':
      return {
        border: 'border-cyan-500/40',
        bg: 'bg-cyan-500/10',
        text: 'text-cyan-200',
        spinner: 'border-cyan-700 border-t-cyan-300',
        glyph: '·',
      }
    case 'success':
      return {
        border: 'border-emerald-500/30',
        bg: 'bg-emerald-500/5',
        text: 'text-emerald-200/90',
        spinner: 'border-emerald-700 border-t-emerald-300',
        glyph: '✓',
      }
    case 'error':
      return {
        border: 'border-red-500/40',
        bg: 'bg-red-500/10',
        text: 'text-red-200',
        spinner: 'border-red-700 border-t-red-300',
        glyph: '!',
      }
    case 'cancelled':
      return {
        border: 'border-amber-500/30',
        bg: 'bg-amber-500/5',
        text: 'text-amber-200/90',
        spinner: 'border-amber-700 border-t-amber-300',
        glyph: '⊘',
      }
  }
}

/**
 * Renders a Codex `plan` (a.k.a. `todo_write` / `update_plan`) activity
 * as a Cursor / Codex-CLI-style to-do list. Visual contract matches the
 * canonical reference image (the user-approved spec):
 *
 *   Header   "N of M Done" with a tiny task-list icon, right-aligned
 *            so the count reads naturally left-to-right
 *   Step row Icon column (fixed width, tabular rhythm) + body text
 *            pending     `○`  dimmed zinc, normal weight
 *            in_progress `→`  cyan, body emphasised, soft pulse
 *            completed   `⊘`  zinc, body strikethrough (Cursor-style:
 *                              the *completion* is the affordance, not
 *                              an attention-grabbing emerald check)
 *
 * Placeholder state (steps.length === 0): the plan tool fired but no
 * structured data arrived yet (or ever — some gateways send the plan
 * as prose). Show a single "Creating plan…" row with a pulsing dot so
 * the slot still feels alive instead of falling back to the generic
 * activity chip. If we did capture an explanation string we surface it
 * as the row body — that's typically the model's own summary of what
 * it's about to do.
 */
function PlanCard({
  item,
  steps,
  status,
}: {
  item: ActivityItem
  steps: PlanStep[]
  status: NonNullable<ActivityItem['status']>
}) {
  const completedCount = steps.filter((s) => s.status === 'completed').length
  const total = steps.length
  const progressPct = total > 0 ? Math.round((completedCount / total) * 100) : 0
  // "Live" is broader than `status === 'running'` because the renderer
  // status may flicker briefly between intermediate update_plan tool calls
  // — but as long as any step is in_progress the work is plainly ongoing.
  const isLive = status === 'running' || steps.some((s) => s.status === 'in_progress')
  const isPlaceholder = total === 0
  const borderTone =
    status === 'success'
      ? 'border-emerald-500/25'
      : status === 'error'
        ? 'border-red-500/30'
        : status === 'cancelled'
          ? 'border-amber-500/25'
          : 'border-zinc-700/60'

  return (
    <div className="my-1.5">
      <div
        className={'rounded-md border bg-zinc-950/50 ' + borderTone}
        role="group"
        aria-label="Plan progress"
      >
        {/* Header row: tiny task-list glyph + "N of M Done" counter.
            Mirrors the image-1 spec — no redundant "TOOL plan" prefix,
            no "Task list" subtitle. The card itself IS the plan. */}
        <div className="flex items-center gap-2 px-2.5 py-1.5 text-[11px]">
          <span
            className={
              'inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[12px] leading-none ' +
              (isLive ? 'text-cyan-300' : status === 'success' ? 'text-emerald-300' : 'text-zinc-500')
            }
            aria-hidden="true"
          >
            {/* unicode task-list glyph: three short lines with bullets */}
            {'\u2630'}
          </span>
          <span
            className={
              'flex-1 truncate font-medium tabular-nums ' +
              (isLive ? 'text-zinc-200' : 'text-zinc-300')
            }
            aria-label={`${completedCount} of ${Math.max(total, 1)} steps completed`}
          >
            {isPlaceholder ? 'Creating plan…' : `${completedCount} of ${total} Done`}
          </span>
          {isLive && !isPlaceholder ? (
            <span
              className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-cyan-300"
              aria-hidden="true"
            />
          ) : null}
        </div>
        {/* Slim progress bar — purely visual; counter above is the
            screen-reader source of truth. transform-width keeps it on
            the GPU compositor path. */}
        {!isPlaceholder ? (
          <div className="h-[2px] w-full overflow-hidden bg-white/[0.04]" aria-hidden="true">
            <div
              className={
                'h-full transition-[width] duration-300 ease-out ' +
                (status === 'success' ? 'bg-emerald-400/70' : 'bg-cyan-400/60')
              }
              style={{ width: `${progressPct}%` }}
            />
          </div>
        ) : null}
        <ol
          className="m-0 list-none space-y-1 px-2.5 py-2"
          role="list"
          aria-label="Plan steps"
        >
          {isPlaceholder ? (
            <PlanPlaceholderRow detail={typeof item.detail === 'string' ? item.detail : undefined} />
          ) : (
            steps.map((step, idx) => <PlanStepRow key={`${idx}:${step.text}`} step={step} index={idx} />)
          )}
        </ol>
      </div>
    </div>
  )
}

function PlanStepRow({ step, index }: { step: PlanStep; index: number }) {
  const rowTone =
    step.status === 'completed'
      ? 'text-zinc-500 line-through decoration-zinc-600/60'
      : step.status === 'in_progress'
        ? 'text-cyan-100'
        : 'text-zinc-300'
  const glyphTone =
    step.status === 'completed'
      ? 'text-zinc-500'
      : step.status === 'in_progress'
        ? 'text-cyan-300'
        : 'text-zinc-500'
  return (
    <li
      className={'flex items-start gap-2.5 text-[12px] leading-[1.55] ' + rowTone}
      aria-label={`Step ${index + 1}: ${step.text} (${step.status})`}
    >
      <span
        className={
          'mt-[3px] inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[12px] leading-none tabular-nums ' +
          glyphTone +
          (step.status === 'in_progress' ? ' animate-pulse' : '')
        }
        aria-hidden="true"
      >
        {planStepGlyph(step.status)}
      </span>
      <span
        className={
          'min-w-0 break-words ' + (step.status === 'in_progress' ? 'font-medium' : '')
        }
      >
        {step.text}
      </span>
    </li>
  )
}

function PlanPlaceholderRow({ detail }: { detail?: string }) {
  // Show the model's explanation (or arguments string) inside the
  // placeholder row when we have one — that's typically the model's
  // own summary of what it's about to do, and it's far more useful
  // than a static "Working…".
  const trimmed = detail?.trim()
  const body = trimmed && trimmed.length > 0 && trimmed.length < 280 ? trimmed : 'Working on the plan…'
  return (
    <li
      className="flex items-start gap-2.5 text-[12px] leading-[1.55] text-zinc-400 italic"
      aria-label="Plan is being created"
    >
      <span
        className="mt-[3px] inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[12px] leading-none text-cyan-300 animate-pulse"
        aria-hidden="true"
      >
        {'\u2022'}
      </span>
      <span className="min-w-0 break-words">{body}</span>
    </li>
  )
}

function planStepGlyph(s: PlanStep['status']): string {
  switch (s) {
    case 'completed':
      // crossed-out circle — same affordance as image 1: visible
      // completion mark without competing with strikethrough text
      return '\u2298'
    case 'in_progress':
      // heavy rightwards arrow — "we're working on this now"
      return '\u2192'
    case 'pending':
      // light open circle — minimal visual weight for "not yet"
      return '\u25CB'
  }
}
