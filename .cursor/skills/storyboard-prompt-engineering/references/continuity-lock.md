# Continuity Lock Reference

## Trigger

Activates when ALL conditions met:
1. `state.retryFeedback` is non-empty (verify score < 10 triggered retry)
2. `state.previousShots` is non-null (prepareRetry saved previous shots)

## Data Flow

```
verifyConsistency (score < 10)
  → prepareRetry
    → saves previousShots = shots.map(s => ({id, desc}))
    → sets retryFeedback = formatted issue list
    → clears shots + report
  → generateShots (retry)
    → buildRulesForPass('shot', skills, stateSlice)
      → continuity skill: buildContinuityLock(state)
        → generates lock rules with anchors + reference frames
    → LLM generates new shots respecting lock
```

## buildContinuityLock Implementation

```typescript
function buildContinuityLock(state: PipelineStateSlice): string {
  if (!state.retryFeedback || !state.previousShots) return ''

  const shotSummary = state.previousShots
    .map(s => `${s.id}: ${s.desc}`)
    .join('\n')

  const anchors = state.characters
    ?.map(c => `[${c.n}] ${c.t}`)
    .join('; ') || ''

  return `CONTINUITY LOCK (严格遵守):
以下为上一轮生成的参考帧，本次仅修正被指出的问题，其余完全保持不变。
角色锚点锁定: ${anchors}

参考帧:
${shotSummary}

规则: 未被 retryFeedback 提及的镜头 → 原样保留，禁止修改。`
}
```

## Token Budget Analysis

| Data | Est. tokens | Calculation |
|------|------------|-------------|
| 9 shots `{id, desc}` | ~800 | 5-part desc avg 80 tokens each |
| 4 character anchors | ~200 | `[name] anchor-text` format |
| Lock template text | ~100 | Fixed Chinese+English text |
| **Total** | **~1100** | **13% of 8192 max output tokens** |

### Why NOT Full ShotData

Full ShotData includes `act`, `fx`, `motive` fields. For 9 shots:
- Full: ~3000+ tokens (37% of budget)
- Slim `{id, desc}`: ~1100 tokens (13% of budget)

The `desc` field alone contains the full 5-part shot specification (景别|动作|台词精华|心理→外化|运镜) which provides sufficient continuity reference. The `act`/`fx`/`motive` fields are derivatives that can be regenerated from `desc` context.

## Limitations

1. **Soft constraint only** — LLM may still modify "locked" shots; no code-level enforcement
2. **No shot ID validation** — if LLM changes ID naming (S1→Shot1), lock breaks
3. **Split/merge not handled** — if feedback requests splitting a shot (S4→S4a/S4b), lock rule doesn't adapt

## Potential Future Enhancement: Code-Level Enforcement

If LLM compliance proves insufficient, add a post-generation diff guard:

```typescript
function enforceContinuityLock(
  newShots: ShotData[],
  previousShots: PreviousShot[],
  issueIds: Set<string>
): ShotData[] {
  const prevMap = new Map(previousShots.map(s => [s.id, s]))
  return newShots.map(shot => {
    if (!issueIds.has(shot.id) && prevMap.has(shot.id)) {
      return { ...shot, desc: prevMap.get(shot.id)!.desc }
    }
    return shot
  })
}
```

This is NOT currently implemented — only add if empirical testing shows LLM non-compliance rate > 20%.
