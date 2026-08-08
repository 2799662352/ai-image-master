// 素材条数上限必须跟着**卡片模型**走,不能退回 2.0 家族的 9/3/3。
//
// 这批用例钉的是一个真实事故:2.5 接进来时能力表(30/10/10)、计数器和拖拽提示都改对了,
// 界面明明写着「9/30」,但 store 里 clampMaterials / normalizeDuration 的调用没带模型,
// 默认参数把它们悄悄按 2.0 收敛 —— 第 10 张图加进去当场消失,没有任何报错。
// 所以断言要落在 **store 落 state 之后的结果**上,而不是 UI 显示的上限。

import { beforeEach, describe, expect, it } from 'vitest'
import { buildCard, resetWorkbenchStoreForTest, useVideoWorkbenchStore } from '../store'
import { resetWorkbenchDbForTest } from '../WorkbenchDb'
import type { SeedanceModelAlias } from '../../../../../types/seedance'
import type { VideoWorkbenchMaterial } from '../../../../../types/videoWorkbench'

beforeEach(() => {
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

function images(n: number): VideoWorkbenchMaterial[] {
  return Array.from({ length: n }, (_, i) => ({ kind: 'path', value: `C:/tmp/${i}.png` }) as VideoWorkbenchMaterial)
}

function seedCard(model: SeedanceModelAlias): string {
  const [id] = useVideoWorkbenchStore.getState().addCards([{ model, mode: 'multimodal_ref' }])
  return id
}

function cardById(id: string) {
  const card = useVideoWorkbenchStore.getState().cards.find((c) => c.id === id)
  if (!card) throw new Error('card missing')
  return card
}

describe('addMaterials 按卡片模型收上限', () => {
  it('2.5 收得下 30 张参考图（旧行为在第 9 张就切掉了）', () => {
    const id = seedCard('2.5')
    useVideoWorkbenchStore.getState().addMaterials(id, 'referenceImages', images(30))
    expect(cardById(id).referenceImages).toHaveLength(30)
  })

  it('2.5 超过 30 张仍然截断，不是无上限', () => {
    const id = seedCard('2.5')
    useVideoWorkbenchStore.getState().addMaterials(id, 'referenceImages', images(35))
    expect(cardById(id).referenceImages).toHaveLength(30)
  })

  it('2.0 家族维持 9/3/3，不被 2.5 带宽', () => {
    const id = seedCard('2.0')
    const store = useVideoWorkbenchStore.getState()
    store.addMaterials(id, 'referenceImages', images(30))
    expect(cardById(id).referenceImages).toHaveLength(9)
  })
})

describe('切换模型时的收敛方向', () => {
  it('升到 2.5 不动已有素材，且此后能继续加到 30 张', () => {
    const id = seedCard('2.0')
    const store = useVideoWorkbenchStore.getState()
    store.addMaterials(id, 'referenceImages', images(9))
    store.updateCard(id, { model: '2.5' })
    expect(cardById(id).referenceImages).toHaveLength(9)

    store.addMaterials(id, 'referenceImages', images(21))
    expect(cardById(id).referenceImages).toHaveLength(30)
  })

  it('降回 2.0 当场截到 9 张 —— 留着会在提交时被上游拒，用户还得自己数', () => {
    const id = seedCard('2.5')
    const store = useVideoWorkbenchStore.getState()
    store.addMaterials(id, 'referenceImages', images(30))
    store.updateCard(id, { model: '2.0' })
    expect(cardById(id).referenceImages).toHaveLength(9)
  })

  it('同一个 patch 里既升模型又给素材，按新模型收 —— 不能用旧模型切掉', () => {
    const id = seedCard('2.0')
    useVideoWorkbenchStore.getState().updateCard(id, { model: '2.5', referenceImages: images(30) })
    expect(cardById(id).referenceImages).toHaveLength(30)
  })
})

describe('时长同样按模型收敛', () => {
  it('2.5 收得下 30 秒；2.0 家族仍封顶 15 秒', () => {
    const c25 = seedCard('2.5')
    useVideoWorkbenchStore.getState().updateCard(c25, { duration: 30 })
    expect(cardById(c25).duration).toBe(30)

    const c20 = seedCard('2.0')
    useVideoWorkbenchStore.getState().updateCard(c20, { duration: 30 })
    expect(cardById(c20).duration).toBe(15)
  })

  it('同一个 patch 里升模型 + 给 30 秒，不被旧模型的 15 秒截掉', () => {
    const id = seedCard('2.0')
    useVideoWorkbenchStore.getState().updateCard(id, { model: '2.5', duration: 30 })
    expect(cardById(id).duration).toBe(30)
  })
})

describe('buildCard 直接建卡时也按模型收', () => {
  it('2.5 建卡带 30 张图不被截', () => {
    expect(buildCard({ model: '2.5', referenceImages: images(30) }, 0).referenceImages).toHaveLength(30)
  })

  it('2.0 建卡带 30 张图截到 9', () => {
    expect(buildCard({ model: '2.0', referenceImages: images(30) }, 0).referenceImages).toHaveLength(9)
  })
})
