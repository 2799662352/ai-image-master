import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { VideoWorkbenchVersion } from '../../../../../types/videoWorkbench'
import { VersionSwitcher } from '../VersionSwitcher'

afterEach(() => {
  cleanup()
})

function version(seq: number): VideoWorkbenchVersion {
  return {
    id: `v${seq}`,
    seq,
    createdAt: 1_000 + seq,
    localPath: `C:/v${seq}.mp4`,
    spec: {
      prompt: `第 ${seq} 版`,
      model: '2.0',
      resolution: '720p',
      ratio: '16:9',
      duration: 5,
      generateAudio: true,
      mode: 'multimodal_ref',
      webSearch: false,
      referenceBrief: { images: [], videos: [], audios: [] },
    },
  }
}

describe('VersionSwitcher', () => {
  it('只有一版时不渲染(没什么可切的)', () => {
    const { container } = render(
      <VersionSwitcher versions={[version(1)]} index={0} onChange={() => {}} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('显示 v2 / 3 形式,记法不与位置号拼接', () => {
    render(
      <VersionSwitcher versions={[version(1), version(2), version(3)]} index={1} onChange={() => {}} />,
    )
    expect(screen.getByText('v2 / 3')).toBeTruthy()
  })

  it('某一版的播放源全丢失时不崩(7 天清理扫掉 localPath 且 COS 上传失败)', () => {
    const orphan: VideoWorkbenchVersion = { ...version(1), localPath: undefined }
    render(<VersionSwitcher versions={[orphan, version(2)]} index={0} onChange={() => {}} />)
    // 切换器本身照常渲染;播放降级由 ResultVideoPlayer 的 PlaybackFallback 负责。
    expect(screen.getByText('v1 / 2')).toBeTruthy()
  })

  it('左右按钮切换下标,到头即禁用', () => {
    const onChange = vi.fn()
    render(
      <VersionSwitcher versions={[version(1), version(2)]} index={0} onChange={onChange} />,
    )
    expect(screen.getByRole('button', { name: '上一版' })).toHaveProperty('disabled', true)

    fireEvent.click(screen.getByRole('button', { name: '下一版' }))
    expect(onChange).toHaveBeenCalledWith(1)
  })
})
