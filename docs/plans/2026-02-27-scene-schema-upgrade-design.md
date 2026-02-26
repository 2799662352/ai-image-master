# Scene-Level Schema Upgrade Design

**Date:** 2026-02-27
**Status:** Approved

## Problem

Current schema is a flat `ShotsResponse = { character_anchor, shots[] }`. This misses:
- Scene-level narrative arc, tension, sound design
- Object-level physics types, cross-shot consistency anchors, psychological externalization
- Shot-level multi-granularity alignment, motion intensity quantification, sequence encoding

## New Architecture: 3-Layer Schema

```
SceneResponse (replaces ShotsResponse)
  ├── scene: SceneInfo (global narrative context)
  ├── objs: SceneObject[] (persistent objects with physics + anchors)
  ├── character_anchor: string (preserved for backward compat)
  └── shots: EnhancedShot[] (extends current ShotSchema)
```

## Zod Schema Design

### Layer 1: Scene (Global)

```typescript
const BgmSchema = z.object({
  base: z.string().describe('底层氛围: ambient drone, silence, low hum'),
  env: z.string().describe('环境音效: rain, wind, crowd murmur, clock ticking'),
  action: z.string().describe('动作音效: footsteps, fabric rustle, glass shatter'),
  melody: z.string().describe('旋律/留白策略: sparse piano, no melody, crescendo strings')
})

const SceneInfoSchema = z.object({
  d: z.string().describe('Narrative arc in A→B→C format. E.g. "confrontation → confession → silent acceptance"'),
  cap: z.string().describe('Structured title: subject-action-environment. E.g. "woman-discovers-letter-in-rain"'),
  env: z.string().describe('Environment summary: lighting/space/style. E.g. "dusk interior, warm practical lamps, neo-noir"'),
  bgm: BgmSchema,
  tension: z.string().describe('Core dramatic tension driving the sequence. E.g. "she knows the truth but cannot speak it"')
})
```

### Layer 2: Objects (Persistent entities)

```typescript
const SceneObjectSchema = z.object({
  n: z.string().describe('Object name. E.g. "woman in red dress", "antique pocket watch", "rain-soaked umbrella"'),
  f: z.string().describe('Visual features for cross-shot consistency. E.g. "black bob cut, pale skin, red silk qipao with gold trim"'),
  s: z.string().describe('Spatial position: FG/MG/BG + relative placement. E.g. "MG center, seated"'),
  p: z.string().describe('Physics type + constraints: rigid/articulated/fluid/cloth/near-rigid. E.g. "articulated biped, cloth skirt with gravity drape"'),
  t: z.string().describe('Cross-shot consistency anchors: which features MUST stay identical across S1-S9. E.g. "hair style, dress color, scar on left cheek = invariant S1-S9"'),
  psych: z.nullable(z.string()).describe('Appearance=psychology externalization: how visual details reflect inner state. E.g. "clenched fist = suppressed anger, loosened collar = lost composure". Null if inanimate.')
})
```

### Layer 3: Enhanced Shots (extends current)

```typescript
const EnhancedShotSchema = z.object({
  // === Existing 6 required fields ===
  kf, lens, spatial, action, light, label,
  
  // === Existing 6 nullable fields ===
  micro_expression, color_grade, atmosphere, body_physics, composition, emotion_target,
  
  // === NEW fields ===
  seq: z.string().describe('Sequence encoding: how this shot connects to neighbors. E.g. "S3: match-cut from S2 hand gesture, leads to S4 reaction shot"'),
  
  alignment: z.object({
    coarse: z.string().describe('Coarse grain: overall composition change from prev shot. E.g. "shift from wide establishing to medium intimacy"'),
    medium: z.string().describe('Medium grain: action chain within this shot. E.g. "reach → grasp → pull back"'),
    fine: z.string().describe('Fine grain: occlusion/highlight/shadow micro-changes. E.g. "shadow crosses face left-to-right as head turns"')
  }),
  
  motion: z.nullable(z.record(z.string(), z.string())).describe('Per-body-part motion intensity. E.g. {"head":"low-subtle nod","arms":"high-reaching upward","torso":"medium-slight lean","legs":"static"}. Null if static shot.')
})
```

### Top-Level Response

```typescript
const SceneResponseSchema = z.object({
  scene: SceneInfoSchema,
  objs: z.array(SceneObjectSchema),
  character_anchor: z.string().describe('Primary character appearance (backward compat)'),
  shots: z.array(EnhancedShotSchema),
  notes: z.nullable(z.string()).describe('Cross-shot verification summary. E.g. "S1-S3: dress color consistent, S4: lighting shift motivated by window"')
})
```

## Implementation Tasks

1. Add new schema types to LangChainDirectorService.ts
2. Update buildFinalPrompt to include scene/objs/notes layers
3. Update shotsToNaturalLanguage to include new shot fields
4. Update DirectorPage to use SceneResponseSchema when generating
5. Update system prompt to teach AI about the 3-layer structure
6. Update tests for new schema
7. Build + verify

## Backward Compatibility

- `character_anchor` preserved at top level
- Old `ShotsResponseSchema` kept as type alias for legacy fallback path
- `lastParsedPanels` still populated with 6-field subset for old consumers
