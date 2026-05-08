import type { AgentReference } from '../../../../types/agent-reference'
import { validateExternalUrl } from './urlValidation'

const SAFE_SANDBOX = 'allow-popups allow-scripts'

type ShellBridge = { openExternal?: (url: string) => Promise<unknown> }

function openExternal(url: string): void {
  const validated = validateExternalUrl(url)
  if (!validated.ok) return
  const bridge = (window as Window & { electronAPI?: { shell?: ShellBridge } }).electronAPI?.shell
  void bridge?.openExternal?.(validated.url)
}

export function UrlPreview({ reference }: { reference: AgentReference }) {
  const rawUrl = reference.source.kind === 'url' ? reference.source.url : ''
  const validated = validateExternalUrl(rawUrl)

  if (!validated.ok) {
    return (
      <div className="flex h-full flex-col bg-zinc-950 p-4 text-xs text-zinc-200">
        <p className="font-medium text-amber-200">Embedded preview blocked</p>
        <p className="mt-1 opacity-70">
          The URL <code className="break-all text-amber-100">{rawUrl}</code> uses a scheme that is not allowed inside
          the workspace iframe.
        </p>
      </div>
    )
  }

  if (!validated.embeddable) {
    return (
      <div className="flex h-full flex-col bg-zinc-950 p-4 text-xs text-zinc-200">
        <p className="font-medium text-amber-200">HTTP preview not embedded</p>
        <p className="mt-1 opacity-70">
          The URL <code className="break-all text-amber-100">{validated.url}</code> uses plain <code>http</code>.
          Open it in your browser instead.
        </p>
        <button
          type="button"
          className="mt-3 self-start rounded border border-zinc-700 px-2 py-1 text-[11px] hover:border-cyan-400/50"
          onClick={() => openExternal(validated.url)}
        >
          Open external
        </button>
      </div>
    )
  }

  const url = validated.url

  return (
    <div className="flex h-full flex-col bg-zinc-950">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2 text-xs text-zinc-300">
        <span className="truncate">{url}</span>
        <button
          type="button"
          className="ml-auto rounded border border-zinc-700 px-2 py-1 text-[11px] hover:border-cyan-400/50"
          onClick={() => openExternal(url)}
        >
          Open external
        </button>
      </div>
      <iframe
        title={reference.label}
        src={url}
        sandbox={SAFE_SANDBOX}
        referrerPolicy="no-referrer"
        className="h-full w-full border-0"
      />
    </div>
  )
}
