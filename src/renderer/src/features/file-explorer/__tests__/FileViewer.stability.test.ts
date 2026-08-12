import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 编辑器**不得**在每次渲染时重配置。
 *
 * `@uiw/react-codemirror` 的重配置 effect 依赖数组里有 `extensions`、`basicSetup`、
 * `onUpdate`(useCodeMirror.ts:148)。这三样只要是内联字面量,每次渲染就是新引用,
 * 于是 `StateEffect.reconfigure` 把所有扩展连同视口/滚动插件整份重建。
 *
 * 而本组件**每敲一个字都会重渲染**(按键 → setTabState → store 变化 → ViewerHost
 * 重渲染 → 新的 tab 对象),所以"每次渲染重配置"实际就是"每次按键重配置"。用户
 * 看到的是:删字符时画面上下窜、光标乱跳。
 *
 * 为什么用源码断言这么笨的方式(同 viewersUseIpc 的理由):
 *  · jsdom 里 CodeMirror 不做真实布局,重配置**没有可观测的行为差异** —— 行为
 *    测试发现不了,只有装到真机上敲字才会暴露;
 *  · 这种回归是"顺手改一下 props"就会发生的,而 diff 上看起来完全无害。
 *
 * 真要改这几个 prop 的传法,先确认新写法的引用是稳定的,然后连这条测试一起改 ——
 * 而不是绕开。
 */
const SOURCE = readFileSync(path.join(__dirname, '..', 'FileViewer.tsx'), 'utf8')

describe('FileViewer 不在每次渲染时重配置编辑器', () => {
  it('basicSetup 不是内联对象', () => {
    expect(SOURCE).not.toMatch(/basicSetup=\{\{/)
    expect(SOURCE).toMatch(/basicSetup=\{BASIC_SETUP\}/)
  })

  it('extensions 不是内联数组(必须是 useMemo 出来的)', () => {
    expect(SOURCE).not.toMatch(/extensions=\{\[/)
    expect(SOURCE).toMatch(/const extensions = useMemo/)
  })

  it('不传 onUpdate prop —— 它在重配置依赖里,改走扩展内的 updateListener', () => {
    expect(SOURCE).not.toMatch(/\bonUpdate=/)
    expect(SOURCE).toMatch(/EditorView\.updateListener\.of/)
  })

  it('给编辑器显式高度,让 .cm-scroller 自己滚(不与外层滚动容器抢)', () => {
    expect(SOURCE).toMatch(/height=\{EDITOR_HEIGHT\}/)
  })
})
