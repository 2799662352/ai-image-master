// src/renderer/src/features/voice/tts/speechText.ts
/**
 * 朗读前的文本处理。分句与去括号照搬 Shinsekai
 * (`tts_generation.py::_sentences`、`text_processor.py::remove_parentheses`);
 * 我们的回复是 markdown,所以先转成可读的纯文本,再按上限截到句子边界。
 */

const SENTENCE_BOUNDARY = /(?<=[。！？，、；：.!?,;:])/

/** 按标点切开,再把相邻短句合并到不超过 maxLength 个字。 */
export function splitSentences(text: string, maxLength: number): string[] {
  const pieces = text
    .split(SENTENCE_BOUNDARY)
    .map((piece) => piece.trim())
    .filter(Boolean)
  const sentences: string[] = []
  let current = ''
  for (const piece of pieces) {
    if (!current) {
      current = piece
    } else if (current.length + piece.length <= maxLength) {
      current += piece
    } else {
      sentences.push(current)
      current = piece
    }
  }
  if (current) sentences.push(current)
  return sentences
}

/** 去掉括号里的旁白与 `*动作*`。 */
export function removeParentheses(text: string): string {
  return text
    .replace(/\([^()]*\)/g, '')
    .replace(/（[^()]*）/g, '')
    .replace(/\*.*?\*/gs, '')
    .trim()
}

/** markdown → 念得出来的纯文本:代码、链接地址、表格线、标记符号都不念。 */
export function markdownToSpeech(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/`([^`\n]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^\s*\|?\s*:?-{3,}.*$/gm, ' ')
    .replace(/\|/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 超过上限时截到上限内最后一个句子边界;一个边界都没有就硬截。 */
export function truncateForSpeech(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const head = text.slice(0, maxChars)
  const boundary = Math.max(...[...'。！？.!?；;'].map((mark) => head.lastIndexOf(mark)))
  return boundary > 0 ? head.slice(0, boundary + 1) : head
}

export function speechTextFromReply(reply: string, maxChars: number): string {
  return truncateForSpeech(removeParentheses(markdownToSpeech(reply)), maxChars)
}
