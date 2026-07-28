import { describe, expect, it } from 'vitest'
import {
  externalImageMaterialFromText,
  externalImageUrlFromText,
} from '../externalImageUrl'

/**
 * 从浏览器拖来的图 / 粘贴的一条图片地址要能变成素材。
 *
 * 关键取舍:**不按扩展名筛**。真实图床地址常常没有扩展名
 * (`https://pbs.twimg.com/media/xxx?format=jpg&name=orig`),按后缀判会把用户
 * 最想贴的那一类全挡在门外。
 */
describe('externalImageUrlFromText', () => {
  it('取出普通图片地址', () => {
    expect(externalImageUrlFromText('https://cdn.example.com/a.jpg'))
      .toBe('https://cdn.example.com/a.jpg')
  })

  it('没有扩展名的图床地址照样收', () => {
    const url = 'https://pbs.twimg.com/media/G2ktJBna8AAhgIg?format=jpg&name=orig'
    expect(externalImageUrlFromText(url)).toBe(url)
  })

  it('text/uri-list 的注释行跳过,取第一条真地址', () => {
    const uriList = '# comment line\r\nhttps://cdn.example.com/b.png\r\nhttps://cdn.example.com/c.png'
    expect(externalImageUrlFromText(uriList)).toBe('https://cdn.example.com/b.png')
  })

  it('前后空白不影响', () => {
    expect(externalImageUrlFromText('  https://cdn.example.com/d.webp  '))
      .toBe('https://cdn.example.com/d.webp')
  })

  it('非 http(s) 一律不收:本地路径 / data: / 纯文本 / 空', () => {
    expect(externalImageUrlFromText('D:\\pics\\cat.png')).toBeNull()
    expect(externalImageUrlFromText('data:image/png;base64,AAA')).toBeNull()
    expect(externalImageUrlFromText('随便一段说明文字')).toBeNull()
    expect(externalImageUrlFromText('')).toBeNull()
    expect(externalImageUrlFromText(undefined)).toBeNull()
  })

  it('带空格的一整句话不算地址(避免把说明文字当图收进来)', () => {
    expect(externalImageUrlFromText('看这张 https://cdn.example.com/e.jpg 不错')).toBeNull()
  })
})

describe('externalImageMaterialFromText', () => {
  it('用路径末段当素材名', () => {
    expect(externalImageMaterialFromText('https://cdn.example.com/shots/cat.jpg'))
      .toEqual({ name: 'cat.jpg', src: 'https://cdn.example.com/shots/cat.jpg' })
  })

  it('末段带查询串时只取路径部分', () => {
    const url = 'https://pbs.twimg.com/media/G2ktJBna8AAhgIg?format=jpg&name=orig'
    expect(externalImageMaterialFromText(url))
      .toEqual({ name: 'G2ktJBna8AAhgIg', src: url })
  })

  it('路径为空时退回主机名', () => {
    expect(externalImageMaterialFromText('https://cdn.example.com/'))
      .toEqual({ name: 'cdn.example.com', src: 'https://cdn.example.com/' })
  })

  it('取不出地址就返回 null', () => {
    expect(externalImageMaterialFromText('不是地址')).toBeNull()
  })
})
