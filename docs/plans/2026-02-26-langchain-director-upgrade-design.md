# LangChain.js Director Pipeline Upgrade Design

**Date:** 2026-02-26
**Status:** Approved
**Scope:** Replace hand-rolled AI call + regex JSON parse pipeline with LangChain.js structured output chain

---

## Background

The DirectorPage's cinematic shot generation pipeline currently:
1. Manually concatenates system prompt + user input strings
2. Uses `api.analyzeImagesStream()` with callback-based streaming
3. Extracts JSON from markdown code fences via regex
4. `JSON.parse` + casts without structural validation
5. Requires AI to output `prompt_text` as a JSON string inside JSON (double-encoding)

This is fragile: AI format drift breaks the regex, invalid JSON structure silently corrupts downstream prompts, and the double-encoding wastes tokens.

## Target Architecture

### 3-Layer Separation

```
DirectorPage (UI Layer)
    ↓ calls
LangChainDirectorService (AI Logic Layer)
    ↓ uses
ChatGoogle + Zod Schema (Infrastructure Layer)
```

- **DirectorPage**: UI, progress display, fallback orchestration. No direct LLM calls.
- **LangChainDirectorService**: Encapsulates all LLM interactions via `ChatGoogle`. Exposes typed async methods.
- **ChatGoogle.withStructuredOutput(Zod)**: Gemini returns Zod-validated objects directly. No regex, no manual parse.

### Data Flow

```
DirectorPage.startGeneration()
  → service.analyzeImage(images)        // Step 1: image analysis (text output)
  → service.generateShots(analysis, config) // Step 2: structured shots (Zod-validated)
  → service.buildFinalPrompt(shots, layout) // Step 3: compact JSON string (pure function)
  → generateComicPage(prompt)           // Step 4: image generation (existing)
```

## Zod Schema

```typescript
import { z } from 'zod'

const ShotSchema = z.object({
  kf: z.string().describe('KF number + shot type + duration'),
  lens: z.string().describe('Focal length + camera movement'),
  spatial: z.object({
    fg: z.string().describe('Foreground layer'),
    mg: z.string().describe('Midground layer'),
    bg: z.string().describe('Background layer')
  }),
  action: z.string().describe('One anchor verb + manner words'),
  light: z.string().describe('Source + direction + quality + color temperature'),
  label: z.string().describe('Panel label')
})

const ShotsResponseSchema = z.object({
  character_anchor: z.string().describe('Precise character appearance description'),
  shots: z.array(ShotSchema)
})

type ShotsResponse = z.infer<typeof ShotsResponseSchema>
```

## LangChainDirectorService API

```typescript
class LangChainDirectorService {
  constructor(config: { apiKey: string; model?: string })

  // Step 1: Analyze reference image(s), return text description
  async analyzeImage(images: ImageInput[], sceneHint?: string): Promise<string>

  // Step 2: Generate structured shots from image + analysis + config
  async generateShots(input: ShotGenInput): Promise<ShotsResponse>

  // Step 3: Build compact JSON prompt string (pure function, no LLM)
  buildFinalPrompt(shots: ShotsResponse, layout: LayoutConfig, style: StyleConfig): string

  // Utility: Convert structured shots to natural language for video prompts
  shotsToNaturalLanguage(shots: ShotsResponse['shots']): string
}
```

## Retry & Fallback Strategy

- `ChatGoogle` initialized with `maxRetries: 2` (built-in exponential backoff)
- If `generateShots` fails after retries, `DirectorPage` falls back to existing `generateTemplatePrompt()` path
- Fallback behavior identical to current "Gem AI unavailable" path -- zero new risk

## Dependencies

```
@langchain/google   - ChatGoogle for Gemini integration
@langchain/core     - HumanMessage, SystemMessage, base types
zod                 - Already installed (v4.3.6)
```

## Files Changed

| File | Action | Lines |
|------|--------|-------|
| `src/renderer/src/services/LangChainDirectorService.ts` | CREATE | ~200 |
| `src/renderer/src/services/ServiceBridge.ts` | MODIFY | ~15 |
| `src/renderer/src/pages/DirectorPage.ts` | MODIFY | ~165 (40 add, 5 modify, 120 delete) |
| `tests/services/LangChainDirectorService.test.ts` | CREATE | ~120 |
| `tests/pages/DirectorPage.test.ts` | MODIFY | ~30 |

## Testing Strategy

1. **Service unit tests**: Mock ChatGoogle, verify message construction, structured output handling, retry behavior
2. **DirectorPage integration tests**: Mock service, verify LangChain-first + fallback flow
3. **Schema tests**: Valid/invalid shot JSON parsing
4. **Build verification**: `npx electron-vite build` + `npx vitest run` + ReadLints

## Migration Notes

- `generateJsonShots()` and `parseJsonShotsResponse()` are deleted (replaced by service)
- `lastParsedPanels` instance cache eliminated (structured data flows through directly)
- `cinematicGemSystemPrompt` moves to service (system prompt stays identical, just relocated)
- `generateSora2VideoPrompt()` updated to use `shotsToNaturalLanguage()` utility
- All existing public API signatures preserved for backward compatibility
