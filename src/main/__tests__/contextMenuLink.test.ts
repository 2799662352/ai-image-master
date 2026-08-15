// 右键菜单对链接给什么动作,取决于这个链接指向哪儿。
//
// 起因:聊天正文里的文件引用现在是真链接了(#240/#241),但主进程的
// `context-menu` 处理只看 `params.linkURL` 存不存在,不看它是什么 —— 于是对
// 一个 `D:\...\脚本.md` 也给出「在浏览器中打开」,点了当然没反应。
//
// 这里只做分类,菜单项由 index.ts 据此拼。分出来是为了能测:context-menu 回调
// 挂在 webContents 上,在单测里构造不出来。

import { describe, expect, it } from 'vitest'
import { classifyContextMenuLink } from '../contextMenuLink'

describe('classifyContextMenuLink · 本地文件', () => {
  it('认 file:// 绝对路径', () => {
    expect(classifyContextMenuLink('file:///D:/proj/a.md')).toEqual({
      kind: 'file',
      osPath: 'D:\\proj\\a.md',
    })
  })

  it('认 Codex 默认的 vscode://file 形态,并剥掉行号后缀', () => {
    // 带 `:42` 直接丢给「在文件夹中显示」会找不到文件 —— 那是个不存在的路径。
    expect(classifyContextMenuLink('vscode://file/D:/proj/src/a.ts:42')).toEqual({
      kind: 'file',
      osPath: 'D:\\proj\\src\\a.ts',
    })
  })

  it('认 GitHub 式 #L 锚点', () => {
    expect(classifyContextMenuLink('file:///home/me/a.ts#L12')).toEqual({
      kind: 'file',
      osPath: '/home/me/a.ts',
    })
  })

  it('中文路径的百分号编码要解开,否则资源管理器定位不到', () => {
    expect(classifyContextMenuLink('file:///D:/%E7%AC%AC28%E9%9B%86/x.md')).toEqual({
      kind: 'file',
      osPath: 'D:\\第28集\\x.md',
    })
  })

  it('POSIX 绝对路径保持正斜杠,不被 Windows 那套归一影响', () => {
    expect(classifyContextMenuLink('file:///home/me/notes.md')).toEqual({
      kind: 'file',
      osPath: '/home/me/notes.md',
    })
  })

})

describe('classifyContextMenuLink · 交回外部处理', () => {
  it.each(['https://example.com/x', 'http://example.com', 'mailto:a@b.com', 'tel:123'])(
    '%s 保持原来的「在浏览器中打开」行为',
    (url) => {
      expect(classifyContextMenuLink(url)).toEqual({ kind: 'web', url })
    },
  )

  it('相对路径不假装是文件 —— 到这里它已经被 Chromium 绝对化成 http URL 了', () => {
    expect(classifyContextMenuLink('src/a.ts')).toEqual({ kind: 'web', url: 'src/a.ts' })
    expect(classifyContextMenuLink('http://localhost:5173/src/a.ts')).toEqual({
      kind: 'web',
      url: 'http://localhost:5173/src/a.ts',
    })
  })

  it('空串不当成文件', () => {
    expect(classifyContextMenuLink('')).toEqual({ kind: 'web', url: '' })
  })
})
