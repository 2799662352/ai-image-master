/**
 * Repairs the token usage `@codeproxy/core` reports on the Anthropic Messages
 * bridge, which is wrong in two independent ways on a streamed turn.
 *
 * 1. It takes input and both cache counters from the `message_start` frame and
 *    its `message_delta` handler reads only `output_tokens` (0.1.22,
 *    `onMessageDelta`). On a gateway that sends a placeholder `message_start`
 *    and settles the real numbers at the end, every cache token is lost.
 *    Measured on apiyi with a cached ~3.7k-token prefix: `message_start` said
 *    `input_tokens: 2441` with both cache counters zero, while `message_delta`
 *    said `input_tokens: 12, cache_read_input_tokens: 3743`.
 * 2. It maps Anthropic's `input_tokens` straight onto the Responses
 *    `input_tokens`, but the two mean different things. Anthropic excludes
 *    anything read from or written to the cache; Responses counts the whole
 *    prompt and treats `input_tokens_details.cached_tokens` as a subset of it.
 *    Passing the exclusive number through understates the prompt by exactly the
 *    cached amount — and our own meter then computes
 *    `conversation = input - cached`, so it can even go negative.
 *
 * Both matter beyond cosmetics: the same usage block feeds the context-window
 * donut and the cross-card cost aggregation, so an understated prompt reads as
 * spare context that isn't there, and caching looks like it never engaged.
 *
 * Only the streaming path is repaired. Codex always asks for `stream: true` on
 * Responses, and the library's non-streaming mapper already reads the cache
 * counters (it still keeps input exclusive, which is bug 2 — unreachable here).
 *
 * Fixed by observation rather than a patched dependency: the inspector sits in
 * the upstream body as a byte-transparent pass-through, so by the time the
 * library has parsed a frame we have already seen it. That ordering is why this
 * is a pass-through and not a `tee()` — a second branch would race the
 * library's own reader for who reaches `message_delta` first.
 */

/** The Anthropic usage counters, merged across the frames that carry them. */
export type AnthropicUsageFields = Partial<Record<
  'input_tokens' | 'output_tokens' | 'cache_read_input_tokens' | 'cache_creation_input_tokens',
  number
>>

export interface AnthropicUsageSink {
  observed: AnthropicUsageFields
}

export interface ResponsesUsage {
  input_tokens: number
  output_tokens: number
  total_tokens: number
  input_tokens_details: {
    cached_tokens?: number
    cache_creation_tokens?: number
  }
}

const USAGE_FIELDS = [
  'input_tokens',
  'output_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
] as const

export function createAnthropicUsageSink(): AnthropicUsageSink {
  return { observed: {} }
}

/**
 * Converts merged Anthropic counters into a Responses usage block, or
 * `undefined` when no counter was ever seen.
 *
 * The `undefined` case is load-bearing: an unobserved turn must keep whatever
 * the library reported, because overwriting it with zeros would turn a wrong
 * number into a missing one.
 */
export function resolveResponsesUsage(
  observed: AnthropicUsageFields,
): ResponsesUsage | undefined {
  if (!USAGE_FIELDS.some((field) => typeof observed[field] === 'number')) {
    return undefined
  }
  const cacheRead = observed.cache_read_input_tokens
  const cacheWrite = observed.cache_creation_input_tokens
  const inputTokens = (observed.input_tokens ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
  const outputTokens = observed.output_tokens ?? 0
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    input_tokens_details: {
      // Reported only when the upstream reported them, so a gateway that omits
      // a counter stays distinguishable from one that reports zero.
      ...(cacheRead === undefined ? {} : { cached_tokens: cacheRead }),
      ...(cacheWrite === undefined ? {} : { cache_creation_tokens: cacheWrite }),
    },
  }
}

/**
 * Splits a decoded SSE text buffer into whole lines, returning the trailing
 * partial line for the next chunk.
 */
function takeLines(buffered: string): { lines: string[], rest: string } {
  const lines = buffered.split('\n')
  return { lines, rest: lines.pop() ?? '' }
}

function parseDataLine(line: string): Record<string, unknown> | undefined {
  if (!line.startsWith('data:')) return undefined
  const payload = line.slice(5).trim()
  if (!payload || payload === '[DONE]') return undefined
  try {
    const parsed = JSON.parse(payload) as unknown
    return typeof parsed === 'object' && parsed !== null
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    // A frame we cannot parse is a frame we do not act on; the bytes still go
    // through untouched because forwarding never depends on parsing.
    return undefined
  }
}

function mergeUsage(sink: AnthropicUsageSink, usage: unknown): void {
  if (typeof usage !== 'object' || usage === null) return
  const source = usage as Record<string, unknown>
  for (const field of USAGE_FIELDS) {
    const value = source[field]
    if (typeof value === 'number' && Number.isFinite(value)) {
      sink.observed[field] = value
    }
  }
}

function recordFrame(sink: AnthropicUsageSink, line: string): void {
  const frame = parseDataLine(line)
  if (!frame) return
  if (frame.type === 'message_start') {
    const message = frame.message
    if (typeof message === 'object' && message !== null) {
      mergeUsage(sink, (message as Record<string, unknown>).usage)
    }
    return
  }
  // `message_delta` last, so its settled counters win over the opening
  // placeholder — while fields it omits keep the `message_start` value, which is
  // where Anthropic-direct puts the authoritative input and cache numbers.
  if (frame.type === 'message_delta') mergeUsage(sink, frame.usage)
}

/**
 * Passes the upstream Anthropic stream through unchanged while recording the
 * usage counters it carries.
 *
 * Chunks are forwarded exactly as received and decoded only on the side, so a
 * multi-byte character split across a chunk boundary cannot be corrupted by
 * this pass.
 */
export function observeAnthropicUsage(
  body: ReadableStream<Uint8Array>,
  sink: AnthropicUsageSink,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  let buffered = ''
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk)
      buffered += decoder.decode(chunk, { stream: true })
      const { lines, rest } = takeLines(buffered)
      buffered = rest
      for (const line of lines) recordFrame(sink, line)
    },
    flush() {
      if (buffered) recordFrame(sink, buffered)
    },
  }))
}

/**
 * Rewrites the usage block on the translated `response.completed` event, the
 * only frame the library attaches usage to.
 *
 * Lines other than that one are re-emitted verbatim, so event framing (blank
 * separator lines, `event:` headers) survives untouched.
 */
export function repairResponsesUsage(
  body: ReadableStream<Uint8Array>,
  sink: AnthropicUsageSink,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffered = ''

  const rewrite = (line: string): string => {
    const frame = parseDataLine(line)
    if (!frame || frame.type !== 'response.completed') return line
    const response = frame.response
    if (typeof response !== 'object' || response === null) return line
    const usage = resolveResponsesUsage(sink.observed)
    if (!usage) return line
    return `data: ${JSON.stringify({
      ...frame,
      response: { ...response as Record<string, unknown>, usage },
    })}`
  }

  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffered += decoder.decode(chunk, { stream: true })
      const { lines, rest } = takeLines(buffered)
      buffered = rest
      if (lines.length > 0) {
        controller.enqueue(encoder.encode(`${lines.map(rewrite).join('\n')}\n`))
      }
    },
    flush(controller) {
      if (buffered) controller.enqueue(encoder.encode(rewrite(buffered)))
    },
  }))
}
