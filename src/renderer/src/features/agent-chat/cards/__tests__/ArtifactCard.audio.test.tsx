import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ArtifactItem } from '../../../../../../types/agent-timeline'
import { ArtifactCard } from '../ArtifactCard'

afterEach(cleanup)

function audioItem(overrides: Partial<ArtifactItem> = {}): ArtifactItem {
  return {
    type: 'artifact',
    id: 'art_audio_1',
    startedAt: 1,
    endedAt: 2,
    status: 'done',
    mediaKind: 'audio',
    artifacts: [
      {
        id: 'aud_1',
        kind: 'file',
        name: '一位女声说你好.mp3',
        mime: 'audio/mpeg',
        size: 0,
        uri: 'https://cos.example.com/image-history/audio/a.mp3',
      },
    ],
    ...overrides,
  }
}

describe('ArtifactCard audio', () => {
  it('renders an inline <audio> player for an audio artifact (COS URL)', () => {
    const { container } = render(<ArtifactCard item={audioItem()} />)
    const audio = container.querySelector('audio')
    expect(audio).toBeTruthy()
    expect(audio!.getAttribute('src')).toBe('https://cos.example.com/image-history/audio/a.mp3')
    expect(audio!.getAttribute('controls')).not.toBeNull()
    expect(screen.getByText('一位女声说你好.mp3')).toBeTruthy()
  })

  it('routes a local file path through local-file:// for playback', () => {
    const { container } = render(
      <ArtifactCard
        item={audioItem({
          artifacts: [
            { id: 'aud_2', kind: 'file', name: 'x.mp3', mime: 'audio/mpeg', size: 0, uri: 'C:\\ud\\audio-history\\x.mp3' },
          ],
        })}
      />,
    )
    const audio = container.querySelector('audio')
    expect(audio!.getAttribute('src')).toBe('local-file:///C%3A/ud/audio-history/x.mp3')
  })

  it('detects audio by extension even without an audio/* mime', () => {
    const { container } = render(
      <ArtifactCard
        item={audioItem({
          artifacts: [
            { id: 'aud_3', kind: 'file', name: 'clip.wav', mime: 'application/octet-stream', size: 0, uri: 'https://e/clip.wav' },
          ],
        })}
      />,
    )
    expect(container.querySelector('audio')).toBeTruthy()
  })

  it('shows the audio generating copy while in flight', () => {
    render(<ArtifactCard item={audioItem({ status: 'generating', artifacts: [] })} />)
    expect(screen.getByText('正在生成音频…')).toBeTruthy()
  })

  it('shows the audio failure copy on error', () => {
    render(<ArtifactCard item={audioItem({ status: 'error', artifacts: [], error: 'speaker not found' })} />)
    expect(screen.getByText('音频生成失败')).toBeTruthy()
    expect(screen.getByText('speaker not found')).toBeTruthy()
  })
})
