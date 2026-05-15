const IFRAME_PROTOCOLS = new Set(['https:'])
const EXTERNAL_PROTOCOLS = new Set(['https:', 'http:'])

export type UrlValidationResult =
  | { ok: true; url: string; embeddable: boolean }
  | { ok: false; reason: string }

export function validateExternalUrl(input: string): UrlValidationResult {
  if (!input || typeof input !== 'string') {
    return { ok: false, reason: 'empty' }
  }

  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    return { ok: false, reason: 'malformed' }
  }

  if (!EXTERNAL_PROTOCOLS.has(parsed.protocol)) {
    return { ok: false, reason: `disallowed-scheme:${parsed.protocol}` }
  }

  return { ok: true, url: parsed.toString(), embeddable: IFRAME_PROTOCOLS.has(parsed.protocol) }
}
