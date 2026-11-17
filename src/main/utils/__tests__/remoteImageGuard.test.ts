/**
 * remoteImageGuard —— 主进程替渲染端抓远程图之前的地址检查。
 *
 * 渲染端的 CSP 挡得住 `<img src="http://内网/…">`,主进程的 `net.fetch` 不受 CSP 约束,
 * 所以交给主进程之前要先把指向本机 / 内网的地址挡掉。重点是「各种写法的内网地址都挡得住」:
 * 十进制 / 十六进制 / 省略段的 IPv4、IPv6 回环与映射地址、带账号密码的地址。
 */
import { describe, expect, it } from 'vitest'
import { checkRemoteImageUrl } from '../remoteImageGuard'

describe('checkRemoteImageUrl — 放行', () => {
  it.each([
    'https://example.com/a.png',
    'https://img.example.com:8443/a/b.jpg?x=1&y=2',
    'https://bucket-123.cos.ap-guangzhou.myqcloud.com/image-history/2026/11/17/a.png',
    'https://8.8.8.8/a.png', // 公网 IP 字面量
    'https://172.15.0.1/a.png', // 172.16/12 之外
    'https://172.32.0.1/a.png',
    'https://100.63.0.1/a.png', // CGNAT(100.64/10)之外
    'https://100.128.0.1/a.png',
    'https://192.169.0.1/a.png',
    'https://169.253.0.1/a.png',
  ])('%s', (url) => {
    const res = checkRemoteImageUrl(url)
    expect(res.ok).toBe(true)
  })
})

describe('checkRemoteImageUrl — 拒绝', () => {
  it.each([
    ['http://example.com/a.png', 'only https'],
    ['ftp://example.com/a.png', 'only https'],
    ['file:///C:/a.png', 'only https'],
    ['local-file:///C:/a.png', 'only https'],
    ['data:image/png;base64,AAAA', 'only https'],
    ['C:\\a.png', 'only https'], // 被解析成 `c:` 协议
    ['/etc/passwd', 'invalid url'],
    ['', 'empty url'],
    ['https://user:pw@example.com/a.png', 'credentials'],
    ['https://user@example.com/a.png', 'credentials'],
  ])('%s', (url, reason) => {
    const res = checkRemoteImageUrl(url)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toContain(reason)
  })

  it('本机 / 内网主机名', () => {
    for (const url of [
      'https://localhost/a.png',
      'https://LOCALHOST/a.png',
      'https://foo.localhost/a.png',
      'https://printer.local/a.png',
      'https://db.internal/a.png',
    ]) {
      expect(checkRemoteImageUrl(url).ok, url).toBe(false)
    }
  })

  it('IPv4 私网 / 回环 / 链路本地 / CGNAT / 保留段', () => {
    for (const url of [
      'https://127.0.0.1/a.png',
      'https://127.8.9.10/a.png',
      'https://0.0.0.0/a.png',
      'https://10.0.0.1/a.png',
      'https://10.255.255.255/a.png',
      'https://172.16.0.1/a.png',
      'https://172.31.255.255/a.png',
      'https://192.168.1.1/a.png',
      'https://169.254.169.254/latest/meta-data', // 云厂商元数据
      'https://100.64.0.1/a.png',
      'https://100.127.255.255/a.png',
      'https://224.0.0.1/a.png',
      'https://255.255.255.255/a.png',
    ]) {
      expect(checkRemoteImageUrl(url).ok, url).toBe(false)
    }
  })

  it('换写法也挡得住:十进制 / 十六进制 / 省略段 / 八进制', () => {
    // WHATWG URL 会把这些规整成点分十进制,检查看的是规整后的形态。
    for (const url of [
      'https://2130706433/a.png', // 127.0.0.1
      'https://0x7f000001/a.png',
      'https://127.1/a.png',
      'https://0177.0.0.1/a.png',
      'https://3232235777/a.png', // 192.168.1.1
    ]) {
      expect(checkRemoteImageUrl(url).ok, url).toBe(false)
    }
  })

  it('IPv6 回环 / 未指定 / 唯一本地 / 链路本地 / IPv4 映射', () => {
    for (const url of [
      'https://[::1]/a.png',
      'https://[::]/a.png',
      'https://[fc00::1]/a.png',
      'https://[fd12:3456::1]/a.png',
      'https://[fe80::1]/a.png',
      'https://[febf::1]/a.png',
      'https://[::ffff:127.0.0.1]/a.png',
      'https://[::ffff:10.0.0.1]/a.png',
    ]) {
      expect(checkRemoteImageUrl(url).ok, url).toBe(false)
    }
  })

  it('公网 IPv6 放行', () => {
    expect(checkRemoteImageUrl('https://[2606:4700:4700::1111]/a.png').ok).toBe(true)
  })

  it('不是字符串 → 拒绝而不是抛', () => {
    expect(checkRemoteImageUrl(undefined).ok).toBe(false)
    expect(checkRemoteImageUrl(null).ok).toBe(false)
    expect(checkRemoteImageUrl(42).ok).toBe(false)
  })
})
