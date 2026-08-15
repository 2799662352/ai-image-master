// 聊天栏文件引用解析。回归的根因见 fileCitation.ts 模块注释:
// Codex 的 file_opener 默认是 `vscode`,所以模型引用文件时到手的是
// `vscode://file/...:42`,而 react-markdown 的默认清洗器会把它抹成空 href ——
// 蓝色链接照样渲染,点下去静默无反应。

import { describe, expect, it } from 'vitest'
import { parseFileCitation } from '../fileCitation'

const WIN_ROOT = 'D:\\proj'
const POSIX_ROOT = '/home/me/proj'

describe('parseFileCitation · Codex 引用 URI', () => {
  it('认 vscode://file 带行列号(默认 file_opener)', () => {
    expect(parseFileCitation('vscode://file/D:/proj/src/a.ts:42:7')).toEqual({
      path: 'D:/proj/src/a.ts',
      line: 42,
      col: 7,
    })
  })

  it('只有行号时不编造列号', () => {
    expect(parseFileCitation('vscode://file/D:/proj/src/a.ts:42')).toEqual({
      path: 'D:/proj/src/a.ts',
      line: 42,
    })
  })

  it('没有行号时只给路径', () => {
    expect(parseFileCitation('vscode://file/D:/proj/src/a.ts')).toEqual({
      path: 'D:/proj/src/a.ts',
    })
  })

  it('认另外三种 file_opener scheme,用户改了配置也不瞎', () => {
    for (const scheme of ['cursor', 'windsurf', 'vscode-insiders']) {
      expect(parseFileCitation(`${scheme}://file/D:/proj/src/a.ts:9`)).toEqual({
        path: 'D:/proj/src/a.ts',
        line: 9,
      })
    }
  })

  it('POSIX 引用 URI 的前导斜杠是路径的一部分', () => {
    expect(parseFileCitation('vscode://file/home/me/a.ts:3')).toEqual({
      path: '/home/me/a.ts',
      line: 3,
    })
  })

  it('盘符前多一条斜杠的形态也认(file:/// 解码后的常见样子)', () => {
    expect(parseFileCitation('vscode://file//D:/proj/a.ts')).toEqual({ path: 'D:/proj/a.ts' })
  })
})

describe('parseFileCitation · 行号后缀从末尾认', () => {
  // VS Code 终端链接解析重构(microsoft/vscode#172930)的结论:先认后缀再回扫
  // 路径。按第一个冒号切会把 `D:/a.ts` 切成 `D`。
  it('Windows 盘符的冒号不会被当成行号', () => {
    expect(parseFileCitation('D:\\proj\\src\\a.ts')).toEqual({ path: 'D:\\proj\\src\\a.ts' })
    expect(parseFileCitation('D:/proj/src/a.ts')).toEqual({ path: 'D:/proj/src/a.ts' })
  })

  it('冒号后不是数字就不是行号后缀', () => {
    expect(parseFileCitation('D:\\proj\\a:b.ts')).toEqual({ path: 'D:\\proj\\a:b.ts' })
  })

  it('认 GitHub 式 #L 锚点', () => {
    expect(parseFileCitation('file:///D:/proj/a.ts#L42')).toEqual({
      path: 'D:/proj/a.ts',
      line: 42,
    })
  })

  it('#L 区间取起始行', () => {
    expect(parseFileCitation('file:///D:/proj/a.ts#L100-L110')).toEqual({
      path: 'D:/proj/a.ts',
      line: 100,
    })
  })

  it('非行号锚点当普通锚点丢掉,仍然打开文件', () => {
    expect(parseFileCitation('file:///D:/proj/a.md#some-heading')).toEqual({
      path: 'D:/proj/a.md',
    })
  })
})

describe('parseFileCitation · 既有形态不回归', () => {
  it('file:/// 与 local-file:/// 照旧', () => {
    expect(parseFileCitation('file:///C:/u/uploads/x.png')).toEqual({ path: 'C:/u/uploads/x.png' })
    expect(parseFileCitation('local-file:///C%3A/u/x.png')).toEqual({ path: 'C:/u/x.png' })
  })

  it('百分号编码的空格与中文解开', () => {
    expect(parseFileCitation('file:///C:/My%20Pics/a%20b.png')).toEqual({
      path: 'C:/My Pics/a b.png',
    })
    expect(parseFileCitation('file:///D:/proj/%E5%89%A7%E6%9C%AC.md')).toEqual({
      path: 'D:/proj/剧本.md',
    })
  })

  it('裸绝对路径照旧', () => {
    expect(parseFileCitation('/var/data/x.png')).toEqual({ path: '/var/data/x.png' })
  })

  it('非本地 scheme 返回 null,交回默认行为', () => {
    expect(parseFileCitation('https://example.com/x.png')).toBeNull()
    expect(parseFileCitation('http://example.com')).toBeNull()
    expect(parseFileCitation('data:image/png;base64,AAA')).toBeNull()
    expect(parseFileCitation('blob:abc')).toBeNull()
    expect(parseFileCitation('mailto:a@b.com')).toBeNull()
  })

  it('空值与纯锚点返回 null', () => {
    expect(parseFileCitation('')).toBeNull()
    expect(parseFileCitation('   ')).toBeNull()
    expect(parseFileCitation(undefined)).toBeNull()
    expect(parseFileCitation(null)).toBeNull()
    expect(parseFileCitation('#section')).toBeNull()
  })

  it('`..` 一律当遍历挡掉(href 是模型给的,不可信)', () => {
    expect(parseFileCitation('file:///C:/a/../../secret')).toBeNull()
    expect(parseFileCitation('/a/b/../../../etc/passwd')).toBeNull()
    expect(parseFileCitation('../outside.ts', { workspaceRoot: WIN_ROOT })).toBeNull()
    expect(parseFileCitation('vscode://file/D:/proj/../secret.txt')).toBeNull()
  })
})

describe('parseFileCitation · 工作区相对路径', () => {
  it('相对路径以工作区根为基准', () => {
    expect(parseFileCitation('src/a.ts', { workspaceRoot: WIN_ROOT })).toEqual({
      path: 'D:\\proj\\src\\a.ts',
    })
    expect(parseFileCitation('./src/a.ts', { workspaceRoot: WIN_ROOT })).toEqual({
      path: 'D:\\proj\\src\\a.ts',
    })
  })

  it('相对路径带行号', () => {
    expect(parseFileCitation('src/a.ts:12', { workspaceRoot: WIN_ROOT })).toEqual({
      path: 'D:\\proj\\src\\a.ts',
      line: 12,
    })
    expect(parseFileCitation('src/a.ts#L12', { workspaceRoot: WIN_ROOT })).toEqual({
      path: 'D:\\proj\\src\\a.ts',
      line: 12,
    })
  })

  it('拼接跟随工作区根的分隔符风格', () => {
    expect(parseFileCitation('src/a.ts', { workspaceRoot: POSIX_ROOT })).toEqual({
      path: '/home/me/proj/src/a.ts',
    })
  })

  it('Windows 工作区下前导斜杠 = 工作区根(对齐 VS Code markdown 语义)', () => {
    expect(parseFileCitation('/src/a.ts', { workspaceRoot: WIN_ROOT })).toEqual({
      path: 'D:\\proj\\src\\a.ts',
    })
  })

  it('POSIX 主机上前导斜杠仍是绝对路径,不当成工作区相对', () => {
    expect(parseFileCitation('/src/a.ts', { workspaceRoot: POSIX_ROOT })).toEqual({
      path: '/src/a.ts',
    })
  })

  it('没有工作区根时相对路径解析不出来', () => {
    expect(parseFileCitation('src/a.ts')).toBeNull()
    expect(parseFileCitation('src/a.ts', { workspaceRoot: null })).toBeNull()
  })

  it('绝对路径不受工作区根影响', () => {
    expect(parseFileCitation('C:\\other\\a.ts', { workspaceRoot: WIN_ROOT })).toEqual({
      path: 'C:\\other\\a.ts',
    })
  })
})
