import type { Extension } from '@codemirror/state'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { yaml } from '@codemirror/lang-yaml'

export function pathToLangShort(p: string): string {
  const ext = p.toLowerCase().split('.').pop() ?? ''
  const map: Record<string, string> = {
    js: 'js',
    jsx: 'jsx',
    ts: 'ts',
    tsx: 'tsx',
    json: 'json',
    html: 'html',
    css: 'css',
    md: 'md',
    py: 'py',
    yaml: 'yaml',
    yml: 'yaml',
    sh: 'sh',
  }
  return map[ext] ?? 'text'
}

export async function buildLangExtension(p: string): Promise<Extension | null> {
  const ext = p.toLowerCase().split('.').pop() ?? ''
  switch (ext) {
    case 'ts':
    case 'tsx':
      return javascript({ typescript: true, jsx: ext === 'tsx' })
    case 'js':
    case 'jsx':
      return javascript({ jsx: ext === 'jsx' })
    case 'json':
      return json()
    case 'html':
      return html()
    case 'css':
      return css()
    case 'md':
      return markdown()
    case 'py':
      return python()
    case 'yaml':
    case 'yml':
      return yaml()
    default:
      return null
  }
}
