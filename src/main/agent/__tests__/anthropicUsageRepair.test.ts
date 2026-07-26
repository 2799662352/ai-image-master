import { describe, expect, it } from 'vitest'

import {
  createAnthropicUsageSink,
  observeAnthropicUsage,
  repairResponsesUsage,
  resolveResponsesUsage,
} from '../anthropicUsageRepair'

function streamOf(...chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk)
      }
      controller.close()
    },
  })
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const parts: Uint8Array[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
  }
  return Buffer.concat(parts.map((part) => Buffer.from(part))).toString('utf8')
}

/** One `data:`-framed Anthropic SSE event, as the gateways emit them. */
function frame(payload: unknown): string {
  return `event: ${(payload as { type: string }).type}\ndata: ${JSON.stringify(payload)}\n\n`
}

describe('resolveResponsesUsage', () => {
  it('sums Anthropic input against both cache counters', () => {
    // Anthropic's `input_tokens` excludes anything read from or written to the
    // cache, while Responses `input_tokens` is the whole prompt with
    // `cached_tokens` as a subset of it. Adding is what converts between them.
    const usage = resolveResponsesUsage({
      input_tokens: 12,
      cache_read_input_tokens: 3972,
      cache_creation_input_tokens: 0,
      output_tokens: 41,
    })

    expect(usage).toEqual({
      input_tokens: 3984,
      output_tokens: 41,
      total_tokens: 4025,
      input_tokens_details: { cached_tokens: 3972, cache_creation_tokens: 0 },
    })
  })

  it('counts a cache write as prompt tokens too, and omits counters not reported', () => {
    const usage = resolveResponsesUsage({
      input_tokens: 12,
      cache_creation_input_tokens: 3743,
      output_tokens: 4,
    })

    expect(usage).toEqual({
      input_tokens: 3755,
      output_tokens: 4,
      total_tokens: 3759,
      // No `cached_tokens`: this upstream said nothing about cache reads, which
      // is not the same claim as "zero reads".
      input_tokens_details: { cache_creation_tokens: 3743 },
    })
  })

  it('returns nothing when no counter was seen at all', () => {
    // Distinguishes "observed zeros" from "observed nothing": zeroing a usage
    // block we never measured would be a regression, not a repair.
    expect(resolveResponsesUsage({})).toBeUndefined()
  })
})

describe('observeAnthropicUsage', () => {
  it('merges message_delta over message_start', async () => {
    // The gateway sends a placeholder `message_start` (its own pre-count, cache
    // counters zeroed) and only settles the real numbers in `message_delta`.
    const sink = createAnthropicUsageSink()
    const body = observeAnthropicUsage(
      streamOf(
        frame({
          type: 'message_start',
          message: {
            usage: {
              input_tokens: 2441,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              output_tokens: 0,
            },
          },
        }),
        frame({ type: 'content_block_delta', delta: { text: 'ok' } }),
        frame({
          type: 'message_delta',
          usage: {
            input_tokens: 12,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 3743,
            output_tokens: 4,
          },
        }),
      ),
      sink,
    )
    await drain(body)

    expect(resolveResponsesUsage(sink.observed)).toMatchObject({
      input_tokens: 3755,
      output_tokens: 4,
      input_tokens_details: { cached_tokens: 3743, cache_creation_tokens: 0 },
    })
  })

  it('keeps message_start counters that message_delta omits', async () => {
    // Anthropic direct settles input and cache counters up front and sends only
    // `output_tokens` in the delta. Merging must not blank the fields it leaves
    // out, or the fix for one vendor would break the other.
    const sink = createAnthropicUsageSink()
    await drain(observeAnthropicUsage(
      streamOf(
        frame({
          type: 'message_start',
          message: { usage: { input_tokens: 1000, cache_read_input_tokens: 900 } },
        }),
        frame({ type: 'message_delta', usage: { output_tokens: 50 } }),
      ),
      sink,
    ))

    expect(resolveResponsesUsage(sink.observed)).toMatchObject({
      input_tokens: 1900,
      output_tokens: 50,
      input_tokens_details: { cached_tokens: 900 },
    })
  })

  it('forwards the upstream bytes unchanged across split multibyte chunks', async () => {
    // The library parses this same stream, so the inspector has to be
    // byte-transparent. Splitting mid-character is the case a naive
    // decode/re-encode would corrupt.
    const encoded = new TextEncoder().encode(frame({ type: 'ping', note: '缓存' }))
    const cut = encoded.length - 6
    const sink = createAnthropicUsageSink()

    const out = await drain(observeAnthropicUsage(
      streamOf(encoded.slice(0, cut), encoded.slice(cut)),
      sink,
    ))

    expect(out).toBe(frame({ type: 'ping', note: '缓存' }))
  })
})

describe('repairResponsesUsage', () => {
  const completed = (usage: unknown): string => frame({
    type: 'response.completed',
    response: { id: 'resp_1', status: 'completed', usage },
  })

  it('rewrites the completed usage from what the wire actually billed', async () => {
    const sink = createAnthropicUsageSink()
    sink.observed = {
      input_tokens: 12,
      cache_read_input_tokens: 3972,
      cache_creation_input_tokens: 0,
      output_tokens: 41,
    }

    const out = await drain(repairResponsesUsage(
      streamOf(
        frame({ type: 'response.created', response: { id: 'resp_1' } }),
        completed({
          input_tokens: 2441,
          output_tokens: 41,
          total_tokens: 2482,
          input_tokens_details: { cached_tokens: 0, cache_creation_tokens: 0 },
        }),
      ),
      sink,
    ))

    const events = out
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)) as {
        type: string
        response?: { usage?: unknown }
      })
    expect(events.map((event) => event.type)).toEqual([
      'response.created',
      'response.completed',
    ])
    expect(events[1].response?.usage).toEqual({
      input_tokens: 3984,
      output_tokens: 41,
      total_tokens: 4025,
      input_tokens_details: { cached_tokens: 3972, cache_creation_tokens: 0 },
    })
  })

  it('leaves the stream alone when nothing was observed', async () => {
    // No observation means no authority to overwrite. Happens if a gateway ever
    // stops sending usage frames, and the library's own numbers are then the
    // best available.
    const original = frame({ type: 'response.created', response: { id: 'r' } })
      + completed({ input_tokens: 7, output_tokens: 1 })

    const out = await drain(repairResponsesUsage(
      streamOf(original),
      createAnthropicUsageSink(),
    ))

    expect(out).toBe(original)
  })

  it('preserves the framing of events it does not touch', async () => {
    const sink = createAnthropicUsageSink()
    sink.observed = { input_tokens: 5, output_tokens: 2 }
    const untouched = 'event: response.output_text.delta\n'
      + 'data: {"type":"response.output_text.delta","delta":"hi"}\n\n'

    const out = await drain(repairResponsesUsage(
      streamOf(untouched + completed({ input_tokens: 9, output_tokens: 2 })),
      sink,
    ))

    expect(out.startsWith(untouched)).toBe(true)
    expect(out.endsWith('\n\n')).toBe(true)
  })
})
