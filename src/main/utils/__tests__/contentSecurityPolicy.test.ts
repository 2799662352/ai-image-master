import { describe, expect, it } from 'vitest'
import { buildContentSecurityPolicy } from '../contentSecurityPolicy'

function directives(): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const part of buildContentSecurityPolicy().split('; ')) {
    const [name, ...values] = part.split(' ')
    map.set(name, values)
  }
  return map
}

describe('buildContentSecurityPolicy', () => {
  it('connect-src 放行 http:(自定义网关可以是本机 / 局域网 / 公网明文地址)', () => {
    const connect = directives().get('connect-src')!
    expect(connect).toContain('http:')
    // https / wss 本来就有,不能因为加 http: 弄丢
    expect(connect).toContain('https:')
    expect(connect).toContain('wss:')
    expect(connect).toContain("'self'")
    expect(connect).toContain('blob:')
    expect(connect).toContain('data:')
    expect(connect).toContain('local-file:')
  })

  // 🚨 刻意没放开的两条:`main/utils/remoteImageGuard.ts` 的整套 SSRF 防护建立在
  // 「渲染端 <img> / <video> 加载不了 http://内网/…」之上。把 http: 加进这两条,
  // 注入的 markdown 图片就能直接去敲内网,而那边的注释依然写着「渲染端会挡」。
  it('img-src / media-src 不放行通配的 http:(只保留两台旧网关的固定 IP)', () => {
    for (const name of ['img-src', 'media-src']) {
      const sources = directives().get(name)!
      expect(sources, name).not.toContain('http:')
      expect(sources.filter((s) => s.startsWith('http://')).sort(), name).toEqual([
        'http://175.178.198.17:*',
        'http://43.161.233.87:*',
      ])
      expect(sources, name).toContain('https:')
    }
  })

  it('除 connect-src 外其余指令都没有通配 http:', () => {
    for (const [name, sources] of directives()) {
      if (name === 'connect-src') continue
      expect(sources, name).not.toContain('http:')
    }
  })

  it('其余指令保持原样', () => {
    const d = directives()
    expect(d.get('default-src')).toEqual(["'self'"])
    expect(d.get('script-src')).toEqual(["'self'", "'unsafe-inline'", "'unsafe-eval'", 'node:', 'https://cdn.jsdelivr.net'])
    expect(d.get('style-src')).toEqual(["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'])
    expect(d.get('font-src')).toEqual(["'self'", 'https://fonts.gstatic.com', 'https://cdn.tldraw.com', 'data:'])
    expect(d.get('worker-src')).toEqual(["'self'", 'blob:'])
    expect(d.get('frame-src')).toEqual(['https:'])
    expect([...d.keys()].sort()).toEqual(
      ['connect-src', 'default-src', 'font-src', 'frame-src', 'img-src', 'media-src', 'script-src', 'style-src', 'worker-src'],
    )
  })

  it('img-src 保留 file: / local-file: / blob: / data:(本地图、画布导出、内联图都靠它)', () => {
    const img = directives().get('img-src')!
    for (const s of ['file:', 'local-file:', 'blob:', 'data:', "'self'"]) expect(img).toContain(s)
  })
})
