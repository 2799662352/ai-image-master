import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ArtifactGrid } from '../ArtifactGrid'

describe('ArtifactGrid', () => {
  it('renders image artifacts', () => {
    render(
      <ArtifactGrid
        artifacts={[
          {
            id: 'a1',
            type: 'image',
            uri: 'file:///a.png',
            metadata: {},
            createdAt: new Date().toISOString(),
          },
        ]}
      />,
    )

    expect(screen.getByRole('img')).toBeTruthy()
  })
})
