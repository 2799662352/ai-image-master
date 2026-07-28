import { describe, expect, it } from 'vitest'
import { isTransferableMaterialSrc } from '../materialTransfer'

/**
 * 挂进工作台的外链图要转存成我们自己的地址。
 *
 * 根因不在渲染:`materialThumbTarget` 对图片素材直接返回 `src`,
 * `useResolvedMediaSrc` 对非本地路径原样透传,所以 `<img src="https://…">`
 * 是真挂上去的 —— 加载不出来是因为渲染端**直连第三方图床**,对方慢或不可达
 * (实测 pbs.twimg.com 在本机 curl 同样超时),`onError` 就退回文件名占位。
 *
 * 光修缩略图不够:提交生成时 `resolveMediaUrl` 对 http(s) 也是原样透传给上游,
 * 等于把「这张图能不能用」永久押在第三方服务器上。转存到 COS 之后两头都稳,
 * 而且走的是主进程那条已经带重试的抓取管道。
 */

const COS = 'https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/image-history/x.png'

describe('isTransferableMaterialSrc', () => {
  it('第三方 http(s) 图链要转存', () => {
    expect(isTransferableMaterialSrc('https://pbs.twimg.com/media/G2ktJBna8AAhgIg?format=jpg')).toBe(true)
    expect(isTransferableMaterialSrc('http://example.com/a.png')).toBe(true)
  })

  it('已经是我们自己的 COS 地址就不再转存 —— 否则每次挂载都白传一份', () => {
    expect(isTransferableMaterialSrc(COS)).toBe(false)
  })

  it('本地路径 / data: / blob: / asset:// 都不属于外链', () => {
    expect(isTransferableMaterialSrc('D:\\pics\\cat.png')).toBe(false)
    expect(isTransferableMaterialSrc('data:image/png;base64,AAA')).toBe(false)
    expect(isTransferableMaterialSrc('blob:app/abc')).toBe(false)
    expect(isTransferableMaterialSrc('asset://a1')).toBe(false)
    expect(isTransferableMaterialSrc('local-file:///D%3A/a.png')).toBe(false)
  })

  it('空值与非字符串一律不转存', () => {
    expect(isTransferableMaterialSrc('')).toBe(false)
    expect(isTransferableMaterialSrc('   ')).toBe(false)
    expect(isTransferableMaterialSrc(undefined as unknown as string)).toBe(false)
  })
})
