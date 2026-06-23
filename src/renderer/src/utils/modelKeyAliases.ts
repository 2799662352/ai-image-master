/**
 * Legacy model key aliases kept for stored localStorage values, older batch
 * queue snapshots, and history records. Public model IDs for Gemini image
 * generation no longer include the historical `-preview` suffix.
 */
export const MODEL_KEY_ALIASES: Record<string, string> = {
  'gemini-3.1-flash-image-preview': 'gemini-3.1-flash-image',
  'gemini-3-pro-image-preview': 'gemini-3-pro-image',
}

export function normalizeModelKey(key: string): string {
  return MODEL_KEY_ALIASES[key] ?? key
}
