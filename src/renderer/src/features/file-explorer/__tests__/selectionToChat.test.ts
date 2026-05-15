import { describe, expect, it } from 'vitest'
import { formatSelectionForChat } from '../selectionToChat'

describe('formatSelectionForChat', () => {
  it('returns plain markdown text with a standard fenced code block', () => {
    const text = formatSelectionForChat({
      path: 'C:/repo/scripts/validate-mounted-env-files.sh',
      fromLine: 244,
      toLine: 254,
      text: 'find_1password_db() {\n  local os_type="$1"\n}',
    })

    expect(text).toBe('```sh\nfind_1password_db() {\n  local os_type="$1"\n}\n```')
    expect(text).not.toContain('C:/repo/scripts/validate-mounted-env-files.sh')
    expect(text).not.toContain(':244-254')
  })
})
