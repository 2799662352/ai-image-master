import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  resetWorkbenchStoreForTest,
  useVideoWorkbenchStore,
} from '../../../features/video-workbench/store'
import { resetWorkbenchDbForTest } from '../../../features/video-workbench/WorkbenchDb'
import { CardGap } from '../CardGap'

beforeEach(() => {
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
})

// 本仓库不开自动清理,同目录组件测试一律手动 cleanup。
afterEach(() => {
  cleanup()
})

describe('CardGap', () => {
  it('点击在该卡之前插入一张默认卡', () => {
    const [a] = useVideoWorkbenchStore.getState().addCards([{ prompt: 'A' }])
    render(<CardGap beforeCardId={a} hidden={false} />)

    fireEvent.click(screen.getByRole('button', { name: /在此插入卡片/ }))

    const cards = [...useVideoWorkbenchStore.getState().cards].sort((x, y) => x.order - y.order)
    expect(cards).toHaveLength(2)
    expect(cards[0].prompt).toBe('')
    expect(cards[1].prompt).toBe('A')
  })

  it('拖拽进行中整条隐身,避让插入指示线', () => {
    const [a] = useVideoWorkbenchStore.getState().addCards([{ prompt: 'A' }])
    render(<CardGap beforeCardId={a} hidden />)

    expect(screen.queryByRole('button', { name: /在此插入卡片/ })).toBeNull()
  })
})
