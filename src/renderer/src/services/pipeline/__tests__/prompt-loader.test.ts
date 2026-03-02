import { describe, it, expect } from 'vitest'
import { renderTemplate } from '../prompt-loader'

describe('renderTemplate', () => {
  it('replaces {{var}} placeholders with values', () => {
    const tpl = 'Scene: {{scene_env}}, Panels: {{panel_count}}'
    const result = renderTemplate(tpl, { scene_env: 'forest', panel_count: '6' })
    expect(result).toBe('Scene: forest, Panels: 6')
  })

  it('replaces missing vars with empty string', () => {
    const tpl = 'Hello {{name}}, your role is {{role}}'
    const result = renderTemplate(tpl, { name: 'Alice' })
    expect(result).toBe('Hello Alice, your role is ')
  })

  it('leaves non-matching patterns untouched', () => {
    const tpl = 'No vars here, just {text} and [brackets]'
    const result = renderTemplate(tpl, {})
    expect(result).toBe('No vars here, just {text} and [brackets]')
  })
})
