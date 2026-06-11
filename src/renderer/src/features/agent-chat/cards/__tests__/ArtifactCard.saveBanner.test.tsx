import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ArtifactItem } from '../../../../../../types/agent-timeline'
import { ArtifactCard } from '../ArtifactCard'

afterEach(cleanup)

function makeItem(save: ArtifactItem['save']): ArtifactItem {
  return {
    type: 'artifact',
    id: 'art_1',
    startedAt: 1,
    endedAt: 2,
    status: 'done',
    save,
    artifacts: [
      {
        id: 'img_1',
        kind: 'image',
        name: 'codex-image-1.png',
        mime: 'image/png',
        size: 10,
        uri: 'data:image/png;base64,AAA',
      },
    ],
  }
}

describe('ArtifactCard save-status banner (standalone eye-catching bubble in chat)', () => {
  it('shows a pending banner while files are still saving in the background', () => {
    render(<ArtifactCard item={makeItem({ status: 'pending' })} />)

    const banner = screen.getByTestId('artifact-save-banner')
    expect(banner.textContent).toContain('已生成 1 张图')
    expect(banner.textContent).toContain('后台保存中')
  })

  it('shows the saved banner with the destination folder', () => {
    render(
      <ArtifactCard
        item={makeItem({
          status: 'saved',
          dir: 'C:\\Users\\me\\uploads',
          paths: ['C:\\Users\\me\\uploads\\a.png'],
        })}
      />,
    )

    const banner = screen.getByTestId('artifact-save-banner')
    expect(banner.textContent).toContain('已保存')
    expect(banner.textContent).toContain('C:\\Users\\me\\uploads')
  })

  it('shows a non-scary failed banner that confirms the image itself is fine', () => {
    render(<ArtifactCard item={makeItem({ status: 'failed' })} />)

    const banner = screen.getByTestId('artifact-save-banner')
    expect(banner.textContent).toContain('图片已生成')
    expect(banner.textContent).toContain('本地保存失败')
  })

  it('renders NO banner for plain attachment artifacts (no save info)', () => {
    render(<ArtifactCard item={makeItem(undefined)} />)
    expect(screen.queryByTestId('artifact-save-banner')).toBeNull()
  })
})
