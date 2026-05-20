import { describe, expect, it } from 'vitest'
import { resolveMainWindowShortcut } from '../keyboardShortcuts'

type Input = Parameters<typeof resolveMainWindowShortcut>[0]

const keyDown = (overrides: Partial<Input>): Input => ({
  key: '',
  type: 'keyDown',
  control: false,
  meta: false,
  shift: false,
  ...overrides,
})

describe('resolveMainWindowShortcut', () => {
  it('ignores keyUp so toggle-style actions do not double-fire', () => {
    expect(resolveMainWindowShortcut({ ...keyDown({ key: 'F11' }), type: 'keyUp' })).toBeNull()
    expect(resolveMainWindowShortcut({ ...keyDown({ key: 'F12' }), type: 'keyUp' })).toBeNull()
  })

  it('F12 → toggleDevTools', () => {
    expect(resolveMainWindowShortcut(keyDown({ key: 'F12' }))).toEqual({ type: 'toggleDevTools' })
  })

  it('F5 → reload', () => {
    expect(resolveMainWindowShortcut(keyDown({ key: 'F5' }))).toEqual({ type: 'reload' })
  })

  it('Ctrl+R → reload', () => {
    expect(resolveMainWindowShortcut(keyDown({ key: 'r', control: true }))).toEqual({ type: 'reload' })
  })

  it('Cmd+R → reload (macOS-style)', () => {
    expect(resolveMainWindowShortcut(keyDown({ key: 'r', meta: true }))).toEqual({ type: 'reload' })
  })

  it('Ctrl+Shift+R wins over Ctrl+R (force-reload, must be matched first)', () => {
    expect(
      resolveMainWindowShortcut(keyDown({ key: 'r', control: true, shift: true })),
    ).toEqual({ type: 'reloadIgnoringCache' })
  })

  it('F11 → toggleFullScreen (the regression v4.3.12 fixes)', () => {
    expect(resolveMainWindowShortcut(keyDown({ key: 'F11' }))).toEqual({ type: 'toggleFullScreen' })
  })

  it('case-insensitive R (caps lock) still matches reload', () => {
    expect(resolveMainWindowShortcut(keyDown({ key: 'R', control: true }))).toEqual({ type: 'reload' })
  })

  it('letter without modifier returns null (does not steal user typing)', () => {
    expect(resolveMainWindowShortcut(keyDown({ key: 'a' }))).toBeNull()
    expect(resolveMainWindowShortcut(keyDown({ key: 'r' }))).toBeNull()
  })

  it('arbitrary unrelated key returns null', () => {
    expect(resolveMainWindowShortcut(keyDown({ key: 'Enter' }))).toBeNull()
    expect(resolveMainWindowShortcut(keyDown({ key: 'F10' }))).toBeNull()
  })
})
