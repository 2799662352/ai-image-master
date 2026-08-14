// 正文裸路径的语法提取。判据照 VS Code Copilot Chat 的 filePathLinkifier.ts,
// 差异(要求扩展名像扩展名、行内代码走 mdast 不走正则)写在被测模块的注释里。
//
// 这一层只挑候选,不判定是不是文件 —— 那要问磁盘,在 usePathExists 里。

import { describe, expect, it } from 'vitest'
import { extractPathSpans, looksLikePath, chatPathHref, rawFromChatPathHref } from '../chatPathLinkify'

describe('looksLikePath', () => {
  it('带分隔符的收,即使没扩展名', () => {
    expect(looksLikePath('src/a.ts')).toBe(true)
    expect(looksLikePath('src/components')).toBe(true)
    expect(looksLikePath('D:\\proj\\x.md')).toBe(true)
    expect(looksLikePath('/home/me/notes.md')).toBe(true)
  })

  it('不带分隔符的必须像个文件名', () => {
    expect(looksLikePath('latest.yml')).toBe(true)
    expect(looksLikePath('package.json')).toBe(true)
    expect(looksLikePath('README')).toBe(false)
    expect(looksLikePath('然后')).toBe(false)
  })

  it('版本号不是路径 —— 聊天里它比路径还常见,不能每个都去 stat', () => {
    expect(looksLikePath('4.5.9')).toBe(false)
    expect(looksLikePath('v1.2')).toBe(false)
    expect(looksLikePath('127.0.0.1')).toBe(false)
  })

  it('已经是 URL 的交给别处', () => {
    expect(looksLikePath('https://example.com/a.png')).toBe(false)
    expect(looksLikePath('vscode://file/D:/a.ts')).toBe(false)
  })

  it('行号后缀不影响判定', () => {
    expect(looksLikePath('src/a.ts:42')).toBe(true)
    expect(looksLikePath('src/a.ts:42:7')).toBe(true)
    expect(looksLikePath('src/a.ts#L42')).toBe(true)
  })

  it('空串与超长串不收', () => {
    expect(looksLikePath('')).toBe(false)
    expect(looksLikePath(`${'a/'.repeat(200)}x.ts`)).toBe(false)
  })
})

describe('extractPathSpans', () => {
  it('从中文正文里挑出路径,不带走中文标点', () => {
    const text = '我改了 src/a.ts,顺手看了 latest.yml。'
    expect(extractPathSpans(text).map((s) => s.raw)).toEqual(['src/a.ts', 'latest.yml'])
  })

  it('结尾的英文句读不属于路径', () => {
    expect(extractPathSpans('see src/a.ts.').map((s) => s.raw)).toEqual(['src/a.ts'])
    expect(extractPathSpans('see src/a.ts, then').map((s) => s.raw)).toEqual(['src/a.ts'])
  })

  it('保留行号后缀,交给下游解析', () => {
    expect(extractPathSpans('崩在 src/a.ts:42 那行').map((s) => s.raw)).toEqual(['src/a.ts:42'])
  })

  it('span 的位置能把原文切回来', () => {
    const text = '改 src/a.ts 就好'
    const [span] = extractPathSpans(text)
    expect(text.slice(span.start, span.end)).toBe('src/a.ts')
  })

  it('普通句子里挑不出东西', () => {
    expect(extractPathSpans('这句话里没有任何路径')).toEqual([])
    expect(extractPathSpans('bumped to 4.5.9 today')).toEqual([])
  })

  it('括号与引号是边界,不会被吞进路径', () => {
    expect(extractPathSpans('(src/a.ts)').map((s) => s.raw)).toEqual(['src/a.ts'])
    expect(extractPathSpans('"src/a.ts"').map((s) => s.raw)).toEqual(['src/a.ts'])
  })
})

describe('哨兵 href', () => {
  it('编解码往返', () => {
    const raw = 'D:\\proj\\我的 文件.md:42'
    expect(rawFromChatPathHref(chatPathHref(raw))).toBe(raw)
  })

  it('不是哨兵的返回 null', () => {
    expect(rawFromChatPathHref('https://example.com')).toBeNull()
    expect(rawFromChatPathHref('file:///D:/a.ts')).toBeNull()
  })
})
