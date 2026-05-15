import { pathToLangShort } from './lang'

export type SelectionForChat = {
  path: string
  fromLine: number
  toLine: number
  text: string
}

export function formatSelectionForChat(selection: SelectionForChat): string {
  const lang = pathToLangShort(selection.path)
  return `\`\`\`${lang}\n${selection.text}\n\`\`\``
}
