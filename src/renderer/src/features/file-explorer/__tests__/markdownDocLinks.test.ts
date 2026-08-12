// Markdown 预览里的链接/图片目标解析。
//
// 与聊天栏那条 `osPathFromHref` 的分工:那边只认绝对路径、把 `..` 当遍历攻击挡掉
// (模型给的 href 不可信);这边是用户自己写的文档,相对路径与 `..` 都是正常写法,
// 必须按文档所在目录老实解析。真正的安全闸在主进程的 allowed-roots。

import { describe, expect, it } from 'vitest'
import { isDirectHref, resolveDocRelativePath } from '../markdownDocLinks'

const DOC = 'D:\\notes\\guide\\index.md'

describe('resolveDocRelativePath', () => {
  it('相对路径按文档所在目录解析', () => {
    expect(resolveDocRelativePath(DOC, './img/a.png')).toBe('D:\\notes\\guide\\img\\a.png')
    expect(resolveDocRelativePath(DOC, 'img/a.png')).toBe('D:\\notes\\guide\\img\\a.png')
  })

  it('`..` 是正常写法,不是攻击 —— 老实往上走', () => {
    expect(resolveDocRelativePath(DOC, '../assets/b.png')).toBe('D:\\notes\\assets\\b.png')
    expect(resolveDocRelativePath(DOC, '../../top.png')).toBe('D:\\top.png')
  })

  it('POSIX 文档保留前导斜杠(split 会把它吃掉,得补回来)', () => {
    expect(resolveDocRelativePath('/home/me/doc.md', './a.png')).toBe('/home/me/a.png')
  })

  it('绝对路径直接透传', () => {
    expect(resolveDocRelativePath(DOC, 'D:\\other\\c.png')).toBe('D:\\other\\c.png')
    expect(resolveDocRelativePath(DOC, 'file:///D:/other/c.png')).toBe('D:/other/c.png')
  })

  it('查询串与锚点不属于路径', () => {
    expect(resolveDocRelativePath(DOC, './a.png?v=2')).toBe('D:\\notes\\guide\\a.png')
    expect(resolveDocRelativePath(DOC, './doc.md#top')).toBe('D:\\notes\\guide\\doc.md')
  })

  it('百分号编码解开(中文文件名的常见形态)', () => {
    expect(resolveDocRelativePath(DOC, './%E5%9B%BE.png')).toBe('D:\\notes\\guide\\图.png')
  })

  it('非本地目标一律空串,交给调用方走直连/外部浏览器', () => {
    expect(resolveDocRelativePath(DOC, 'https://example.com/a.png')).toBe('')
    expect(resolveDocRelativePath(DOC, 'data:image/png;base64,AAA')).toBe('')
    expect(resolveDocRelativePath(DOC, 'blob:app/abc')).toBe('')
    expect(resolveDocRelativePath(DOC, '#section')).toBe('')
    expect(resolveDocRelativePath(DOC, '')).toBe('')
    expect(resolveDocRelativePath(DOC, undefined)).toBe('')
  })

  it('文档路径本身没有目录时不瞎猜', () => {
    expect(resolveDocRelativePath('index.md', './a.png')).toBe('')
  })
})

describe('isDirectHref', () => {
  it('渲染端能直接加载的 scheme', () => {
    expect(isDirectHref('https://x/a.png')).toBe(true)
    expect(isDirectHref('http://x/a.png')).toBe(true)
    expect(isDirectHref('data:image/png;base64,AAA')).toBe(true)
    expect(isDirectHref('blob:app/abc')).toBe(true)
  })

  it('磁盘路径不是', () => {
    expect(isDirectHref('D:\\a.png')).toBe(false)
    expect(isDirectHref('./a.png')).toBe(false)
  })
})
