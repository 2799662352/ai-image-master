// src/renderer/src/features/voice/asr/endpointing.ts
/**
 * 持续收听时「这句说完了没」的判定:服务端 VAD 只看静音,停顿几百毫秒就断句;
 * 提交前再按话尾内容多等一会儿(思路同 OpenAI semantic_vad:话尾像没说完就等久一点)。
 */

/** semantic_vad 最耐心(eagerness=low)也只等 8 秒,再长就像卡住了。 */
export const MAX_COMMIT_DELAY_MS = 8000

/** 以这些结尾多半还没说完:停顿类标点。 */
const TRAILING_PUNCTUATION = /[，、,;；:：…—~～-]$/
/** 去掉句末标点后以这些结尾:语气词、连接词(识别引擎常给犹豫处也补上句号)。 */
const TRAILING_WORD =
  /(?:嗯+|呃+|额+|唔+|那个|这个|就是|然后|还有|所以|但是|而且|因为|如果|或者|比如|(?:^|[^A-Za-z])(?:um+|uh+|and|but|so|or|because|like))$/i

export function soundsUnfinished(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  if (TRAILING_PUNCTUATION.test(trimmed)) return true
  return TRAILING_WORD.test(trimmed.replace(/[。.!！?？]+$/, ''))
}

/** `baseMs` 是用户选的停顿时长;话尾像没说完就翻倍,封顶 8 秒。 */
export function commitDelayFor(text: string, baseMs: number): number {
  if (baseMs <= 0) return 0
  return soundsUnfinished(text) ? Math.min(baseMs * 2, MAX_COMMIT_DELAY_MS) : baseMs
}
