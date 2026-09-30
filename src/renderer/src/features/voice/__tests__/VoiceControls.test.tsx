import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const session = vi.hoisted(() => ({
  toggleListening: vi.fn(),
  stopSpeaking: vi.fn(),
  unlockAudio: vi.fn(async () => {}),
  beginHold: vi.fn(),
  finishHold: vi.fn(async () => {}),
}))
vi.mock('../agentChatVoice', () => ({ getVoiceSession: () => session }))

import { VoiceControls } from '../VoiceControls'
import { DEFAULT_VOICE_SETTINGS, useVoiceStore } from '../voiceStore'

beforeEach(() => {
  vi.clearAllMocks()
  useVoiceStore.setState({
    settings: { ...DEFAULT_VOICE_SETTINGS },
    asr: { enabled: false, loading: false, running: false },
    commitPending: null,
    modelProgress: null,
    speaking: false,
    audioLocked: false,
    error: null,
  })
})

afterEach(cleanup)

describe('VoiceControls', () => {
  it('toggles listening and reflects the recognizer state', () => {
    render(<VoiceControls disabled={false} />)
    const mic = screen.getByTestId('agent-voice-mic')
    expect(mic.textContent).toContain('语音')
    expect(mic.getAttribute('data-active')).toBe('false')
    fireEvent.click(mic)
    expect(session.toggleListening).toHaveBeenCalledTimes(1)

    act(() => useVoiceStore.getState().setAsr({ enabled: true, loading: true, running: false }))
    act(() => useVoiceStore.getState().setModelProgress({ phase: 'download', received: 21_949_377, total: 43_898_754 }))
    expect(mic.textContent).toContain('下载模型 50%')

    act(() => useVoiceStore.getState().setAsr({ enabled: true, loading: false, running: true }))
    expect(mic.textContent).toContain('听写中')
    expect(mic.getAttribute('data-active')).toBe('true')
    expect(mic.getAttribute('title')).toBe('暂停语音输入')

    act(() => useVoiceStore.getState().setAsr({ enabled: true, loading: false, running: false }))
    expect(mic.textContent).toContain('等回复')

    act(() => useVoiceStore.getState().setError('麦克风没能启动: NotAllowedError'))
    expect(mic.getAttribute('title')).toBe('麦克风没能启动: NotAllowedError')
  })

  it('switches reading on and stops a reading in progress', () => {
    render(<VoiceControls disabled={false} />)
    const speaker = screen.getByTestId('agent-voice-speaker')
    fireEvent.click(speaker)
    expect(useVoiceStore.getState().settings.ttsEnabled).toBe(true)
    expect(localStorage.getItem('catimation.voice.settings.v1')).toContain('"ttsEnabled":true')

    act(() => useVoiceStore.getState().setSpeaking(true))
    expect(speaker.getAttribute('title')).toBe('停止朗读')
    fireEvent.click(speaker)
    expect(session.stopSpeaking).toHaveBeenCalledTimes(1)
    expect(useVoiceStore.getState().settings.ttsEnabled).toBe(true)

    act(() => useVoiceStore.getState().setAudioLocked(true))
    expect(speaker.getAttribute('title')).toContain('点一下继续朗读')
    fireEvent.click(speaker)
    expect(session.unlockAudio).toHaveBeenCalledTimes(1)
  })

  it('exposes hold-to-talk and reading options in the settings panel', () => {
    render(<VoiceControls disabled={false} />)
    fireEvent.click(screen.getByTestId('agent-voice-settings'))
    const panel = screen.getByRole('dialog', { name: '语音设置' })
    fireEvent.click(screen.getByLabelText(/按住 F8 说话/))
    expect(useVoiceStore.getState().settings.holdToTalk).toBe(true)
    fireEvent.click(screen.getByLabelText(/分句朗读/))
    expect(useVoiceStore.getState().settings.ttsSplitEnabled).toBe(true)
    expect(screen.queryByLabelText('声线描述')).toBeNull()
    fireEvent.change(screen.getByLabelText('音色'), { target: { value: 'Ethan' } })
    expect(useVoiceStore.getState().settings.ttsVoice).toBe('Ethan')
    fireEvent.change(screen.getByLabelText('识别引擎'), { target: { value: 'vosk' } })
    expect(useVoiceStore.getState().settings.asrProvider).toBe('vosk')

    fireEvent.change(screen.getByLabelText('朗读引擎'), { target: { value: 'seed-audio' } })
    expect(screen.queryByLabelText('音色')).toBeNull()
    fireEvent.change(screen.getByLabelText('声线描述'), { target: { value: '一位老人' } })
    expect(useVoiceStore.getState().settings.voicePrompt).toBe('一位老人')

    fireEvent.change(screen.getByLabelText('说完后'), { target: { value: 'fill' } })
    expect(useVoiceStore.getState().settings.autoSend).toBe(false)
    fireEvent.change(screen.getByLabelText('停顿多久算说完'), { target: { value: '4000' } })
    expect(useVoiceStore.getState().settings.sendDelayMs).toBe(4000)
    fireEvent.click(screen.getByLabelText('朗读回复'))
    expect(useVoiceStore.getState().settings.ttsEnabled).toBe(true)

    fireEvent.pointerDown(document.body)
    expect(document.body.contains(panel)).toBe(false)
  })

  it('renders the settings panel outside the toolbar so side panels cannot cover it', () => {
    const { container } = render(
      <div style={{ overflow: 'hidden' }}>
        <VoiceControls disabled={false} />
      </div>,
    )
    fireEvent.click(screen.getByTestId('agent-voice-settings'))
    const panel = screen.getByRole('dialog', { name: '语音设置' })
    expect(container.contains(panel)).toBe(false)
    expect(panel.parentElement).toBe(document.body)
    expect(panel.style.position).toBe('fixed')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '语音设置' })).toBeNull()
  })

  it('shows a countdown while waiting to see if the user keeps talking', () => {
    useVoiceStore.setState({
      asr: { enabled: true, loading: false, running: true },
      commitPending: { delayMs: 2000, since: Date.now() },
    })
    render(<VoiceControls disabled={false} />)
    const mic = screen.getByTestId('agent-voice-mic')
    expect(mic.textContent).toContain('待发送')
    expect(screen.getByTestId('agent-voice-pending')).toBeTruthy()
    expect(mic.getAttribute('title')).toContain('之后自动发送')
  })

  it('starts a hold on F8 once enabled', async () => {
    useVoiceStore.getState().updateSettings({ holdToTalk: true })
    render(<VoiceControls disabled={false} />)
    fireEvent.keyDown(window, { code: 'F8' })
    fireEvent.keyUp(window, { code: 'F8' })
    await vi.waitFor(() => expect(session.finishHold).toHaveBeenCalledWith(false))
    expect(session.beginHold).toHaveBeenCalledTimes(1)
  })
})
