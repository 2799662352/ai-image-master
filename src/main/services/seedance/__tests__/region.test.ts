import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  getSeedanceBaseUrl,
  isSeedanceModelAvailable,
  listSeedanceModelAliases,
  resolveSeedanceBaseUrl,
  resolveSeedanceModelId,
  setSeedanceRegionMemory,
  SEEDANCE_MODEL_IDS_BY_REGION,
  SEEDANCE_REGION_BASE_URLS,
} from '../region'

/**
 * 2.5 的国内 ID 目前是**按 2.0 的对称规律推断**的（后缀完全一致），没有拿到
 * 国内站文档佐证 —— 所以国内区默认灰度关闭，开关翻开之前谁也点不到它。
 */
describe('Seedance 2.5 灰度', () => {
  const prev = process.env.SEEDANCE_CN_25

  beforeEach(() => {
    delete process.env.SEEDANCE_CN_25
    setSeedanceRegionMemory('global')
  })
  afterEach(() => {
    if (prev === undefined) delete process.env.SEEDANCE_CN_25
    else process.env.SEEDANCE_CN_25 = prev
    setSeedanceRegionMemory('global')
  })

  it('global 直接可用，ID 取自控制台模型下拉的 value', () => {
    expect(isSeedanceModelAvailable('2.5', 'global')).toBe(true)
    expect(resolveSeedanceModelId('2.5', 'global')).toBe('dreamina-seedance-2-5-260628')
  })

  it('cn 默认不可用，且不出现在可选列表里', () => {
    expect(isSeedanceModelAvailable('2.5', 'cn')).toBe(false)
    expect(listSeedanceModelAliases('cn')).not.toContain('2.5')
    expect(listSeedanceModelAliases('global')).toContain('2.5')
  })

  it('env SEEDANCE_CN_25=1 可在不发版的情况下开灰度', () => {
    process.env.SEEDANCE_CN_25 = '1'
    expect(isSeedanceModelAvailable('2.5', 'cn')).toBe(true)
    expect(listSeedanceModelAliases('cn')).toContain('2.5')
    expect(resolveSeedanceModelId('2.5', 'cn')).toBe('doubao-seedance-2-5-260628')
  })

  it('灰度不影响 2.0 家族，两个区都照常可用', () => {
    for (const region of ['global', 'cn'] as const) {
      for (const alias of ['2.0', '2.0-fast', '2.0-mini'] as const) {
        expect(isSeedanceModelAvailable(alias, region)).toBe(true)
      }
    }
  })
})

describe('resolveSeedanceBaseUrl', () => {
  const prevEnv = process.env.SEEDANCE_BASE_URL

  beforeEach(() => {
    delete process.env.SEEDANCE_BASE_URL
    setSeedanceRegionMemory('global')
  })

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.SEEDANCE_BASE_URL
    else process.env.SEEDANCE_BASE_URL = prevEnv
    setSeedanceRegionMemory('global')
  })

  it('默认 global → vvdance.ai', () => {
    expect(resolveSeedanceBaseUrl('global')).toBe('https://vvdance.ai')
    expect(getSeedanceBaseUrl()).toBe(SEEDANCE_REGION_BASE_URLS.global)
  })

  it('region=cn → yongmuai.com', () => {
    expect(resolveSeedanceBaseUrl('cn')).toBe('https://vvdance.yongmuai.com')
    setSeedanceRegionMemory('cn')
    expect(getSeedanceBaseUrl()).toBe(SEEDANCE_REGION_BASE_URLS.cn)
  })

  it('env SEEDANCE_BASE_URL 覆盖 region 预设，并剥末尾斜杠', () => {
    expect(resolveSeedanceBaseUrl('cn', 'https://custom.example/')).toBe('https://custom.example')
    process.env.SEEDANCE_BASE_URL = 'https://env.example/'
    setSeedanceRegionMemory('cn')
    expect(getSeedanceBaseUrl()).toBe('https://env.example')
  })
})

describe('resolveSeedanceModelId', () => {
  beforeEach(() => setSeedanceRegionMemory('global'))
  afterEach(() => setSeedanceRegionMemory('global'))

  it('global → dreamina-*', () => {
    expect(resolveSeedanceModelId('2.0', 'global')).toBe(
      'dreamina-seedance-2-0-260128',
    )
    expect(resolveSeedanceModelId('2.0-fast', 'global')).toBe(
      'dreamina-seedance-2-0-fast-260128',
    )
    expect(SEEDANCE_MODEL_IDS_BY_REGION.global['2.0']).toMatch(/^dreamina-/)
  })

  it('cn → doubao-*', () => {
    expect(resolveSeedanceModelId('2.0', 'cn')).toBe('doubao-seedance-2-0-260128')
    expect(resolveSeedanceModelId('2.0-fast', 'cn')).toBe(
      'doubao-seedance-2-0-fast-260128',
    )
  })

  it('2.0-mini（文档 9.2 最省档）双 region 映射', () => {
    expect(resolveSeedanceModelId('2.0-mini', 'global')).toBe(
      'dreamina-seedance-2-0-mini-260615',
    )
    expect(resolveSeedanceModelId('2.0-mini', 'cn')).toBe('doubao-seedance-2-0-mini-260615')
  })

  it('跟随内存 region（taskManager 提交路径）', () => {
    setSeedanceRegionMemory('cn')
    expect(resolveSeedanceModelId('2.0')).toBe('doubao-seedance-2-0-260128')
    setSeedanceRegionMemory('global')
    expect(resolveSeedanceModelId('2.0')).toBe('dreamina-seedance-2-0-260128')
  })
})
