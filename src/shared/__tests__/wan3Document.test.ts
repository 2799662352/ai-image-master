// 文档 / 网页链接槽的分类逻辑。没有手动 file/link 切换,全靠 pathname 后缀 ——
// 判据必须只看 pathname,否则一篇带 ?type=pdf 的普通文章会被误判成文档。

import { describe, expect, it } from 'vitest'
import {
  classifyWan3DocumentOrLink,
  displayNameFromUrl,
  documentOrLinkFromLocalUpload,
  documentOrLinkFromUrl,
  parseDocumentOrLink,
  serializeDocumentOrLink,
} from '../wan3Document'

describe('classifyWan3DocumentOrLink', () => {
  it('命中扩展名的是文档,大小写不敏感', () => {
    expect(classifyWan3DocumentOrLink('https://x/a.pdf')).toBe('file')
    expect(classifyWan3DocumentOrLink('https://x/a.PDF')).toBe('file')
    expect(classifyWan3DocumentOrLink('https://x/dir/分镜.docx')).toBe('file')
    expect(classifyWan3DocumentOrLink('https://x/a.numbers')).toBe('file')
  })

  it('query / hash 不参与判断', () => {
    expect(classifyWan3DocumentOrLink('https://x/a.pdf?token=abc#page=2')).toBe('file')
    // 反面:后缀在 query 里不算数,这是普通文章。
    expect(classifyWan3DocumentOrLink('https://news/article/123?type=pdf')).toBe('link')
  })

  it('其余 http(s) 一律是链接', () => {
    expect(classifyWan3DocumentOrLink('https://news.example.com/article/123')).toBe('link')
    expect(classifyWan3DocumentOrLink('https://x/page.html')).toBe('link')
    expect(classifyWan3DocumentOrLink('https://x/')).toBe('link')
  })

  it('非 http(s) 与空值返回 null(调用方据此不写入)', () => {
    expect(classifyWan3DocumentOrLink('')).toBeNull()
    expect(classifyWan3DocumentOrLink('   ')).toBeNull()
    expect(classifyWan3DocumentOrLink('D:\\a\\b.pdf')).toBeNull()
    expect(classifyWan3DocumentOrLink('data:application/pdf;base64,AAA')).toBeNull()
    expect(classifyWan3DocumentOrLink('asset://abc')).toBeNull()
    expect(classifyWan3DocumentOrLink('ftp://x/a.pdf')).toBeNull()
  })
})

describe('displayNameFromUrl', () => {
  it('取地址末段并解码', () => {
    expect(displayNameFromUrl('https://x/dir/a.pdf')).toBe('a.pdf')
    expect(displayNameFromUrl('https://x/%E5%88%86%E9%95%9C.docx')).toBe('分镜.docx')
  })

  it('没有末段时退回主机名', () => {
    expect(displayNameFromUrl('https://news.example.com/')).toBe('news.example.com')
  })
})

describe('documentOrLinkFromUrl', () => {
  it('文档地址', () => {
    expect(documentOrLinkFromUrl('https://x/s.pdf')).toEqual({
      type: 'file',
      url: 'https://x/s.pdf',
      displayName: 's.pdf',
    })
  })

  it('文章地址', () => {
    expect(documentOrLinkFromUrl('https://news/a/1')?.type).toBe('link')
  })

  it('不合法就是 null', () => {
    expect(documentOrLinkFromUrl('随便写的字')).toBeNull()
  })
})

describe('documentOrLinkFromLocalUpload', () => {
  it('本地上传恒为 file,不去猜 COS 地址的后缀', () => {
    // 对象键被改写成无扩展名也照样是文档 —— 上传的语义本来就是「我给你一份文档」。
    expect(documentOrLinkFromLocalUpload('分镜说明.docx', 'https://cos/x/abc123')).toEqual({
      type: 'file',
      url: 'https://cos/x/abc123',
      displayName: '分镜说明.docx',
    })
  })

  it('文件名为空时退回地址末段', () => {
    expect(documentOrLinkFromLocalUpload('   ', 'https://cos/x/a.pdf').displayName).toBe('a.pdf')
  })
})

describe('序列化往返', () => {
  it('存取一致', () => {
    const value = { type: 'file' as const, url: 'https://x/s.pdf', displayName: 's.pdf' }
    expect(parseDocumentOrLink(serializeDocumentOrLink(value))).toEqual(value)
  })

  it('空值 → 空串 → null', () => {
    expect(serializeDocumentOrLink(null)).toBe('')
    expect(parseDocumentOrLink('')).toBeNull()
    expect(parseDocumentOrLink(undefined)).toBeNull()
  })

  it('坏数据当没设置,不让一张卡因此打不开', () => {
    expect(parseDocumentOrLink('{ 不是 json')).toBeNull()
    expect(parseDocumentOrLink('{"type":"image","url":"https://x"}')).toBeNull()
    expect(parseDocumentOrLink('{"type":"file"}')).toBeNull()
  })
})
