# Modular Rules Reference

## buildRulesForPass

```typescript
function buildRulesForPass(
  pass: PassType,
  skills: PromptSkill[],
  state?: PipelineStateSlice
): string {
  return skills
    .filter(s => s.appliesTo.includes(pass))
    .sort((a, b) => a.priority - b.priority)
    .map(s => typeof s.rules === 'function' ? s.rules(state || {}) : s.rules)
    .join('\n\n')
}
```

## Per-Pass Rule Composition

| Pass | Skills | Est. rule lines |
|------|--------|----------------|
| scene | core(7) + style(3) + dodge(8) | ~18 |
| character | core(7) + physics(3) + dodge(8) | ~18 |
| shot | core(7) + dialogue(2) + physics(3) + dodge(8) + continuity*(~15) | ~20-35 |
| verify | core(7) + dialogue(2) + dodge(8) | ~17 |

*continuity only has content during retry

## Creating Custom Skills

### Interface

```typescript
interface PromptSkill {
  id: string                                              // unique, kebab-case
  rules: string | ((state: PipelineStateSlice) => string) // static or dynamic
  appliesTo: PassType[]                                   // which passes receive these rules
  priority: number                                        // lower = earlier in prompt
}
```

### Best Practices

1. **id**: kebab-case, descriptive (e.g., `horror-style`, `wuxia-action`)
2. **rules**: Use static string unless you need pipeline state data
3. **appliesTo**: Minimum scope — only passes that actually need these rules
4. **priority**: Follow range convention (0-9 core, 10-19 domain, 20-29 safety, 30+ context)

### Injection via Constructor

```typescript
const service = new StoryboardPipelineService(config, [...BUILTIN_SKILLS, mySkill])
```

To disable a built-in skill:
```typescript
const skills = BUILTIN_SKILLS.filter(s => s.id !== 'dodge')
```

### Dynamic Rules

Only use when rules depend on runtime state. Currently only `continuity` uses this:

```typescript
const myDynamicSkill: PromptSkill = {
  id: 'context-aware',
  rules: (state: PipelineStateSlice) => {
    if (!state.characters) return ''
    return `Context: ${state.characters.map(c => c.n).join(', ')}`
  },
  appliesTo: ['shot'],
  priority: 25
}
```

### YAGNI Checklist

Before adding a custom skill, verify:
- [ ] Cannot be achieved by adjusting existing skill rules
- [ ] Applies to at least 2+ scenes/projects (not one-off)
- [ ] Does not conflict with core rules (lighting, lens, Z-axis constraints)
- [ ] Total rule lines across all active skills < 50 per pass (prompt budget)
