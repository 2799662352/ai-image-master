import { describe, expect, it } from 'vitest'
import { buildPoolOptions, poolLabelOf } from '../pools'

const joined = (over: Record<string, unknown> = {}) => ({
  id: 700,
  name: 'Seedance',
  studioName: '猫工作室',
  balanceYuan: 12,
  joined: true,
  ...over,
})

describe('buildPoolOptions', () => {
  /**
   * 🧬 变异点:删掉那段 `items.unshift({ … '个人计费' })`,这条必红。
   *
   * 个人计费落点**刻意不在** `/api/user/organizations` 的返回里(后端设计前提)。
   * 不补齐的话,用户最常用的那个池在下拉里根本不存在、在出图提示里显示不出名字。
   */
  it('把不在组织列表里的个人计费落点补进来,并排在最前', () => {
    const options = buildPoolOptions([joined()] as never, 342)

    expect(options[0]).toEqual({
      pool: { projectId: 342, producerProjectId: null },
      label: '个人计费',
    })
    expect(options).toHaveLength(2)
  })

  // 后端某天把它放进列表了就不该再补一条 —— 下拉里出现两个同名项,选哪个都对,
  // 但用户会以为自己看花了眼。
  it('列表里已经有个人计费落点时不重复补', () => {
    const options = buildPoolOptions(
      [joined({ id: 342, name: '个人计费', studioName: null, producerProjectId: undefined })] as never,
      342,
    )

    expect(options).toHaveLength(1)
  })

  it('没有个人计费落点时不凭空造一条', () => {
    const options = buildPoolOptions([joined()] as never, null)

    expect(options).toHaveLength(1)
    expect(options[0].label).toBe('猫工作室 / Seedance')
  })

  /**
   * 🧬 变异点:去掉 `.filter((o) => o.joined)`,这条必红。
   *
   * 未加入的组织没有 allocation 行、没有影子账户可扣,选中它只会在出图时拿到
   * 一个看不懂的错误。
   */
  it('未加入的组织不进选项', () => {
    const options = buildPoolOptions(
      [joined(), joined({ id: 900, name: '没加入的', joined: false })] as never,
      null,
    )

    expect(options).toHaveLength(1)
    expect(options[0].pool.projectId).toBe(700)
  })

  it('没有工作室名时只用组织名', () => {
    const options = buildPoolOptions([joined({ studioName: null })] as never, null)

    expect(options[0].label).toBe('Seedance')
  })
})

describe('poolLabelOf', () => {
  const options = buildPoolOptions(
    [
      joined({ name: 'A 池', producerProjectId: 5 }),
      joined({ name: 'B 池', producerProjectId: 6 }),
    ] as never,
    null,
  )

  /**
   * 🧬 变异点:把比对从 `samePool` 换成只比 `projectId`,这条必红。
   *
   * 两个 producer 池共用同一个 projectId 是真实存在的形状 —— 只比一半会认成
   * 第一个,于是显示的是**另一个池**的名字。
   */
  it('共用 projectId 的两个池按完整键区分', () => {
    expect(poolLabelOf(options, { projectId: 700, producerProjectId: 6 })).toBe('猫工作室 / B 池')
    expect(poolLabelOf(options, { projectId: 700, producerProjectId: 5 })).toBe('猫工作室 / A 池')
  })

  // 找不到时回 null,让调用方决定是省略这半句还是说「未知」—— 而不是在这里
  // 编一个可能过期的名字摆给用户。
  it('找不到回 null', () => {
    expect(poolLabelOf(options, { projectId: 999, producerProjectId: null })).toBeNull()
  })

  it('没选池回 null', () => {
    expect(poolLabelOf(options, null)).toBeNull()
  })
})
