import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeTldrawLicenseKey, resolveTldrawLicenseKey, TLDRAW_LICENSE_FLAGS } from '../tldrawLicense'

describe('resolveTldrawLicenseKey', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('reads VITE_TLDRAW_LICENSE_KEY from the build environment', () => {
    vi.stubEnv('VITE_TLDRAW_LICENSE_KEY', 'tldraw-abc123')
    expect(resolveTldrawLicenseKey()).toBe('tldraw-abc123')
  })

  it('returns undefined when the variable is missing or blank (tldraw then behaves as today)', () => {
    vi.stubEnv('VITE_TLDRAW_LICENSE_KEY', '')
    expect(resolveTldrawLicenseKey()).toBeUndefined()
    expect(resolveTldrawLicenseKey(undefined)).toBeUndefined()
    expect(resolveTldrawLicenseKey('   ')).toBeUndefined()
  })

  it('strips whitespace, line breaks and zero-width characters from a pasted key', () => {
    expect(resolveTldrawLicenseKey(' tldraw-\u200Babc\r\n123 \n')).toBe('tldraw-abc123')
  })
})

describe('decodeTldrawLicenseKey', () => {
  // Payload = base64url(JSON.stringify(["id", ["*"], 16, "2030-01-02"])), signature irrelevant.
  const KEY = 'tldraw-2030-01-02/WyJpZCIsWyIqIl0sMTYsIjIwMzAtMDEtMDIiXQ.sig'

  it('decodes id / hosts / flags / expiry from the public payload', () => {
    expect(decodeTldrawLicenseKey(KEY)).toEqual({
      id: 'id',
      hosts: ['*'],
      flags: TLDRAW_LICENSE_FLAGS.EVALUATION_LICENSE,
      expiryDate: '2030-01-02',
      isEvaluation: true,
      hasWatermark: false,
    })
  })

  it('returns null for garbage', () => {
    expect(decodeTldrawLicenseKey('not-a-key')).toBeNull()
    expect(decodeTldrawLicenseKey('tldraw-x/!!!.sig')).toBeNull()
  })
})

/**
 * 到期闸。安装包 renderer 是 file:// + NODE_ENV=production，tldraw ≥ 5.3.2 把它当
 * 生产环境：key 一过期，画布打开 5 秒后就被卸载 —— evaluation key 还没有 30 天
 * 宽限。这条测试在到期前 14 天开始让 CI 变红，逼人换 key，而不是让用户先发现。
 * 换 key：把新 key 写进仓库根目录 `.env.production` 的 VITE_TLDRAW_LICENSE_KEY。
 */
describe('.env.production tldraw license key gate', () => {
  const RENEW_WINDOW_DAYS = 14
  const envPath = path.join(process.cwd(), '.env.production')
  const line = readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.startsWith('VITE_TLDRAW_LICENSE_KEY='))
  const key = resolveTldrawLicenseKey(line?.slice('VITE_TLDRAW_LICENSE_KEY='.length))
  const info = key ? decodeTldrawLicenseKey(key) : null

  it('has a decodable key that covers the packaged file:// origin', () => {
    expect(key, 'VITE_TLDRAW_LICENSE_KEY missing from .env.production').toBeTruthy()
    expect(info, 'VITE_TLDRAW_LICENSE_KEY payload is not decodable').not.toBeNull()
    // Electron renders from file:// (empty hostname): only `*` or a native
    // (href-regex) license can be valid there.
    const native = (info!.flags & TLDRAW_LICENSE_FLAGS.NATIVE_LICENSE) !== 0
    expect(info!.hosts.includes('*') || native, `hosts ${JSON.stringify(info!.hosts)} cannot match file://`).toBe(true)
  })

  it(`is valid for at least ${RENEW_WINDOW_DAYS} more days (renew before the packaged canvas goes dark)`, () => {
    const expiresAt = new Date(`${info!.expiryDate}T23:59:59Z`).getTime()
    const daysLeft = Math.floor((expiresAt - Date.now()) / 86_400_000)
    expect(
      daysLeft,
      `tldraw license ${info!.id} expires ${info!.expiryDate} (${daysLeft} days). ` +
        (info!.isEvaluation ? 'Evaluation keys have NO grace period: ' : '') +
        'get a commercial key at tldraw.dev and update VITE_TLDRAW_LICENSE_KEY in .env.production.',
    ).toBeGreaterThanOrEqual(RENEW_WINDOW_DAYS)
  })
})
