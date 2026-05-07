export const DEFAULT_LISTEN_URL = 'ws://127.0.0.1:7345'

export interface CodexLaunchOptions {
  listenUrl?: string
}

export function buildCodexLaunchArgs(options?: CodexLaunchOptions): string[] {
  const url = options?.listenUrl ?? DEFAULT_LISTEN_URL
  return [
    'app-server',
    '--listen', url,
    '-c', 'approval_policy="never"',
    '-c', 'sandbox_mode="danger-full-access"',
  ]
}
