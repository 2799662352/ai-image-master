import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { CodexSkillSummary } from '../../../../types/agent'
import type { AgentReference } from '../../../../types/agent-reference'
import { CollabModeControl } from './CollabModeControl'
import { ModelPicker } from './ModelPicker'
import { ImageChannelPicker } from './ImageChannelPicker'
import { ReferenceChip } from './references/ReferenceChip'
import { makeFileReference } from './references/referenceUtils'
import { useAgentChatStore, type PluginMentionCandidate } from './store'
import {
  dragCarriesDroppablePayload,
  dragCarriesWorkbenchCards,
  parseFileDrop,
  parseQuoteDrop,
  parseWorkbenchCardDrop,
} from '../file-explorer/dragHelpers'
import type { WorkbenchCardDragItem } from '../file-explorer/dragHelpers'
import { buildWorkbenchCardDoc, workbenchCardDocName } from './workbenchCardDoc'
import { useFileExplorerStore } from '../file-explorer/store'
import type { FileNode } from '../file-explorer/types'
import { rankFuzzyTargets, scoreFuzzyMatch } from './paletteFuzzy'
import { INIT_AGENTS_MD_PROMPT } from './initPrompt'
import { parseGoalCommand } from './goalCommand'
import { usePetStore } from './pets/petStore'
import { PetPickerButton } from './pets/PetPickerButton'

/**
 * Find the active `$skill-name` token at `caret`, if any. Mirrors the
 * codex app-server marker rule: a `$` is only a skill marker when it sits
 * at the start of input or right after whitespace, and the token runs
 * until the next non-`[\w-]` character. Returns `null` when the caret is
 * not inside a skill token.
 *
 * The query must be empty (just-typed `$`) OR start with an alpha char or
 * underscore. This excludes `$42` (price), `$0` (shell exit code), etc.
 * from popping up — codex skill names always start with a letter on disk.
 *
 * Returned `start` is the offset of the `$` itself so callers can splice
 * the existing token out when committing a popup selection.
 */
export function detectSkillTrigger(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const m = /(?:^|\s)\$(|[A-Za-z_][\w-]*)$/.exec(before)
  if (!m) return null
  return { start: caret - m[1].length - 1, query: m[1] }
}

/**
 * Find an active `@<query>` mention at the caret. Mirrors codex's
 * `fuzzyFileSearch` UX: the marker only counts at start of input or after
 * whitespace. The query may contain any non-whitespace character so paths
 * like `@src/foo bar.ts` work up to the first space (we cap at the first
 * whitespace which mirrors how Cursor handles file mentions).
 */
export function detectAtTrigger(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const m = /(?:^|\s)@([^\s@]*)$/.exec(before)
  if (!m) return null
  return { start: caret - m[1].length - 1, query: m[1] }
}

/**
 * Find an active `/<query>` command palette trigger at the caret. Mirrors
 * the `$` / `@` triggers' anchor rule (`(?:^|\s)`) so the palette **re-arms
 * after a previous skill commit** — input like `"$skill /"` must reopen
 * the palette, not stay dormant.
 *
 * URLs and paths are still naturally excluded because their `/` is preceded
 * by non-whitespace chars: `https:/` (`:`), `path/` (letter), `1/2` (digit).
 * Only a deliberately-typed `open /etc/...` would trigger — and `Esc` closes
 * the popup without disrupting input.
 *
 * Rules:
 *   - `/` must be at offset 0 OR right after a whitespace char.
 *   - Query is `[\w-]*` (commands look like `read-branch`, `model-pick`).
 *   - Empty query opens the palette showing every section.
 *
 * Returned `start` is the offset of the `/` itself so the commit handler
 * can splice the literal `/<query>` token out of the text when the user
 * picks an action — both commands and skills shouldn't leave `/` text behind.
 *
 * Regression history: an earlier `(?:^|\n)` anchor blocked retrigger after
 * a `$skill ` insertion (input `"$skill /"` is space-preceded, not newline-
 * preceded), making the palette feel "one-shot per line".
 */
export function detectSlashTrigger(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const m = /(?:^|\s)\/(|[\w-]*)$/.exec(before)
  if (!m) return null
  return { start: caret - m[1].length - 1, query: m[1] }
}

/**
 * Walk a workspace tree and return every file (not directory) along with
 * its name + path + workspace-root-relative path. The relative path is what
 * we score against — matching `src/foo.ts` is what users actually type
 * after `@`, not the absolute path.
 */
export function flattenWorkspaceFiles(
  trees: readonly FileNode[],
): { path: string; name: string; relPath: string }[] {
  const out: { path: string; name: string; relPath: string }[] = []
  for (const root of trees) {
    walk(root, root.path, out)
  }
  return out
}

function walk(
  node: FileNode,
  rootPath: string,
  out: { path: string; name: string; relPath: string }[],
): void {
  if (node.kind === 'file') {
    const rel = node.path.startsWith(rootPath) ? node.path.slice(rootPath.length).replace(/^[\\/]+/, '') : node.name
    out.push({ path: node.path, name: node.name, relPath: rel })
    return
  }
  for (const child of node.children ?? []) walk(child, rootPath, out)
}

/**
 * Score a file against a query. Higher is better.
 *  - Exact name match → 100
 *  - Name starts with query → 50 + (1 / name.length)  (shorter names win on ties)
 *  - Query is a substring of relPath → 10
 *  - Otherwise → 0 (filtered out)
 *
 * Query is matched case-insensitively. This is intentionally simple — Cursor
 * uses a fancier subsequence match but for ~1000 files the difference is
 * imperceptible and we sidestep the maintenance burden.
 */
export function scoreFileMatch(query: string, relPath: string, name: string): number {
  if (query.length === 0) return 1 // show everything when query is empty
  const q = query.toLowerCase()
  const n = name.toLowerCase()
  const r = relPath.toLowerCase()
  if (n === q) return 100
  if (n.startsWith(q)) return 50 + 1 / Math.max(name.length, 1)
  if (r.includes(q) || n.includes(q)) return 10
  return 0
}

// ---------------------------------------------------------------------------
// `/` command palette — Skills + Commands sections, à la Cursor / VS Code.
// Codex's TUI ships /clear, /init, /compact, /help, /quit, /model. We only
// wire ones that map to existing actions in this Electron app and label them
// to mirror Cursor's vocabulary so muscle memory transfers.
// ---------------------------------------------------------------------------

/** Discriminated action key — keeps SLASH_COMMANDS pure data (testable). */
export type SlashCommandAction = 'clear' | 'cancel' | 'help' | 'compact' | 'init' | 'goal' | 'pets'

export interface SlashCommand {
  id: string
  label: string
  description: string
  action: SlashCommandAction
}

/**
 * Static command list. Order in this array IS the rendered order — the
 * filter preserves it after pruning. Keep most-common at the top: clear,
 * cancel, help, then compact (placeholder until we wire codex's compact RPC).
 */
export const SLASH_COMMANDS: ReadonlyArray<SlashCommand> = [
  {
    id: 'clear',
    label: '/clear',
    description: 'Start a new thread (clear the conversation)',
    action: 'clear',
  },
  {
    id: 'cancel',
    label: '/cancel',
    description: 'Cancel the running turn',
    action: 'cancel',
  },
  {
    id: 'help',
    label: '/help',
    description: 'Show keyboard shortcuts and trigger reference',
    action: 'help',
  },
  {
    id: 'compact',
    label: '/compact',
    description: '压缩上下文 · 总结并丢弃旧历史释放窗口(对齐 codex /compact)',
    action: 'compact',
  },
  {
    id: 'init',
    label: '/init',
    description: '生成 AGENTS.md 贡献者指南(已存在则不覆盖 · 对齐 codex /init)',
    action: 'init',
  },
  {
    id: 'goal',
    label: '/goal',
    description: '长期目标 · /goal 目标 · pause|resume|edit|clear · budget <n>(对齐 codex /goal)',
    action: 'goal',
  },
  {
    id: 'pets',
    label: '/pets',
    description: '选择环境宠物 · 首行可关闭(对齐 codex /pets)',
    action: 'pets',
  },
]

export type PaletteItem =
  | { kind: 'command'; command: SlashCommand }
  | { kind: 'skill'; skill: CodexSkillSummary }

export interface PaletteSection {
  id: 'commands' | 'skills'
  label: string
  items: PaletteItem[]
}

/**
 * Per-section result cap. Commands are few (~4) so we never truncate them.
 * Skills can be 20+ on a power-user setup — the popup itself is scrollable
 * (`max-h-72` + `overflow-auto` in the JSX), so we surface up to this many
 * matches instead of the old hard cut of 8. The hard ceiling keeps render
 * cost bounded; in practice users converge on a query within 2-3 keystrokes.
 */
const SKILL_RESULT_LIMIT = 50

/**
 * Filter both sections by `query` using `paletteFuzzy.rankFuzzyTargets` so
 * subsequence matches surface: `rev` reaches `reverse`, `tdd` reaches
 * `test-driven-development`. Commands are matched against id/label/desc;
 * skills against name/description. Empty query returns everything in input
 * order so the popup feels predictable to mouse-only users.
 *
 * Exported (rather than inlined) so the popup state hook AND tests can
 * share one filter implementation — keyboard nav ranking depends on it.
 */
export function filterPaletteItems(
  query: string,
  skills: readonly CodexSkillSummary[],
): { commands: SlashCommand[]; skills: CodexSkillSummary[] } {
  const commands = rankFuzzyTargets(SLASH_COMMANDS, query, (c) => [c.id, c.label, c.description])
  const skillsRanked = rankFuzzyTargets(skills, query, (s) => [s.name, s.description])
  return {
    commands,
    skills: skillsRanked.slice(0, SKILL_RESULT_LIMIT),
  }
}

/**
 * Compute the indices of `target` characters that matched `query`, using the
 * same scorer that drove the ranking. Returns an empty array on empty query.
 * Callers wrap matched glyphs in a span to emulate the VS Code / Cursor
 * "hot prefix" highlight feel. Exported for the row renderer + tests.
 */
export function highlightMatchIndices(query: string, target: string): number[] {
  if (query.length === 0) return []
  return scoreFuzzyMatch(query, target).indices
}

/**
 * Build the list of non-empty sections for rendering. Commands before
 * Skills mirrors Cursor's image — fewer, more frequently used items
 * surface above the longer skill list.
 */
export function buildPaletteSections(
  query: string,
  skills: readonly CodexSkillSummary[],
): PaletteSection[] {
  const filtered = filterPaletteItems(query, skills)
  const sections: PaletteSection[] = []
  if (filtered.commands.length > 0) {
    sections.push({
      id: 'commands',
      label: 'Commands',
      items: filtered.commands.map((command) => ({ kind: 'command' as const, command })),
    })
  }
  if (filtered.skills.length > 0) {
    sections.push({
      id: 'skills',
      label: 'Skills',
      items: filtered.skills.map((skill) => ({ kind: 'skill' as const, skill })),
    })
  }
  return sections
}

const MAX_ATTACHMENTS = 20
// Path-based attachments are streamed off disk by the main process (never copied
// into renderer memory or an IPC structuredClone — see the onFileChange/onDrop
// notes about webUtils.getPathForFile), so they can be large: cap at the same
// 2GB the qwen understand path supports. Buffer-based attachments (synthetic /
// clipboard File via arrayBuffer()) DO cross IPC in memory, so they keep a
// conservative cap.
const MAX_PATH_ATTACHMENT_BYTES = 2 * 1024 * 1024 * 1024 // 2GB (streamed from disk)
const MAX_BUFFER_ATTACHMENT_BYTES = 100 * 1024 * 1024 // 100MB (in-memory + IPC structuredClone)
const MAX_TOTAL_ATTACHMENT_BYTES = 4 * 1024 * 1024 * 1024 // 4GB across all attachments

// auto-grow 输入框：13px * 1.55 行高 ≈ 20px/行 + 上下 padding 16px
const TEXTAREA_LINE_HEIGHT = 20
const TEXTAREA_PADDING_Y = 16
const TEXTAREA_MIN_HEIGHT = TEXTAREA_LINE_HEIGHT * 2 + TEXTAREA_PADDING_Y // 2 行
const TEXTAREA_MAX_HEIGHT = TEXTAREA_LINE_HEIGHT * 8 + TEXTAREA_PADDING_Y // 8 行

type FileExplorerApi = {
  fs?: {
    stat: (p: string) => Promise<
      | { ok: true; size: number; mime: string; mtime: number }
      | { ok: false; reason?: string }
    >
  }
}

// Small inline SVG glyphs for the `/` palette. Lucide-style 1.6 stroke,
// 14px viewBox so the icon line up flush with `text-[12px]` / `text-[11px]`
// on the row. Colors stay neutral so highlight bg drives the visual focus.
function SlashGlyph(): JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0 text-cyan-300/70"
    >
      <path d="M9.5 2 4.5 12" />
    </svg>
  )
}

function SkillGlyph(): JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0 text-cyan-300/70"
    >
      <path d="M7 1.5 8.4 5.2 12.2 5.6 9.4 8.2 10.2 12 7 10.1 3.8 12 4.6 8.2 1.8 5.6 5.6 5.2 7 1.5Z" />
    </svg>
  )
}

/**
 * Render `text` with the characters at `matchIndices` wrapped in a tinted
 * span. Mirrors VS Code / Cursor's "hot prefix" highlight so the user can
 * see WHY a row matched their typed query — `re` on `reverse` makes the
 * leading `re` glow. Falls back to plain text on empty `matchIndices`.
 */
function HighlightedText({
  text,
  matchIndices,
  className,
}: {
  text: string
  matchIndices: readonly number[]
  className?: string
}): JSX.Element {
  if (matchIndices.length === 0) {
    return <span className={className}>{text}</span>
  }
  // Walk `text` once; emit alternating plain / highlighted spans. Using a
  // Set membership check keeps the hot path linear without sorting hits.
  const hits = new Set(matchIndices)
  const out: JSX.Element[] = []
  let buffer = ''
  let isHit = false
  const flush = (key: number) => {
    if (buffer.length === 0) return
    out.push(
      isHit ? (
        <mark
          key={key}
          className="rounded-sm bg-cyan-300/25 px-px font-semibold text-cyan-50"
        >
          {buffer}
        </mark>
      ) : (
        <span key={key}>{buffer}</span>
      ),
    )
    buffer = ''
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    const charIsHit = hits.has(i)
    if (charIsHit !== isHit) {
      flush(i)
      isHit = charIsHit
    }
    buffer += ch
  }
  flush(text.length)
  return <span className={className}>{out}</span>
}

/**
 * Scope chip color mapping. REPO is the "ship with project" green, USER is
 * the personal cyan that mirrors brand color, SYSTEM is amber for "shipped
 * read-only". Matches the SkillsSection palette so users learn one scheme.
 */
function ScopeChip({ scope }: { scope: 'repo' | 'user' | 'system' | string }): JSX.Element {
  const styles =
    scope === 'repo'
      ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-100'
      : scope === 'system'
        ? 'border-amber-400/40 bg-amber-400/10 text-amber-100'
        : 'border-cyan-400/40 bg-cyan-400/10 text-cyan-100'
  return (
    <span
      className={
        'rounded border px-1 py-[1px] text-[9px] font-medium uppercase tracking-[0.16em] ' +
        styles
      }
    >
      {scope}
    </span>
  )
}

export function MentionInput() {
  const input = useAgentChatStore((state) => state.input)
  const isRunning = useAgentChatStore((state) => state.isRunning)
  // A model-selection transaction may restart the Codex backend; block new
  // sends and composer channel controls until it commits or rolls back.
  const modelSelectionPending = useAgentChatStore(
    (state) => state.modelSelectionPending !== undefined,
  )
  const attachments = useAgentChatStore((state) => state.attachments)
  const setInput = useAgentChatStore((state) => state.setInput)
  const setError = useAgentChatStore((state) => state.setError)
  const addAttachment = useAgentChatStore((state) => state.addAttachment)
  const removeAttachmentForReference = useAgentChatStore((state) => state.removeAttachmentForReference)
  const pendingReferences = useAgentChatStore((state) => state.pendingReferences)
  const addPendingReference = useAgentChatStore((state) => state.addPendingReference)
  const removePendingReference = useAgentChatStore((state) => state.removePendingReference)
  const send = useAgentChatStore((state) => state.send)
  const steer = useAgentChatStore((state) => state.steer)
  const cancel = useAgentChatStore((state) => state.cancel)
  const editingMessageId = useAgentChatStore((state) => state.editingMessageId)
  const submitEditMessage = useAgentChatStore((state) => state.submitEditMessage)
  const cancelEditMessage = useAgentChatStore((state) => state.cancelEditMessage)
  const pendingChatInsert = useFileExplorerStore((state) => state.pendingChatInsert)
  const consumePendingChatInsert = useFileExplorerStore((state) => state.consumePendingChatInsert)
  const openReference = useFileExplorerStore((state) => state.openReference)
  const availableSkills = useAgentChatStore((state) => state.availableSkills)
  const loadAvailableSkills = useAgentChatStore((state) => state.loadAvailableSkills)
  const availablePluginMentions = useAgentChatStore((state) => state.availablePluginMentions)
  const loadAvailablePluginMentions = useAgentChatStore((state) => state.loadAvailablePluginMentions)
  const workspaceTree = useFileExplorerStore((state) => state.workspaceTree)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [skillPopup, setSkillPopup] = useState<{ start: number; query: string } | null>(null)
  const [skillHighlight, setSkillHighlight] = useState(0)
  const [filePopup, setFilePopup] = useState<{ start: number; query: string } | null>(null)
  const [fileHighlight, setFileHighlight] = useState(0)
  const [slashPopup, setSlashPopup] = useState<{ start: number; query: string } | null>(null)
  const [slashHighlight, setSlashHighlight] = useState(0)
  /** 拖着可投放的东西悬在组合器上。此前完全没有反馈,用户不知道能往哪儿放。 */
  const [dropActive, setDropActive] = useState(false)
  const newThread = useAgentChatStore((state) => state.newThread)
  const pushNotice = useAgentChatStore((state) => state.pushNotice)
  const setGoal = useAgentChatStore((state) => state.setGoal)
  const setGoalStatus = useAgentChatStore((state) => state.setGoalStatus)
  const setGoalBudget = useAgentChatStore((state) => state.setGoalBudget)
  const clearGoal = useAgentChatStore((state) => state.clearGoal)
  const refreshGoal = useAgentChatStore((state) => state.refreshGoal)
  const compact = useAgentChatStore((state) => state.compact)

  // Lazy-load the skill list on first mount so the `$` trigger has data
  // ready by the time the user types it. The store action is idempotent —
  // it bails out if `getSkillsSummary` is unavailable so panels mounted
  // outside the agent workspace stay quiet.
  useEffect(() => {
    void loadAvailableSkills()
  }, [loadAvailableSkills])

  // Same lazy-load for `@plugin` mention candidates (codex plugin/installed).
  // Bails out silently when the IPC surface is unavailable, so the `@` popup
  // simply shows files only.
  useEffect(() => {
    void loadAvailablePluginMentions()
  }, [loadAvailablePluginMentions])

  function refreshTriggerPopups(): void {
    const el = textareaRef.current
    if (!el) {
      setSkillPopup(null)
      setFilePopup(null)
      setSlashPopup(null)
      return
    }
    const caret = el.selectionStart ?? el.value.length
    const slashDetected = detectSlashTrigger(el.value, caret)
    const skillDetected = detectSkillTrigger(el.value, caret)
    const atDetected = detectAtTrigger(el.value, caret)
    // Only reset the keyboard highlight when the trigger NEWLY opens or its
    // query/anchor changes. refreshTriggerPopups also runs on `onKeyUp`, which
    // fires after an ArrowDown/ArrowUp keydown (preventDefault stops the caret
    // move but NOT the keyup) — resetting to 0 there would undo the arrow nav
    // the keydown handler just applied, making the popup feel un-navigable.
    const sameTrigger = (
      a: { start: number; query: string } | null,
      b: { start: number; query: string },
    ): boolean => a !== null && a.start === b.start && a.query === b.query
    // Priority: slash palette > skill > file. Slash wins because it's the most
    // explicit (start-of-line only) and shouldn't be ambushed by a stray @ in
    // a multi-line draft.
    if (slashDetected) {
      if (!sameTrigger(slashPopup, slashDetected)) setSlashHighlight(0)
      setSlashPopup(slashDetected)
      setSkillPopup(null)
      setFilePopup(null)
    } else if (skillDetected) {
      if (!sameTrigger(skillPopup, skillDetected)) setSkillHighlight(0)
      setSkillPopup(skillDetected)
      setFilePopup(null)
      setSlashPopup(null)
    } else if (atDetected) {
      if (!sameTrigger(filePopup, atDetected)) setFileHighlight(0)
      setFilePopup(atDetected)
      setSkillPopup(null)
      setSlashPopup(null)
    } else {
      setSkillPopup(null)
      setFilePopup(null)
      setSlashPopup(null)
    }
  }

  const filteredSkills = useMemo<CodexSkillSummary[]>(() => {
    if (!skillPopup) return []
    const q = skillPopup.query.toLowerCase()
    const list = q
      ? availableSkills.filter((s) =>
          s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
        )
      : availableSkills
    // Prefer name-prefix matches first, then fall back to substring matches.
    // 8 keeps the popup compact on short panels (which we resize down to ~360px).
    return [...list]
      .sort((a, b) => Number(b.name.toLowerCase().startsWith(q)) - Number(a.name.toLowerCase().startsWith(q)))
      .slice(0, 8)
  }, [skillPopup, availableSkills])

  function commitSkill(skill: CodexSkillSummary): void {
    if (!skillPopup) return
    const el = textareaRef.current
    if (!el) return
    const caret = el.selectionStart ?? el.value.length
    const before = input.slice(0, skillPopup.start)
    const after = input.slice(caret)
    // Always trail with a space so the user can keep typing without
    // accidentally extending the token. Mirrors VSCode/Cursor behavior.
    const inserted = `$${skill.name} `
    const next = `${before}${inserted}${after}`
    setInput(next)
    setSkillPopup(null)
    requestAnimationFrame(() => {
      const node = textareaRef.current
      if (!node) return
      const newCaret = skillPopup.start + inserted.length
      node.selectionStart = node.selectionEnd = newCaret
      node.focus()
    })
  }

  // ----- `/` slash command palette (Skills + Commands) -----

  const paletteSections = useMemo<PaletteSection[]>(() => {
    if (!slashPopup) return []
    return buildPaletteSections(slashPopup.query, availableSkills)
  }, [slashPopup, availableSkills])

  // Flatten so a single index walks across section boundaries during
  // arrow-key navigation. Section headings are NOT included in the flat
  // list — keyboard cursor only lands on selectable items.
  const flatPaletteItems = useMemo<PaletteItem[]>(
    () => paletteSections.flatMap((section) => section.items),
    [paletteSections],
  )

  function commitPaletteItem(item: PaletteItem): void {
    if (!slashPopup) return
    const el = textareaRef.current
    if (!el) return
    const caret = el.selectionStart ?? el.value.length
    const before = input.slice(0, slashPopup.start)
    const after = input.slice(caret)

    if (item.kind === 'skill') {
      // Replace the typed `/<query>` with `$name ` so the codex skill
      // marker takes effect — picking a skill from `/` is equivalent to
      // typing `$name` directly. The send pipeline already handles the
      // rest (extractSkillTokens → skill input item).
      const inserted = `$${item.skill.name} `
      const next = `${before}${inserted}${after}`
      setInput(next)
      setSlashPopup(null)
      requestAnimationFrame(() => {
        const node = textareaRef.current
        if (!node) return
        const newCaret = slashPopup.start + inserted.length
        node.selectionStart = node.selectionEnd = newCaret
        node.focus()
      })
      return
    }

    // `/goal` is the one command that needs an OBJECTIVE argument, so picking it
    // from the palette must NOT execute — that would clear the box and rob the
    // user of the chance to type their goal. Instead prefill `/goal ` and keep
    // focus; the user types their objective and Enter (tryHandleGoalCommand runs
    // it at submit). Bare `/goal ` + Enter still views the current goal.
    if (item.command.action === 'goal') {
      const inserted = '/goal '
      const nextGoal = `${before}${inserted}${after}`
      setInput(nextGoal)
      setSlashPopup(null)
      requestAnimationFrame(() => {
        const node = textareaRef.current
        if (!node) return
        const newCaret = slashPopup.start + inserted.length
        node.selectionStart = node.selectionEnd = newCaret
        node.focus()
      })
      return
    }

    // Command: drop the `/<query>` literal entirely (commands aren't
    // sent to codex as text) and run the action.
    const next = `${before}${after}`
    setInput(next)
    setSlashPopup(null)
    requestAnimationFrame(() => {
      const node = textareaRef.current
      if (!node) return
      node.selectionStart = node.selectionEnd = slashPopup.start
      node.focus()
    })

    switch (item.command.action) {
      case 'clear':
        void newThread()
        break
      case 'cancel':
        if (isRunning) void cancel()
        else
          pushNotice({
            id: `slash-cancel-noop:${Date.now()}`,
            kind: 'configWarning',
            level: 'info',
            message: 'Nothing to cancel — no turn is currently running.',
          })
        break
      case 'help':
        pushNotice({
          id: `slash-help:${Date.now()}`,
          kind: 'configWarning',
          level: 'info',
          message:
            'Triggers: `@` searches plugins, skills and files in one popup · `$skill-name` invokes a skill directly · `/` opens this palette · ⌘/Ctrl+Enter sends · Esc closes any popup.',
        })
        break
      case 'compact':
        // Native `/compact`: real history compaction via thread/compact/start.
        // The model summarizes + drops old history to reclaim the context
        // window; progress streams back as a `contextCompaction` activity item.
        if (isRunning) {
          pushNotice({
            id: `slash-compact-busy:${Date.now()}`,
            kind: 'configWarning',
            level: 'info',
            message: '正在运行中,先等当前回合结束再 /compact 压缩上下文。',
          })
          break
        }
        void compact()
        break
      case 'init':
        // Native `/init`: send the official prompt as a turn against the
        // current workspace cwd. The agent generates AGENTS.md (and won't
        // overwrite an existing one — the guard is baked into the prompt).
        if (isRunning) {
          pushNotice({
            id: `slash-init-busy:${Date.now()}`,
            kind: 'configWarning',
            level: 'info',
            message: '正在运行中,先等当前回合结束再 /init 生成 AGENTS.md。',
          })
          break
        }
        setInput(INIT_AGENTS_MD_PROMPT)
        void send()
        break
      case 'pets':
        // Native `/pets` (codex parity): open the pet picker rendered by
        // PetOverlay above the composer. Selection state lives in petStore.
        usePetStore.getState().openPicker()
        break
      // No `goal` case: `/goal` is intercepted above (prefill `/goal ` + early
      // return), so TS narrows it out of the union before this switch.
      default: {
        const exhaustive: never = item.command.action
        void exhaustive
      }
    }
  }

  // ----- File `@` mention popup -----

  const allWorkspaceFiles = useMemo(
    () => flattenWorkspaceFiles(workspaceTree),
    [workspaceTree],
  )

  const filteredFiles = useMemo(() => {
    if (!filePopup) return []
    return allWorkspaceFiles
      .map((file) => ({ ...file, score: scoreFileMatch(filePopup.query, file.relPath, file.name) }))
      .filter((f) => f.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
  }, [filePopup, allWorkspaceFiles])

  // Installed plugins matching the `@` query. Rendered ABOVE the file rows in
  // the same popup; the keyboard highlight walks a single flat list
  // (plugins first, then files), so `fileHighlight` indexes into
  // plugins.length + files.length.
  const filteredPlugins = useMemo<PluginMentionCandidate[]>(() => {
    if (!filePopup) return []
    const q = filePopup.query.toLowerCase()
    const list = q
      ? availablePluginMentions.filter(
          (p) => p.token.toLowerCase().includes(q) || p.name.toLowerCase().includes(q),
        )
      : availablePluginMentions
    // 4 keeps the plugin group compact so files remain reachable.
    return [...list]
      .sort((a, b) => Number(b.token.toLowerCase().startsWith(q)) - Number(a.token.toLowerCase().startsWith(q)))
      .slice(0, 4)
  }, [filePopup, availablePluginMentions])

  // Skills matching the `@` query (MentionsV2 parity — openai/codex#19068,
  // promoted to default by #27499): the unified popup searches plugins,
  // skills and files in one flow. Rendered between the plugin and file
  // groups; committing inserts the official `$name ` marker so the existing
  // `$`-token send pipeline (extractSkillTokens → payload.skills) is reused
  // verbatim. The legacy `$` trigger stays for compatibility.
  const filteredAtSkills = useMemo<CodexSkillSummary[]>(() => {
    if (!filePopup) return []
    const q = filePopup.query.toLowerCase()
    const list = q
      ? availableSkills.filter(
          (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
        )
      : availableSkills
    // 4 keeps the skill group compact so files remain reachable (same cap as
    // the plugin group).
    return [...list]
      .sort((a, b) => Number(b.name.toLowerCase().startsWith(q)) - Number(a.name.toLowerCase().startsWith(q)))
      .slice(0, 4)
  }, [filePopup, availableSkills])

  const atPopupItemCount = filteredPlugins.length + filteredAtSkills.length + filteredFiles.length

  /**
   * Commit a plugin mention: unlike files (token replaced by a reference
   * chip), the `@token ` STAYS in the text — per the codex README the text
   * token and the `mention` input item travel together. The send pipeline
   * (extractMentionTokens → resolveMentions) attaches the mention item.
   */
  function commitPluginMention(plugin: PluginMentionCandidate): void {
    if (!filePopup) return
    const el = textareaRef.current
    if (!el) return
    const caret = el.selectionStart ?? el.value.length
    const before = input.slice(0, filePopup.start)
    const after = input.slice(caret)
    const inserted = `@${plugin.token} `
    const next = `${before}${inserted}${after}`
    setInput(next)
    setFilePopup(null)
    requestAnimationFrame(() => {
      const node = textareaRef.current
      if (!node) return
      const newCaret = filePopup.start + inserted.length
      node.selectionStart = node.selectionEnd = newCaret
      node.focus()
    })
  }

  /**
   * Commit a skill picked from the unified `@` popup: replaces the `@query`
   * with the official `$name ` marker (upstream MentionsV2: "selecting a
   * plugin or skill inserts the corresponding `$name`"), so the send pipeline
   * treats it exactly like a hand-typed `$` skill token.
   */
  function commitSkillFromAtPopup(skill: CodexSkillSummary): void {
    if (!filePopup) return
    const el = textareaRef.current
    if (!el) return
    const caret = el.selectionStart ?? el.value.length
    const before = input.slice(0, filePopup.start)
    const after = input.slice(caret)
    const inserted = `$${skill.name} `
    const next = `${before}${inserted}${after}`
    setInput(next)
    setFilePopup(null)
    requestAnimationFrame(() => {
      const node = textareaRef.current
      if (!node) return
      const newCaret = filePopup.start + inserted.length
      node.selectionStart = node.selectionEnd = newCaret
      node.focus()
    })
  }

  /** Commit whatever sits at a flat `@` popup index (plugins → skills → files). */
  function commitAtPopupIndex(idx: number): void {
    if (idx < filteredPlugins.length) {
      commitPluginMention(filteredPlugins[idx])
      return
    }
    const skillIdx = idx - filteredPlugins.length
    if (skillIdx < filteredAtSkills.length) {
      commitSkillFromAtPopup(filteredAtSkills[skillIdx])
      return
    }
    const file = filteredFiles[skillIdx - filteredAtSkills.length]
    if (file) commitFile(file)
  }

  /**
   * Attach a single file by path: stat it, enforce attachment limits, push
   * an attachment + a pending reference. Returns `null` on success or a
   * skip reason. Shared between drag-and-drop and the `@` mention popup
   * so the limit accounting is in one place.
   */
  async function attachFileByPath(
    filePath: string,
    name: string,
  ): Promise<string | null> {
    const fsApi = (window as Window & { electronAPI?: FileExplorerApi }).electronAPI?.fs
    if (!fsApi) return '文件系统 API 不可用'
    const current = useAgentChatStore.getState().attachments
    if (current.length >= MAX_ATTACHMENTS) return `已达 ${MAX_ATTACHMENTS} 个上限`
    const totalBytes = current.reduce((sum, item) => sum + item.size, 0)
    const stat = await fsApi.stat(filePath)
    if (!stat.ok) return '无法读取'
    // Path-based: streamed off disk by main → 2GB cap.
    if (stat.size > MAX_PATH_ATTACHMENT_BYTES) return '超过单文件 2GB'
    if (totalBytes + stat.size > MAX_TOTAL_ATTACHMENT_BYTES) return '超过总量 4GB'
    addAttachment({
      name,
      mime: stat.mime || 'application/octet-stream',
      size: stat.size,
      path: filePath,
    })
    addPendingReference(makeFileReference({ path: filePath, name, mime: stat.mime || undefined }))
    return null
  }

  /**
   * 还没有产物的工作台卡片:合成一份规格说明当附件递过去。
   *
   * 走 buffer 而不是 path,因为磁盘上确实没有这张卡的任何文件(`AgentAttachmentInput`
   * 要求 path/buffer 二选一)。不 push reference —— reference 只认 localPath/url,
   * 这份文档要等主进程落盘后才有路径。
   */
  function attachWorkbenchCardDoc(item: WorkbenchCardDragItem): string | null {
    const current = useAgentChatStore.getState().attachments
    if (current.length >= MAX_ATTACHMENTS) return `已达 ${MAX_ATTACHMENTS} 个上限`
    const bytes = new TextEncoder().encode(buildWorkbenchCardDoc(item))
    // 一份说明只有几 KB,这两道闸门是为了「一次拖几十张卡」的极端情况,顺带与
    // attachFiles 的记账口径保持一致。
    if (bytes.byteLength > MAX_BUFFER_ATTACHMENT_BYTES) return '超过单文件 100MB'
    const totalBytes = current.reduce((sum, attachment) => sum + attachment.size, 0)
    if (totalBytes + bytes.byteLength > MAX_TOTAL_ATTACHMENT_BYTES) return '超过总量 4GB'
    addAttachment({
      name: workbenchCardDocName(item),
      mime: 'text/markdown',
      size: bytes.byteLength,
      buffer: bytes.buffer as ArrayBuffer,
    })
    return null
  }

  function commitFile(file: { path: string; name: string }): void {
    if (!filePopup) return
    const el = textareaRef.current
    if (!el) return
    const caret = el.selectionStart ?? el.value.length
    const before = input.slice(0, filePopup.start)
    const after = input.slice(caret)
    // Cursor-style: the @ mention vanishes from the text once a file is
    // chosen — the reference chip carries the meaning. Without this the
    // user ends up sending half-typed `@src/foo` to codex.
    const next = `${before}${after.startsWith(' ') ? after : ' ' + after}`.replace(/^\s+/, '')
    setInput(next)
    setFilePopup(null)
    void attachFileByPath(file.path, file.name).then((skipReason) => {
      if (skipReason) setError(`已跳过 ${file.path}（${skipReason}）`)
    })
    requestAnimationFrame(() => {
      const node = textareaRef.current
      if (!node) return
      node.selectionStart = node.selectionEnd = filePopup.start
      node.focus()
    })
  }

  // 输入随内容变多自动拉长，到 TEXTAREA_MAX_HEIGHT 后开始内部滚动
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    const next = Math.min(
      Math.max(el.scrollHeight, TEXTAREA_MIN_HEIGHT),
      TEXTAREA_MAX_HEIGHT,
    )
    el.style.height = `${next}px`
    el.style.overflowY = el.scrollHeight > TEXTAREA_MAX_HEIGHT ? 'auto' : 'hidden'
  }, [input])

  function appendInput(text: string): void {
    setInput(input ? `${input}\n${text}` : text)
  }

  useEffect(() => {
    if (pendingChatInsert == null) return
    const pending = consumePendingChatInsert()
    if (pending != null) appendInput(pending)
  }, [pendingChatInsert, consumePendingChatInsert])

  async function attachFiles(files: File[]): Promise<void> {
    const currentAttachments = useAgentChatStore.getState().attachments
    const remainingSlots = Math.max(MAX_ATTACHMENTS - currentAttachments.length, 0)
    let totalBytes = currentAttachments.reduce((sum, item) => sum + item.size, 0)
    let skipped = 0

    // Prefer "path-only" attachments: ask the preload (via webUtils.getPathForFile,
    // Electron ≥ 32) for the on-disk path. When we have a path we never copy the
    // file contents into renderer memory or into an IPC structuredClone — the
    // main process streams the bytes off disk itself. This mirrors the drag-and-
    // drop path and follows the path-based staging direction proposed in
    // openai/codex#21108 for avoiding attachment-induced freezes.
    //
    // Fallback to arrayBuffer() only when the source isn't a real file (e.g. a
    // synthetic File from a clipboard paste); preload returns "" in that case.
    const electronApi = (window as Window & { electronAPI?: { getFilePath?: (file: File) => string } }).electronAPI

    for (const file of files.slice(0, remainingSlots)) {
      // Decide the source FIRST: a real on-disk path → streamed by main (2GB cap);
      // no path (synthetic/clipboard File) → arrayBuffer() into memory + IPC (100MB cap).
      const filePath = electronApi?.getFilePath ? electronApi.getFilePath(file) : ''
      const perFileCap = filePath ? MAX_PATH_ATTACHMENT_BYTES : MAX_BUFFER_ATTACHMENT_BYTES
      if (file.size > perFileCap || totalBytes + file.size > MAX_TOTAL_ATTACHMENT_BYTES) {
        skipped += 1
        continue
      }
      if (filePath) {
        addAttachment({
          name: file.name,
          mime: file.type || 'application/octet-stream',
          size: file.size,
          path: filePath,
        })
      } else {
        addAttachment({
          name: file.name,
          mime: file.type || 'application/octet-stream',
          size: file.size,
          buffer: await file.arrayBuffer(),
        })
      }
      totalBytes += file.size
    }

    if (files.length > remainingSlots) skipped += files.length - remainingSlots
    setError(skipped > 0 ? `Skipped ${skipped} file(s) because of attachment limits.` : undefined)
  }

  async function onFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    await attachFiles(Array.from(event.target.files ?? []))
    event.target.value = ''
  }

  async function onPaste(event: React.ClipboardEvent<HTMLTextAreaElement>): Promise<void> {
    // Images AND audio ride the paste path — audio files travel to codex as
    // native `localAudio`/`audio` input items (Codex 0.145).
    const isMediaMime = (mime: string): boolean =>
      mime.startsWith('image/') || mime.startsWith('audio/')
    const itemImages = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file' && isMediaMime(item.type))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null)
    // Chromium normally exposes screenshots through `items`; `files` is a
    // compatibility fallback for clipboard providers that omit item entries.
    const imageFiles = itemImages.length > 0
      ? itemImages
      : Array.from(event.clipboardData.files).filter((file) => isMediaMime(file.type))
    if (imageFiles.length === 0) return

    // Stop Chromium from also inserting an image URL/HTML representation into
    // the textarea. Plain-text-only paste remains fully native.
    event.preventDefault()
    await attachFiles(imageFiles)
  }

  async function onDrop(event: React.DragEvent): Promise<void> {
    event.preventDefault()
    setDropActive(false)
    const quote = parseQuoteDrop(event.dataTransfer)
    if (quote) {
      appendInput(quote)
      return
    }

    // 视频工作台卡片。它走自己的 MIME 而不是文件路径那个 —— 文件路径 MIME 的含义
    // 是「可移动的工作区文件」,而文件栏与工作台同屏,复用会让卡片被拖过文件树时
    // 真的 fs.move 掉 mp4。这里显式认领。
    const droppedCards = parseWorkbenchCardDrop(event.dataTransfer)
    if (droppedCards.length > 0) {
      // 每张卡按「产物存活性」逐级降级,与播放器同一顺序:
      //   1. 本地 mp4 还在 → 附件 + 引用(路径在 uploads 白名单内,引用过得了主进程那道门)
      //   2. 只剩耐久地址 → 把 URL 写进输入框。**视频 URL 走不了 reference**:
      //      mapReferencesToInputItems 只把 image/audio 的 url 变成输入项,视频 URL
      //      会被静默丢掉,模型压根看不见 —— 那样等于假装递了东西。
      //   3. 真没有产物 → 合成一份规格说明当附件(见 workbenchCardDoc)。
      // 第 2 级存在的理由:本地 mp4 会被 7 天清理扫掉,而卡片对那个清理是隐形的。
      // 早先只看 localPath,于是这种卡被误报成「还没有生成结果」,可播放器还放得出来。
      const skipped: string[] = []
      const durableUrls: string[] = []
      for (const item of droppedCards) {
        if (item.localPath) {
          const name = item.localPath.split(/[\\/]/).pop() ?? item.localPath
          const reason = await attachFileByPath(item.localPath, name)
          if (reason) skipped.push(`${name}(${reason})`)
          continue
        }
        const durable = item.remoteUrl ?? item.videoUrl
        if (durable) {
          durableUrls.push(durable)
          continue
        }
        const reason = attachWorkbenchCardDoc(item)
        if (reason) skipped.push(`${workbenchCardDocName(item)}(${reason})`)
      }
      // 循环里逐张 appendInput 会各自基于同一份过期的 input 快照,只剩最后一条。
      if (durableUrls.length > 0) appendInput(durableUrls.join('\n'))
      setError(skipped.length > 0 ? `已跳过 ${skipped.length} 个:${skipped.join('、')}` : undefined)
      return
    }

    // Two source tiers, normalised into a single Candidate list so the quota
    // loop below stays linear:
    //   Tier 2 — internal file-explorer drag with our custom MIME. We only
    //            have absolute paths, so size+mime must come from fsApi.stat.
    //            Paths are inside the workspace, so assertContained passes.
    //   Tier 3 — external OS drop (Desktop, Finder, Explorer). dataTransfer
    //            .files carries File objects that already expose size + type,
    //            and electronAPI.getFilePath (Electron 32+ webUtils) maps each
    //            File → OS path. We MUST NOT call fsApi.stat here: the IPC
    //            stat handler validates via assertContained, and external
    //            paths are by design outside allowedRoots — that's where the
    //            "无法读取" bug came from. Mirror onFileChange (lines 730-754)
    //            which already uses File.size/type for the same reason.
    //
    // Synthetic Files (clipboard paste; getFilePath → '') are filtered out —
    // Ctrl+V image paste is intentionally out of scope for PR-1.
    type Candidate = { path: string; preStat?: { size: number; mime: string } }
    const internalPaths = parseFileDrop(event.dataTransfer)
    let candidates: Candidate[]
    if (internalPaths.length > 0) {
      candidates = internalPaths.map((p) => ({ path: p }))
    } else if (event.dataTransfer.files.length > 0) {
      const electronApi = (window as Window & { electronAPI?: { getFilePath?: (file: File) => string } }).electronAPI
      const getFilePath = electronApi?.getFilePath
      if (!getFilePath) return
      candidates = Array.from(event.dataTransfer.files)
        .map((file): Candidate | null => {
          const path = getFilePath(file)
          if (!path) return null
          return {
            path,
            preStat: { size: file.size, mime: file.type || 'application/octet-stream' },
          }
        })
        .filter((c): c is Candidate => c !== null)
    } else {
      return
    }

    if (candidates.length === 0) return
    const fsApi = (window as Window & { electronAPI?: FileExplorerApi }).electronAPI?.fs
    // fsApi only needed for Tier 2 candidates (no preStat). Tier 3 carries
    // everything it needs in preStat, so a missing fsApi is non-fatal there.
    if (!fsApi && candidates.some((c) => !c.preStat)) return

    // 共享配额（在循环里更新），让用户看到一次合并后的 skip 提示
    const currentAttachments = useAgentChatStore.getState().attachments
    let remainingSlots = Math.max(MAX_ATTACHMENTS - currentAttachments.length, 0)
    let totalBytes = currentAttachments.reduce((sum, item) => sum + item.size, 0)
    const skippedReasons: string[] = []

    for (const c of candidates) {
      if (remainingSlots <= 0) {
        skippedReasons.push(`${c.path}（已达 ${MAX_ATTACHMENTS} 个上限）`)
        continue
      }
      let size: number
      let mime: string
      if (c.preStat) {
        size = c.preStat.size
        mime = c.preStat.mime
      } else {
        const stat = await fsApi!.stat(c.path)
        if (!stat.ok) {
          skippedReasons.push(`${c.path}（无法读取）`)
          continue
        }
        size = stat.size
        mime = stat.mime || 'application/octet-stream'
      }
      // Drops are always path-based (both tiers addAttachment with a path) →
      // streamed off disk by main, so the large 2GB cap applies.
      if (size > MAX_PATH_ATTACHMENT_BYTES) {
        skippedReasons.push(`${c.path}（超过单文件 2GB）`)
        continue
      }
      if (totalBytes + size > MAX_TOTAL_ATTACHMENT_BYTES) {
        skippedReasons.push(`${c.path}（超过总量 4GB）`)
        continue
      }
      const name = c.path.split(/[\\/]/).pop() ?? c.path
      addAttachment({ name, mime, size, path: c.path })
      // Tier 2 (internal MIME, no preStat) pushes a pending reference — the
      // file came from the workspace or ATTACHMENTS tree, and the send-side
      // gate (mapReferencesToInputItems) whitelists workspace roots plus the
      // `<userData>/agent/uploads` cache, mirroring the fs IPC gate
      // (fsIpc.resolveAllowedRoots). Tier 3 (external OS drop, preStat set)
      // must NOT push a reference: the original OS path is by design outside
      // both gates' whitelists, and `agent:send-message` would throw
      // "Reference path is outside allowed roots" at click-Send. The matching
      // attachment still gets ingested by AttachmentService into
      // `<userData>/agent/uploads/<hash>.ext` (an in-root canonical path),
      // mirroring the onFileChange file-picker flow at lines 730-754 which
      // already attaches-without-referencing for the exact same reason.
      if (!c.preStat) {
        addPendingReference(makeFileReference({ path: c.path, name, mime }))
      }
      totalBytes += size
      remainingSlots -= 1
    }

    if (skippedReasons.length > 0) {
      setError(`已跳过 ${skippedReasons.length} 个：${skippedReasons.join('；')}`)
    } else {
      setError(undefined)
    }
  }

  // Edit mode swaps the submit action: instead of starting a new turn at
  // the bottom of the conversation, `submitEditMessage` truncates messages
  // up to the one being edited and sends the current draft as a fresh turn.
  // This is what makes the inline composer feel identical to the bottom one.
  const isEditing = Boolean(editingMessageId)
  // While a turn is running, Enter/Send "插话" (append to the in-flight turn via
  // Codex turn/steer) instead of starting a new turn. Editing still saves.
  const submitAction = isEditing ? submitEditMessage : isRunning ? steer : send

  // Native `/goal` intercept (codex-tui parity): parse the composer BEFORE it
  // is sent to the model. `/goal <objective>` sets a persistent goal, `/goal`
  // views it, `/goal pause|resume|clear` manages the lifecycle. Returns true
  // when the input was a goal command (already handled — do NOT send/steer).
  function tryHandleGoalCommand(): boolean {
    if (isEditing) return false
    const command = parseGoalCommand(input)
    if (!command) return false
    // `edit` is special: keep the composer populated with the current objective
    // for revision instead of clearing it.
    if (command.kind !== 'edit') setInput('')
    switch (command.kind) {
      case 'view':
        void refreshGoal().then(() => {
          const st = useAgentChatStore.getState()
          const goal = st.threadId ? st.goalByThread[st.threadId] : null
          pushNotice({
            id: `goal-view:${Date.now()}`,
            kind: 'configWarning',
            level: 'info',
            message: goal
              ? `目标[${goal.status}]:${goal.objective}`
              : '当前会话没有设定目标。用 “/goal 你的目标” 设一个长期目标(Codex 会持续推进)。',
          })
        })
        break
      case 'pause':
        void setGoalStatus('paused')
        break
      case 'resume':
        void setGoalStatus('active')
        break
      case 'clear':
        void clearGoal()
        break
      case 'edit': {
        // Prefill the composer with the current objective (as a /goal command)
        // so the user can tweak it and re-submit to replace the goal.
        const st = useAgentChatStore.getState()
        const goal = st.threadId ? st.goalByThread[st.threadId] : null
        if (goal?.objective) {
          setInput(`/goal ${goal.objective}`)
        } else {
          setInput('')
          void refreshGoal().then(() => {
            pushNotice({
              id: `goal-edit-none:${Date.now()}`,
              kind: 'configWarning',
              level: 'info',
              message: '当前会话还没有目标可编辑。用 “/goal 你的目标” 先设一个。',
            })
          })
        }
        break
      }
      case 'budget':
        void setGoalBudget(command.tokenBudget)
        break
      case 'set':
        void setGoal(command.objective)
        break
      default: {
        // Exhaustiveness guard — new GoalCommand kinds must be handled here.
        const _exhaustive: never = command
        return _exhaustive
      }
    }
    return true
  }

  // Native `/pets` intercept: typed-out `/pets` (or `/pet`) + Enter opens the
  // picker instead of being sent to the model as chat text — the exact failure
  // mode reported against the official app (openai/codex#20836).
  function tryHandlePetsCommand(): boolean {
    if (isEditing) return false
    if (!/^\/pets?$/i.test(input.trim())) return false
    setInput('')
    usePetStore.getState().openPicker()
    return true
  }

  function runSubmit(): void {
    if (tryHandlePetsCommand()) return
    if (tryHandleGoalCommand()) return
    void submitAction()
  }

  return (
    <form
      onDragOver={(event) => {
        // preventDefault 保持无条件:它是「这里可以放」的开关,收窄它会连带
        // 掐掉浏览器原生的选中文本拖入 textarea。高亮才按 MIME 收窄。
        event.preventDefault()
        // 卡片走单独的判据:那个 MIME 只有这里接得住(详见 dragCarriesWorkbenchCards)。
        // 少了它,拖一张卡过来毫无反应,松手才知道成没成 —— 未出片的卡尤其像拖失败了。
        if (
          !dragCarriesDroppablePayload(event.dataTransfer) &&
          !dragCarriesWorkbenchCards(event.dataTransfer)
        ) {
          return
        }
        // 组合器只会复制(附件/引用),从不移动源文件 —— 说清楚光标才对。
        event.dataTransfer.dropEffect = 'copy'
        if (!dropActive) setDropActive(true)
      }}
      onDragLeave={(event) => {
        // dragleave 会在每次跨越子元素时触发,只在真正离开整个组合器时收起
        // (FileTreeNode.onDragLeave 同款)。
        const related = event.relatedTarget as Node | null
        if (related && event.currentTarget.contains(related)) return
        if (dropActive) setDropActive(false)
      }}
      onDrop={(event) => void onDrop(event)}
      onSubmit={(event) => {
        event.preventDefault()
        runSubmit()
      }}
    >
      {pendingReferences.length > 0 ? (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {pendingReferences.map((reference) => (
            // No inline thumbnail in the composer — dropping N×10MB images used
            // to mount N×MediaThumbnail, each firing a media:thumb IPC + base64
            // round-trip that froze the renderer. The chip label + click handler
            // gives the user enough feedback ("file is attached, click to preview")
            // without any image decoding on the composer path. Click still opens
            // the file (Lightbox for images/videos) via openReference.
            <ReferenceChip
              key={reference.id}
              reference={reference}
              onOpen={(ref) => void openReference(ref)}
              onRemove={() => {
                removePendingReference(reference.id)
                removeAttachmentForReference(reference)
              }}
            />
          ))}
        </div>
      ) : null}
      <div className="relative">
        <textarea
          ref={textareaRef}
          rows={2}
          style={{
            minHeight: TEXTAREA_MIN_HEIGHT,
            maxHeight: TEXTAREA_MAX_HEIGHT,
            lineHeight: `${TEXTAREA_LINE_HEIGHT}px`,
          }}
          // 投放高亮只换边框色(发丝线,不加投影)。同属性的两个 border-* 不能
          // 并存 —— Tailwind 的胜负由生成样式表的顺序决定,不是这里的书写顺序。
          className={`w-full resize-none rounded-lg border ${
            dropActive ? 'border-cyan-300/80' : 'border-cyan-400/20'
          } bg-black/40 px-3 py-2 text-[13px] text-cyan-50 outline-none placeholder:text-zinc-500 focus:border-cyan-300/50`}
          onChange={(event) => {
            setInput(event.target.value)
            // Defer until React commits the new value so `selectionStart`
            // reads the post-change caret instead of a stale one.
            requestAnimationFrame(refreshTriggerPopups)
          }}
          onPaste={(event) => void onPaste(event)}
          onKeyUp={refreshTriggerPopups}
          onClick={refreshTriggerPopups}
          onBlur={() => {
            // 100ms grace lets a click on a popup row register before the
            // popup unmounts. Without this, mousedown on a row blurs the
            // textarea, popup unmounts, click never fires.
            setTimeout(() => {
              setSkillPopup(null)
              setFilePopup(null)
              setSlashPopup(null)
            }, 100)
          }}
          onKeyDown={(event) => {
            // Slash palette keyboard handling first — most explicit trigger,
            // takes precedence over `$` and `@` if all somehow co-existed.
            if (slashPopup && flatPaletteItems.length > 0) {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setSlashHighlight((h) => Math.min(h + 1, flatPaletteItems.length - 1))
                return
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault()
                setSlashHighlight((h) => Math.max(h - 1, 0))
                return
              }
              if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault()
                commitPaletteItem(flatPaletteItems[slashHighlight])
                return
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                setSlashPopup(null)
                return
              }
            }
            if (skillPopup && filteredSkills.length > 0) {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setSkillHighlight((h) => Math.min(h + 1, filteredSkills.length - 1))
                return
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault()
                setSkillHighlight((h) => Math.max(h - 1, 0))
                return
              }
              if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault()
                commitSkill(filteredSkills[skillHighlight])
                return
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                setSkillPopup(null)
                return
              }
            }
            if (filePopup && atPopupItemCount > 0) {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setFileHighlight((h) => Math.min(h + 1, atPopupItemCount - 1))
                return
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault()
                setFileHighlight((h) => Math.max(h - 1, 0))
                return
              }
              if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault()
                commitAtPopupIndex(fileHighlight)
                return
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                setFilePopup(null)
                return
              }
            }
            // Enter sends; Shift+Enter inserts a newline. Cmd/Ctrl+Enter still
            // sends (muscle memory). Skip while an IME candidate window is open
            // (isComposing) so committing Chinese/Japanese input never fires a
            // send. Popups above already consumed+returned on Enter.
            if (
              event.key === 'Enter' &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault()
              runSubmit()
            }
            // Esc bails out of edit mode without sending. Only fires when
            // no popup is open (popups consume Esc above).
            if (event.key === 'Escape' && isEditing && !slashPopup && !skillPopup && !filePopup) {
              event.preventDefault()
              cancelEditMessage()
            }
          }}
          placeholder={
            isEditing
              ? 'Edit your message — Enter to save & submit, Esc to cancel'
              : isRunning
                ? '运行中… 输入可插话(steer)追加到当前回合,↵ 发送 · ⇧↵ 换行 · Stop 取消'
                : 'Ask Codex to generate, inspect, batch, or edit…   / command · $ skill · @ file · Ctrl+V image · ↵ send · ⇧↵ newline'
          }
          value={input}
        />
        {slashPopup && flatPaletteItems.length > 0 ? (
          <ul
            role="listbox"
            aria-label="Slash command palette"
            className="absolute bottom-full left-0 z-10 mb-1.5 max-h-80 w-full overflow-auto rounded-lg border border-cyan-400/25 bg-zinc-950/95 p-1.5 shadow-2xl shadow-black/60 backdrop-blur-md ring-1 ring-cyan-400/10"
          >
            {(() => {
              // Compute a running flat index so each row knows its position
              // in the keyboard navigation order across section boundaries.
              let running = 0
              return paletteSections.map((section) => {
                const sectionStart = running
                running += section.items.length
                return (
                  <li key={section.id} className="mb-1.5 last:mb-0">
                    <div className="flex items-center justify-between px-2 pb-1 pt-1.5">
                      <span className="text-[9px] font-semibold uppercase tracking-[0.24em] text-zinc-500">
                        {section.label}
                      </span>
                      <span className="text-[9px] font-mono text-zinc-600">
                        {section.items.length}
                      </span>
                    </div>
                    <ul role="group" aria-label={section.label} className="space-y-px">
                      {section.items.map((item, localIdx) => {
                        const flatIdx = sectionStart + localIdx
                        const isActive = flatIdx === slashHighlight
                        const primary =
                          item.kind === 'command' ? item.command.label : item.skill.name
                        const description =
                          item.kind === 'command'
                            ? item.command.description
                            : item.skill.description
                        const matchIndices = highlightMatchIndices(slashPopup.query, primary)
                        return (
                          <li
                            key={
                              item.kind === 'command'
                                ? `cmd:${item.command.id}`
                                : `skill:${item.skill.path}`
                            }
                            role="option"
                            aria-selected={isActive}
                            onMouseDown={(event) => {
                              event.preventDefault()
                              commitPaletteItem(item)
                            }}
                            onMouseEnter={() => setSlashHighlight(flatIdx)}
                            className={
                              'flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 transition-all duration-150 ' +
                              (isActive
                                ? 'bg-cyan-400/15 text-cyan-50 shadow-inner shadow-cyan-400/5 ring-1 ring-cyan-400/30'
                                : 'text-zinc-200 hover:bg-cyan-400/8 hover:ring-1 hover:ring-cyan-400/15')
                            }
                          >
                            <span
                              className={
                                'flex h-6 w-6 shrink-0 items-center justify-center rounded ' +
                                (isActive ? 'bg-cyan-400/15' : 'bg-zinc-900/60')
                              }
                            >
                              {item.kind === 'command' ? <SlashGlyph /> : <SkillGlyph />}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-baseline gap-1.5">
                                <HighlightedText
                                  text={primary}
                                  matchIndices={matchIndices}
                                  className="truncate font-mono text-[12px] text-cyan-200"
                                />
                                {item.kind === 'skill' ? (
                                  <ScopeChip scope={item.skill.scope} />
                                ) : null}
                              </div>
                              <div
                                className="mt-0.5 truncate text-[11px] text-zinc-400"
                                title={description}
                              >
                                {description || (
                                  <span className="text-zinc-600">no description</span>
                                )}
                              </div>
                            </div>
                            {isActive ? (
                              <span className="ml-1 hidden shrink-0 items-center gap-1 rounded border border-cyan-400/30 bg-cyan-400/10 px-1.5 py-[1px] text-[9px] font-mono uppercase tracking-wider text-cyan-200 sm:inline-flex">
                                ↵ Enter
                              </span>
                            ) : null}
                          </li>
                        )
                      })}
                    </ul>
                  </li>
                )
              })
            })()}
          </ul>
        ) : null}
        {skillPopup && filteredSkills.length > 0 ? (
          <ul
            role="listbox"
            aria-label="Skill suggestions"
            className="absolute bottom-full left-0 z-10 mb-1 max-h-64 w-full overflow-auto rounded-md border border-cyan-400/20 bg-zinc-950/95 p-1 shadow-lg shadow-black/40 backdrop-blur"
          >
            {filteredSkills.map((skill, idx) => (
              <li
                key={skill.path}
                role="option"
                aria-selected={idx === skillHighlight}
                onMouseDown={(event) => {
                  // mousedown (not click) so we commit BEFORE the textarea
                  // blurs and unmounts us.
                  event.preventDefault()
                  commitSkill(skill)
                }}
                onMouseEnter={() => setSkillHighlight(idx)}
                className={
                  'cursor-pointer rounded px-2 py-1 ' +
                  (idx === skillHighlight ? 'bg-cyan-400/20 text-cyan-50' : 'text-zinc-200')
                }
              >
                <div className="flex items-baseline gap-1.5">
                  <span className="font-mono text-[12px] text-cyan-200">${skill.name}</span>
                  <span className="text-[10px] uppercase tracking-[0.16em] text-zinc-500">
                    {skill.scope}
                  </span>
                </div>
                {skill.description ? (
                  <div className="mt-0.5 truncate text-[11px] text-zinc-400">{skill.description}</div>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {filePopup && atPopupItemCount > 0 ? (
          <ul
            role="listbox"
            aria-label="Mention suggestions"
            className="absolute bottom-full left-0 z-10 mb-1 max-h-64 w-full overflow-auto rounded-md border border-cyan-400/20 bg-zinc-950/95 p-1 shadow-lg shadow-black/40 backdrop-blur"
          >
            {filteredPlugins.map((plugin, idx) => (
              <li
                key={plugin.path}
                role="option"
                aria-selected={idx === fileHighlight}
                onMouseDown={(event) => {
                  // mousedown (not click) so we commit BEFORE the textarea
                  // blurs and unmounts us.
                  event.preventDefault()
                  commitPluginMention(plugin)
                }}
                onMouseEnter={() => setFileHighlight(idx)}
                className={
                  'cursor-pointer rounded px-2 py-1 ' +
                  (idx === fileHighlight ? 'bg-cyan-400/20 text-cyan-50' : 'text-zinc-200')
                }
              >
                <div className="flex items-baseline gap-1.5">
                  <span className="font-mono text-[12px] text-cyan-200">@{plugin.token}</span>
                  <span className="text-[10px] uppercase tracking-[0.16em] text-zinc-500">plugin</span>
                </div>
                <div className="mt-0.5 truncate text-[11px] text-zinc-400" title={plugin.path}>
                  {plugin.name}
                </div>
              </li>
            ))}
            {filteredAtSkills.map((skill, idx) => {
              const flatIdx = filteredPlugins.length + idx
              return (
                <li
                  key={skill.path}
                  role="option"
                  aria-selected={flatIdx === fileHighlight}
                  onMouseDown={(event) => {
                    // mousedown (not click) so we commit BEFORE the textarea
                    // blurs and unmounts us.
                    event.preventDefault()
                    commitSkillFromAtPopup(skill)
                  }}
                  onMouseEnter={() => setFileHighlight(flatIdx)}
                  className={
                    'cursor-pointer rounded px-2 py-1 ' +
                    (flatIdx === fileHighlight ? 'bg-cyan-400/20 text-cyan-50' : 'text-zinc-200')
                  }
                >
                  <div className="flex items-baseline gap-1.5">
                    <span className="font-mono text-[12px] text-cyan-200">${skill.name}</span>
                    <span className="text-[10px] uppercase tracking-[0.16em] text-zinc-500">skill</span>
                  </div>
                  {skill.description ? (
                    <div className="mt-0.5 truncate text-[11px] text-zinc-400">{skill.description}</div>
                  ) : null}
                </li>
              )
            })}
            {filteredFiles.map((file, idx) => {
              const flatIdx = filteredPlugins.length + filteredAtSkills.length + idx
              return (
                <li
                  key={file.path}
                  role="option"
                  aria-selected={flatIdx === fileHighlight}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    commitFile(file)
                  }}
                  onMouseEnter={() => setFileHighlight(flatIdx)}
                  className={
                    'cursor-pointer rounded px-2 py-1 ' +
                    (flatIdx === fileHighlight ? 'bg-cyan-400/20 text-cyan-50' : 'text-zinc-200')
                  }
                >
                  <div className="flex items-baseline gap-1.5">
                    <span className="font-mono text-[12px] text-cyan-200">{file.name}</span>
                  </div>
                  {file.relPath !== file.name ? (
                    <div className="mt-0.5 truncate text-[11px] text-zinc-400" title={file.relPath}>
                      {file.relPath}
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>
        ) : null}
      </div>
      <label
        className={
          'mt-1.5 flex cursor-pointer items-center justify-between rounded-lg border border-dashed px-2.5 py-1.5 text-[11px] transition-colors duration-200 ' +
          (attachments.length > 0
            ? 'border-cyan-400/40 bg-cyan-400/5 text-cyan-100 hover:bg-cyan-400/10'
            : 'border-cyan-400/20 text-cyan-100/75 hover:border-cyan-400/40 hover:bg-cyan-400/10 hover:text-cyan-100')
        }
      >
        <span className="flex items-center gap-1.5">
          <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
            <path d="M9.5 4.5v5a2.5 2.5 0 1 1-5 0V4a1.5 1.5 0 0 1 3 0v5a.5.5 0 0 1-1 0V4.5" />
          </svg>
          Add references or files
        </span>
        <span className="font-mono text-[10px] tabular-nums text-zinc-500">
          {attachments.length}/{MAX_ATTACHMENTS}
        </span>
        <input
          className="hidden"
          disabled={attachments.length >= MAX_ATTACHMENTS}
          multiple
          onChange={(event) => void onFileChange(event)}
          type="file"
        />
      </label>
      <div className="mt-1.5 flex items-center gap-1.5">
        <span
          className={
            'inline-flex items-center gap-1 rounded border bg-zinc-900/70 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.18em] transition-colors duration-200 ' +
            (isRunning
              ? 'border-cyan-300/60 text-cyan-200'
              : isEditing
                ? 'border-amber-400/40 text-amber-200'
                : 'border-zinc-700/80 text-cyan-300/80')
          }
        >
          {isRunning ? (
            <span
              className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-300"
              aria-hidden="true"
            />
          ) : null}
          {isEditing ? 'Editing' : isRunning ? 'Running' : 'Agent'}
        </span>
        <ModelPicker disabled={isRunning} />
        <CollabModeControl disabled={isRunning || modelSelectionPending} />
        <ImageChannelPicker disabled={isRunning || modelSelectionPending} />
        <PetPickerButton />
        <div className="flex-1" />
        {isEditing ? (
          <button
            className="rounded-lg border border-zinc-700/80 px-2.5 py-1.5 text-[12px] text-zinc-300 hover:border-zinc-500 hover:text-zinc-100"
            onClick={() => cancelEditMessage()}
            type="button"
          >
            Cancel
          </button>
        ) : null}
        <button
          className="rounded-lg bg-cyan-300 px-3 py-1.5 text-[12px] font-semibold text-zinc-950 transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
          disabled={
            modelSelectionPending
            || (input.trim().length === 0 && attachments.length === 0)
          }
          title={
            modelSelectionPending
              ? '正在切换模型通道…'
              : isRunning && !isEditing
                ? '插话:把这条追加到当前运行的回合(turn/steer)'
                : undefined
          }
          type="submit"
        >
          {isEditing ? 'Save & Submit' : isRunning ? 'Steer' : 'Send'}
        </button>
        {isRunning && !isEditing ? (
          <button
            className="rounded-lg border border-red-400/30 px-2.5 py-1.5 text-[12px] text-red-200 hover:bg-red-500/10"
            onClick={() => void cancel()}
            type="button"
          >
            Stop
          </button>
        ) : null}
      </div>
    </form>
  )
}
