import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  getSeedanceBaseUrl,
  resolveSeedanceBaseUrl,
  resolveSeedanceModelId,
  setSeedanceRegionMemory,
  SEEDANCE_MODEL_IDS_BY_REGION,
  SEEDANCE_REGION_BASE_URLS,
} from '../region'

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

  it('跟随内存 region（taskManager 提交路径）', () => {
    setSeedanceRegionMemory('cn')
    expect(resolveSeedanceModelId('2.0')).toBe('doubao-seedance-2-0-260128')
    setSeedanceRegionMemory('global')
    expect(resolveSeedanceModelId('2.0')).toBe('dreamina-seedance-2-0-260128')
  })
})
