import type { AgentReference } from '../../../../types/agent-reference'

const ANSI_REGEX = /\u001b\[[0-9;]*m/g

function stripAnsi(input: string | undefined): string {
  if (!input) return ''
  return input.replace(ANSI_REGEX, '')
}

export function ShellOutputPreview({ reference }: { reference: AgentReference }) {
  const preview = reference.preview
  const stdout = stripAnsi(preview?.stdout)
  const stderr = stripAnsi(preview?.stderr)

  return (
    <div className="h-full overflow-auto bg-zinc-950 p-3 text-xs text-zinc-200">
      <div className="mb-3 rounded-lg border border-zinc-800 bg-zinc-900/70 p-3">
        <div className="text-[10px] uppercase tracking-[0.18em] text-cyan-300/80">Command</div>
        <code className="mt-1 block break-all text-cyan-50">{preview?.command ?? reference.label}</code>
        {preview?.cwd ? <div className="mt-2 text-zinc-500">cwd: {preview.cwd}</div> : null}
        {preview?.exitCode != null ? <div className="mt-1 text-zinc-500">exit: {preview.exitCode}</div> : null}
      </div>
      {stdout ? <pre className="whitespace-pre-wrap text-zinc-200">{stdout}</pre> : null}
      {stderr ? <pre className="mt-3 whitespace-pre-wrap text-red-300/90">{stderr}</pre> : null}
      {!stdout && !stderr ? <p className="italic text-zinc-600">No output</p> : null}
    </div>
  )
}
