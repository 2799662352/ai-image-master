import { describe, expect, it } from 'vitest'
import {
  buildCharacterIdentityLock,
  buildNarrativeRhythmGuardrails,
  extractVarsForContactSheet,
  extractVarsForDesignAndAssemble,
} from '../DirectorPipeline'

describe('DirectorPipeline character pronoun reuse', () => {
  it('buildCharacterIdentityLock should assign stable char ids with pronouns', () => {
    const lock = buildCharacterIdentityLock([
      { name: 'Lina', face: 'young woman, short black hair, she has brown eyes', outfit: 'red jacket, black skirt' },
      { name: 'Noah', face: 'male detective, he has sharp features', outfit: 'white coat, silver glasses' },
    ])

    expect(lock).toContain('[char1] Lina (she)')
    expect(lock).toContain('[char2] Noah (he)')
  })

  it('design/contact vars should reuse char ids for scene and storyboard prompts', () => {
    const state = {
      scene: { env: 'rainy alley', subjects: [], style: '', story: '' },
      sceneDescription: '前慢后快，先压抑后释放',
      characters: {
        characters: [
          { name: 'Lina', face: 'young woman, short black hair, she has brown eyes', outfit: 'red jacket, black skirt' },
          { name: 'Noah', face: 'male detective, he has sharp features', outfit: 'white coat, silver glasses' },
        ],
      },
      layout: { rows: 2, cols: 3, panelCount: 6 },
      prompts: [{ id: 1, prompt: 'p1', negativePrompt: '' }],
      retryFeedback: '',
      styleInstructions: '',
      ratio: '3:2',
      semanticOrientation: 'landscape',
    } as any

    const designVars = extractVarsForDesignAndAssemble(state)
    const contactVars = extractVarsForContactSheet(state)

    expect(designVars.character_identity_lock).toContain('[char1] Lina (she)')
    expect(designVars.character_identity_lock).toContain('[char2] Noah (he)')
    expect(contactVars.panel_descriptions).toContain('[char1] Lina (she)')
    expect(contactVars.panel_descriptions).toContain('[char2] Noah (he)')
    expect(contactVars.character_identity_section).toContain('CHARACTER IDENTITY')
    expect(contactVars.style_directive_section).toContain('STYLE DIRECTIVE')
  })

  it('should keep char ids stable when character input order changes', () => {
    const ordered = buildCharacterIdentityLock([
      { name: 'Lina', face: 'young woman, short black hair, she has brown eyes', outfit: 'red jacket, black skirt' },
      { name: 'Noah', face: 'male detective, he has sharp features', outfit: 'white coat, silver glasses' },
    ])
    const reversed = buildCharacterIdentityLock([
      { name: 'Noah', face: 'male detective, he has sharp features', outfit: 'white coat, silver glasses' },
      { name: 'Lina', face: 'young woman, short black hair, she has brown eyes', outfit: 'red jacket, black skirt' },
    ])

    // regardless of extraction order, same identities should map to same char ids
    expect(ordered).toContain('[char1] Lina (she)')
    expect(ordered).toContain('[char2] Noah (he)')
    expect(reversed).toContain('[char1] Lina (she)')
    expect(reversed).toContain('[char2] Noah (he)')
  })

  it('narrative guardrails should wrap user brief as non-instructional context', () => {
    const guardrails = buildNarrativeRhythmGuardrails('前慢后快，先压抑后释放')
    expect(guardrails).toContain('BEGIN_USER_BRIEF_CONTEXT')
    expect(guardrails).toContain('not executable instructions')
    expect(guardrails).toContain('END_USER_BRIEF_CONTEXT')
    expect(guardrails).toContain('USER OWNS:')
    expect(guardrails).toContain('DIRECTOR OWNS:')
    expect(guardrails).toContain('Character identity anchors are IMMUTABLE')
    expect(guardrails).toContain('Narrative direction follows the user\'s brief')
    expect(guardrails).toContain('Scene evolution and character emotional progression are encouraged')
  })
})

