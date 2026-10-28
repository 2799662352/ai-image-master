import { describe, expect, it } from 'vitest'

import {
  KLING_MAX_SHOTS,
  KLING_MAX_SHOT_PROMPT_LENGTH,
  addKlingShot,
  coerceKlingMultiShot,
  defaultKlingShots,
  fitKlingShotsToDuration,
  joinKlingShotPrompts,
  klingMultiShotEquals,
  klingMultiShotLabel,
  removeKlingShot,
  splitDuration,
  sumShotSeconds,
  validateKlingMultiShot,
  type KlingMultiShot,
} from '../klingMultiShot'

const customize = (...shots: Array<[string, number]>): KlingMultiShot => ({
  type: 'customize',
  shots: shots.map(([prompt, duration]) => ({ prompt, duration })),
})

describe('splitDuration / defaultKlingShots', () => {
  it('平分总时长,余数从前往后每份多 1 秒', () => {
    expect(splitDuration(10, 2)).toEqual([5, 5])
    expect(splitDuration(7, 2)).toEqual([4, 3])
    expect(splitDuration(8, 3)).toEqual([3, 3, 2])
  })

  it('份数多于总秒数时按秒数截断,每份至少 1 秒', () => {
    expect(splitDuration(3, 6)).toEqual([1, 1, 1])
  })

  it('新开自定义分镜 = 两个镜头平分、描述留空', () => {
    const shots = defaultKlingShots(5)
    expect(shots).toEqual([
      { prompt: '', duration: 3 },
      { prompt: '', duration: 2 },
    ])
    expect(sumShotSeconds(shots)).toBe(5)
  })
})

describe('fitKlingShotsToDuration', () => {
  it('已经对得上的原样返回同一个引用(调用方据此判断要不要写回)', () => {
    const shots = [
      { prompt: 'a', duration: 2 },
      { prompt: 'b', duration: 3 },
    ]
    expect(fitKlingShotsToDuration(shots, 5)).toBe(shots)
  })

  it('总时长变了:按比例缩放,描述保留,合计恰好等于总时长', () => {
    const fitted = fitKlingShotsToDuration(
      [
        { prompt: 'a', duration: 2 },
        { prompt: 'b', duration: 3 },
      ],
      10,
    )
    expect(fitted.map((s) => s.prompt)).toEqual(['a', 'b'])
    expect(sumShotSeconds(fitted)).toBe(10)
    expect(fitted.every((s) => Number.isInteger(s.duration) && s.duration >= 1)).toBe(true)
    // 4:6 —— 比例大体保持,尾差补在最后一镜。
    expect(fitted[0].duration).toBeLessThan(fitted[1].duration)
  })

  it('缩短时每镜至少 1 秒;镜头数超过总秒数时砍掉尾部多出来的镜头', () => {
    const fitted = fitKlingShotsToDuration(
      [
        { prompt: 'a', duration: 1 },
        { prompt: 'b', duration: 1 },
        { prompt: 'c', duration: 1 },
        { prompt: 'd', duration: 1 },
      ],
      3,
    )
    expect(fitted.map((s) => s.prompt)).toEqual(['a', 'b', 'c'])
    expect(fitted.map((s) => s.duration)).toEqual([1, 1, 1])
  })

  it('一个镜头占了绝大部分时长,缩短后仍每镜 ≥1 秒且合计对得上', () => {
    const fitted = fitKlingShotsToDuration(
      [
        { prompt: 'a', duration: 1 },
        { prompt: 'b', duration: 1 },
        { prompt: 'c', duration: 28 },
      ],
      4,
    )
    expect(sumShotSeconds(fitted)).toBe(4)
    expect(fitted.every((s) => s.duration >= 1)).toBe(true)
  })

  it('没有镜头时补出默认的两个', () => {
    expect(fitKlingShotsToDuration([], 6)).toEqual(defaultKlingShots(6))
  })
})

describe('validateKlingMultiShot', () => {
  it('单镜头(null / undefined)永远合法', () => {
    expect(validateKlingMultiShot(null, 5, '')).toBeNull()
    expect(validateKlingMultiShot(undefined, 5, '')).toBeNull()
  })

  it('智能分镜必须有总提示词(网关:multi_shot intelligence needs a prompt)', () => {
    expect(validateKlingMultiShot({ type: 'intelligence' }, 5, '  ')).toMatch(/智能分镜需要填写提示词/)
    expect(validateKlingMultiShot({ type: 'intelligence' }, 5, '一只猫')).toBeNull()
  })

  it('自定义分镜:总提示词可以空,以各镜头描述为准', () => {
    expect(validateKlingMultiShot(customize(['开场', 2], ['收尾', 3]), 5, '')).toBeNull()
  })

  it('最多 6 个镜头', () => {
    const shots = Array.from({ length: KLING_MAX_SHOTS + 1 }, (_, i): [string, number] => [`镜头${i}`, 1])
    expect(validateKlingMultiShot(customize(...shots), shots.length, '')).toMatch(/最多 6 个镜头/)
    const six = shots.slice(0, KLING_MAX_SHOTS)
    expect(validateKlingMultiShot(customize(...six), six.length, '')).toBeNull()
  })

  it('每个镜头描述不能为空、不能超过 512 字(按字符数,中文一字一个)', () => {
    expect(validateKlingMultiShot(customize(['  ', 5]), 5, '')).toMatch(/第 1 个镜头的描述不能为空/)
    const long = '镜'.repeat(KLING_MAX_SHOT_PROMPT_LENGTH + 1)
    expect(validateKlingMultiShot(customize(['ok', 2], [long, 3]), 5, '')).toMatch(/第 2 个镜头的描述不能超过 512 字/)
    expect(
      validateKlingMultiShot(customize(['镜'.repeat(KLING_MAX_SHOT_PROMPT_LENGTH), 5]), 5, ''),
    ).toBeNull()
  })

  it('每个镜头时长必须是不小于 1 的整数,且不超过总时长', () => {
    expect(validateKlingMultiShot(customize(['a', 0], ['b', 5]), 5, '')).toMatch(/第 1 个镜头的时长需为不小于 1 秒的整数/)
    expect(validateKlingMultiShot(customize(['a', 1.5], ['b', 3.5]), 5, '')).toMatch(/第 1 个镜头的时长需为/)
    expect(validateKlingMultiShot(customize(['a', 6]), 5, '')).toMatch(/第 1 个镜头的时长不能超过视频总时长 5 秒/)
  })

  it('各镜头时长之和必须等于总时长,并说明当前差多少', () => {
    expect(validateKlingMultiShot(customize(['a', 2], ['b', 2]), 5, '')).toMatch(
      /各镜头时长之和需等于视频总时长：当前 4 秒，视频总时长 5 秒/,
    )
  })

  it('总时长不是整数(智能时长 -1 / 缺省)时没法核对,明说', () => {
    expect(validateKlingMultiShot(customize(['a', 2]), -1, '')).toMatch(/需要先确定视频总时长/)
    expect(validateKlingMultiShot(customize(['a', 2]), Number.NaN, '')).toMatch(/需要先确定视频总时长/)
  })

  it('空镜头列表 → 至少 1 个', () => {
    expect(validateKlingMultiShot({ type: 'customize', shots: [] }, 5, '')).toMatch(/至少需要 1 个镜头/)
  })
})

describe('coerceKlingMultiShot', () => {
  it('认 type 与 mode 两种写法(模型常写混)', () => {
    expect(coerceKlingMultiShot({ type: 'intelligence' })).toEqual({ type: 'intelligence' })
    expect(coerceKlingMultiShot({ mode: 'intelligence' })).toEqual({ type: 'intelligence' })
    expect(coerceKlingMultiShot({ type: 'customize', shots: [{ prompt: 'a', duration: 2 }] })).toEqual({
      type: 'customize',
      shots: [{ prompt: 'a', duration: 2 }],
    })
  })

  it('off / single / null / 未知 / customize 没镜头 → null(单镜头)', () => {
    for (const raw of [null, undefined, false, 'off', { type: 'off' }, { type: 'single' }, { type: 'customize' }, { type: 'customize', shots: [] }, 42]) {
      expect(coerceKlingMultiShot(raw)).toBeNull()
    }
  })

  it('不裁镜头数、不改时长 —— 错值留给校验说明白;读不出的时长记 0 让校验指出是哪一镜', () => {
    const coerced = coerceKlingMultiShot({
      type: 'customize',
      shots: [{ prompt: 'a', duration: '3' }, { prompt: 7, duration: 'abc' }, null],
    })
    expect(coerced).toEqual({
      type: 'customize',
      shots: [
        { prompt: 'a', duration: 3 },
        { prompt: '', duration: 0 },
        { prompt: '', duration: 0 },
      ],
    })
  })
})

describe('addKlingShot / removeKlingShot —— 编辑器增删镜头时合计不变', () => {
  it('加镜头:新镜头 1 秒,从最长的镜头里借,合计不变', () => {
    const next = addKlingShot([
      { prompt: 'a', duration: 2 },
      { prompt: 'b', duration: 3 },
    ])
    expect(next).toEqual([
      { prompt: 'a', duration: 2 },
      { prompt: 'b', duration: 2 },
      { prompt: '', duration: 1 },
    ])
    expect(sumShotSeconds(next)).toBe(5)
  })

  it('没得借(每镜都只有 1 秒)时合计多 1 秒,由校验提示而不是悄悄改总时长', () => {
    const next = addKlingShot([
      { prompt: 'a', duration: 1 },
      { prompt: 'b', duration: 1 },
    ])
    expect(sumShotSeconds(next)).toBe(3)
  })

  it('已有 6 个镜头不再加,返回同一个引用', () => {
    const six = Array.from({ length: KLING_MAX_SHOTS }, () => ({ prompt: 'x', duration: 1 }))
    expect(addKlingShot(six)).toBe(six)
  })

  it('删镜头:时长并给前一个(删第一个时给后一个),合计不变,不改入参', () => {
    const shots = [
      { prompt: 'a', duration: 2 },
      { prompt: 'b', duration: 3 },
      { prompt: 'c', duration: 4 },
    ]
    expect(removeKlingShot(shots, 1)).toEqual([
      { prompt: 'a', duration: 5 },
      { prompt: 'c', duration: 4 },
    ])
    expect(removeKlingShot(shots, 0)).toEqual([
      { prompt: 'b', duration: 5 },
      { prompt: 'c', duration: 4 },
    ])
    expect(shots[0].duration).toBe(2)
  })

  it('只剩 1 个镜头时不删;越界下标不动', () => {
    const one = [{ prompt: 'a', duration: 5 }]
    expect(removeKlingShot(one, 0)).toBe(one)
    const two = [
      { prompt: 'a', duration: 2 },
      { prompt: 'b', duration: 3 },
    ]
    expect(removeKlingShot(two, 5)).toBe(two)
  })
})

describe('其它纯函数', () => {
  it('joinKlingShotPrompts:带序号和秒数的顶层提示词', () => {
    expect(joinKlingShotPrompts([
      { prompt: ' 开场 ', duration: 2 },
      { prompt: '收尾', duration: 3 },
    ])).toBe('镜头1（2秒）：开场\n镜头2（3秒）：收尾')
  })

  it('klingMultiShotEquals:深比较,null 与 undefined 等价', () => {
    expect(klingMultiShotEquals(null, undefined)).toBe(true)
    expect(klingMultiShotEquals({ type: 'intelligence' }, { type: 'intelligence' })).toBe(true)
    expect(klingMultiShotEquals({ type: 'intelligence' }, null)).toBe(false)
    expect(klingMultiShotEquals(customize(['a', 2]), customize(['a', 2]))).toBe(true)
    expect(klingMultiShotEquals(customize(['a', 2]), customize(['a', 3]))).toBe(false)
    expect(klingMultiShotEquals(customize(['a', 2]), { type: 'intelligence' })).toBe(false)
  })

  it('klingMultiShotLabel', () => {
    expect(klingMultiShotLabel(null)).toBe('单镜头')
    expect(klingMultiShotLabel({ type: 'intelligence' })).toBe('智能分镜')
    expect(klingMultiShotLabel(customize(['a', 1], ['b', 1]))).toBe('分镜 ×2')
  })
})
