/**
 * Activity tab keep-alive — proves React 19.2's <Activity mode="hidden|visible">
 * preserves component state (here: an uncontrolled <input>) across tab switches.
 *
 * Note: this test uses fireEvent (project convention) instead of the plan's
 * @testing-library/user-event API, because user-event is not in the project's
 * dependencies and adding it for one test is overkill. fireEvent is sufficient
 * to drive the state-preservation behavior we're locking down.
 */
import { describe, expect, it } from 'vitest'
import { Activity, useState } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'

function TabHost() {
  const [active, setActive] = useState<'a' | 'b'>('a')
  return (
    <div>
      <button onClick={() => setActive('a')}>a</button>
      <button onClick={() => setActive('b')}>b</button>
      <Activity mode={active === 'a' ? 'visible' : 'hidden'}>
        <input aria-label="a-input" />
      </Activity>
      <Activity mode={active === 'b' ? 'visible' : 'hidden'}>
        <input aria-label="b-input" />
      </Activity>
    </div>
  )
}

describe('Activity tab keep-alive', () => {
  it('preserves input state when switching away and back', () => {
    render(<TabHost />)

    const aInput = screen.getByLabelText('a-input') as HTMLInputElement
    fireEvent.change(aInput, { target: { value: 'hello' } })
    expect(aInput.value).toBe('hello')

    fireEvent.click(screen.getByRole('button', { name: 'b' }))
    fireEvent.click(screen.getByRole('button', { name: 'a' }))

    // After round-trip the same DOM input node should still hold 'hello'.
    const aInputAfter = screen.getByLabelText('a-input') as HTMLInputElement
    expect(aInputAfter.value).toBe('hello')
  })
})
