import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import CodeMirror, { type BasicSetupOptions, type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { EditorView, keymap } from '@codemirror/view'
import { Prec, type EditorState, type Extension } from '@codemirror/state'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { useFileExplorerStore } from './store'
import { buildLangExtension } from './lang'
import { serializeQuoteDrag } from './dragHelpers'
import { SelectionFloatingBar } from './SelectionFloatingBar'
import { MarkdownPreview } from './MarkdownPreview'
import { collectPreviewAnchors, lineForPreviewTop, previewTopForLine } from './markdownScrollSync'
import type { FileTab } from './types'
import { formatSelectionForChat } from './selectionToChat'

/**
 * `basicSetup` 与扩展数组**必须是稳定引用**。
 *
 * `@uiw/react-codemirror` 的重配置 effect 依赖数组里就有 `basicSetup` / `extensions` /
 * `onUpdate`(见 useCodeMirror.ts),任意一个换了引用就 `StateEffect.reconfigure`
 * 整个编辑器。此前这三样全是内联字面量,而每敲一个字都会 setTabState → 全量订阅的
 * store 变化 → 本组件重渲染 → 三个新引用 → **每一次按键都把所有扩展连同视口/滚动
 * 插件重建一遍**。表现就是删字符时画面上下窜、光标乱跳。
 *
 * 所以:能提到模块级的提到模块级,提不动的用 useMemo 钉死依赖,`onUpdate` 干脆不走
 * prop —— 改成扩展里的 updateListener,它就不在那个依赖数组里了。
 */
const BASIC_SETUP: BasicSetupOptions = {
  lineNumbers: true,
  foldGutter: true,
  highlightActiveLine: true,
}

/**
 * Markdown 着色。
 *
 * 底色是 oneDark(@uiw 的 `theme="dark"`),但它按通用 `tags.heading` 一档处理,
 * 六级标题、加粗、链接、行内代码在暗色下几乎糊成一片 —— 这就是"md 没有颜色区分"。
 * 这里按 markdown 的具体 tag 补一层。
 *
 * **刻意不改字号**。把标题在编辑器里放大很好看,但行高跟着变,光标上下移动时
 * 视口要重新测量,又会引入抖动 —— 而抖动正是这次要修的东西。VS Code 的编辑器
 * 也只给 markdown 上色、不缩放字号,预览那边才做排版。
 *
 * 色值对齐 VS Code Dark+ 的 markdown 配色(标记紫、标题浅蓝、URL 亮蓝带下划线、
 * 行内代码橙、引用绿),而不是自己另造一套 —— 那套配色是大多数人每天在看的,
 * 换一套只会让人觉得"哪里不对"。`processingInstruction` 就是 `#`、`**`、`>`、
 * 反引号这些标记本身,单独给紫色,层次一眼可见。
 */
const MARKDOWN_HIGHLIGHT = HighlightStyle.define([
  { tag: tags.processingInstruction, color: '#c586c0' },
  { tag: [tags.heading1, tags.heading2], color: '#9cdcfe', fontWeight: '700' },
  { tag: [tags.heading3, tags.heading4, tags.heading5, tags.heading6], color: '#9cdcfe', fontWeight: '600' },
  { tag: tags.strong, color: '#569cd6', fontWeight: '700' },
  { tag: tags.emphasis, color: '#569cd6', fontStyle: 'italic' },
  { tag: tags.strikethrough, color: '#808080', textDecoration: 'line-through' },
  { tag: tags.link, color: '#9cdcfe' },
  { tag: tags.url, color: '#4fc1ff', textDecoration: 'underline' },
  { tag: tags.monospace, color: '#ce9178' },
  { tag: tags.quote, color: '#6a9955', fontStyle: 'italic' },
  { tag: [tags.list, tags.contentSeparator], color: '#6796e6' },
])

/**
 * 优先级必须抬高。`@uiw` 把我们的 `extensions` **拼在默认扩展之后**,而 CM6 里
 * 越靠前优先级越高 —— 不抬的话每个 tag 都先被 oneDark 认领,这层永远不生效。
 */
const MARKDOWN_COLORS = Prec.high(syntaxHighlighting(MARKDOWN_HIGHLIGHT))

/** 编辑器自己滚。外层再套一个 overflow 容器会和 `.cm-scroller` 抢滚动。 */
const EDITOR_HEIGHT = '100%'

type MdViewMode = 'edit' | 'split' | 'preview'

const MD_MODES: readonly { value: MdViewMode; label: string; title: string }[] = [
  { value: 'edit', label: '源码', title: '只看 markdown 源码' },
  { value: 'split', label: '分栏', title: '左边编辑,右边预览,滚动互相跟随' },
  { value: 'preview', label: '预览', title: '只看渲染结果' },
]

/**
 * 每个文件记住上次的视图模式(会话内)。放模块级而不是 store:它是纯界面偏好,
 * 进 store 就会跟着卡片状态一起进撤销栈和持久化,而没人想"撤销一次切预览"。
 */
const modeByPath = new Map<string, MdViewMode>()

function isMarkdownPath(p: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(p)
}

export function FileViewer({ tab }: { tab: FileTab }) {
  const editorRef = useRef<ReactCodeMirrorRef>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const [langExt, setLangExt] = useState<Extension | null>(null)
  const [view, setView] = useState<EditorView | null>(null)

  const isMarkdown = isMarkdownPath(tab.path)
  const [mode, setMode] = useState<MdViewMode>(() => modeByPath.get(tab.path) ?? 'edit')
  const effectiveMode: MdViewMode = isMarkdown ? mode : 'edit'

  /**
   * 初始文档只在挂载时取一次。`value` 是受控 prop,但 @uiw 的取值 effect 依赖
   * `[value, view]` —— 冻住它就再也不会触发"整份替换文档"那条路,同时省掉每次
   * 渲染都 `doc.toString()`(大文件时这一下就是几毫秒,而它每敲一个字都会跑)。
   *
   * 换标签页由 ActiveViewer 的 `key={tab.id}` 重挂载来处理,不靠这个 prop。
   */
  const [initialDoc] = useState(() => (tab.state ? tab.state.doc.toString() : tab.diskContent))

  useEffect(() => {
    let cancelled = false
    void buildLangExtension(tab.path).then((ext) => {
      if (!cancelled) setLangExt(ext)
    })
    return () => {
      cancelled = true
    }
  }, [tab.path])

  const sendSelectionToChat = useCallback(
    (editorView: EditorView): boolean => {
      const sel = editorView.state.selection.main
      if (sel.empty) return false
      const text = editorView.state.sliceDoc(sel.from, sel.to)
      const fromLine = editorView.state.doc.lineAt(sel.from).number
      const toLine = editorView.state.doc.lineAt(sel.to).number
      const quote = formatSelectionForChat({ path: tab.path, fromLine, toLine, text })
      useFileExplorerStore.getState().appendToChatInput(quote)
      return true
    },
    [tab.path],
  )

  /**
   * 依赖只有 `tab.id` / `tab.path` / `langExt` / `isMarkdown` —— 全都只在换文件时变。
   * store 的 action 一律经 `getState()` 现取,不进依赖:订阅它们等于把整个 store 的
   * 变化(包括本编辑器自己每次按键写回的 tab state)引进来。
   */
  const extensions = useMemo<Extension[]>(() => {
    const tabId = tab.id
    const exts: Extension[] = [
      keymap.of([
        {
          key: 'Mod-s',
          run: () => {
            void useFileExplorerStore.getState().saveActiveTab()
            return true
          },
        },
        { key: 'Mod-l', run: (editorView) => sendSelectionToChat(editorView) },
      ]),
      EditorView.domEventHandlers({
        dragstart: (event, editorView) => {
          const sel = editorView.state.selection.main
          if (sel.empty) return false
          const text = editorView.state.sliceDoc(sel.from, sel.to)
          const fromLine = editorView.state.doc.lineAt(sel.from).number
          const toLine = editorView.state.doc.lineAt(sel.to).number
          const quote = formatSelectionForChat({ path: tab.path, fromLine, toLine, text })
          if (event.dataTransfer) serializeQuoteDrag(event.dataTransfer, quote)
          return false
        },
      }),
      EditorView.updateListener.of((viewUpdate) => {
        if (viewUpdate.docChanged || viewUpdate.selectionSet) {
          useFileExplorerStore.getState().setTabState(tabId, viewUpdate.state)
        }
      }),
      EditorView.lineWrapping,
    ]
    if (langExt) exts.push(langExt)
    if (isMarkdown) exts.push(MARKDOWN_COLORS)
    return exts
  }, [tab.id, tab.path, langExt, isMarkdown, sendSelectionToChat])

  /**
   * 外部替换内容(冲突解决、磁盘被别人改)时把文档换掉。
   *
   * store 在那几条路径上会把 `state` 置空,这里以此为信号 —— 而**不是**每次
   * `tab.state` 变就 `view.setState(...)`。上一版就是后者:setState 重建整个视图
   * 状态,滚动位置一起被扔掉,于是打字打到一半画面自己跳回去。
   */
  const externalResetDone = useRef(false)
  useEffect(() => {
    const editorView = editorRef.current?.view
    if (!editorView) return
    if (tab.state !== null) {
      externalResetDone.current = false
      return
    }
    if (externalResetDone.current) return
    externalResetDone.current = true
    const current = editorView.state.doc.toString()
    if (current === tab.diskContent) return
    editorView.dispatch({
      changes: { from: 0, to: editorView.state.doc.length, insert: tab.diskContent },
    })
  }, [tab.state, tab.diskContent])

  const changeMode = useCallback(
    (next: MdViewMode) => {
      modeByPath.set(tab.path, next)
      setMode(next)
    },
    [tab.path],
  )

  // 预览源文本。只在预览可见时才 toString —— 纯编辑模式下没人要看它。
  const liveDoc = useMemo(() => {
    if (effectiveMode === 'edit') return ''
    return tab.state ? tab.state.doc.toString() : tab.diskContent
  }, [effectiveMode, tab.state, tab.diskContent])
  /**
   * 预览用「延后值」渲染:react-markdown 每次都整份重解析,分栏模式下逐字符
   * 重解析会把输入卡住。useDeferredValue 让打字保持在高优先级,预览自己追上来 ——
   * 与 VS Code 给预览做防抖是同一个目的,但不需要自己管定时器。
   */
  const previewDoc = useDeferredValue(liveDoc)

  // 滚动同步。只在分栏时挂;锚点在处理函数里现采,所以文档变了不必重挂监听。
  useEffect(() => {
    const preview = previewRef.current
    if (effectiveMode !== 'split' || !view || !preview) return

    let driver: 'editor' | 'preview' | null = null
    let releaseTimer: ReturnType<typeof setTimeout> | undefined
    // 「谁在开车」闸:程序化滚动会反过来触发对面的 scroll 事件,不挡就是死循环。
    const hold = (who: 'editor' | 'preview') => {
      driver = who
      clearTimeout(releaseTimer)
      releaseTimer = setTimeout(() => {
        driver = null
      }, 150)
    }

    const onEditorScroll = () => {
      if (driver === 'preview') return
      hold('editor')
      const rect = view.scrollDOM.getBoundingClientRect()
      // 视口左上角那一点对应的源码位置。用坐标而不是 scrollTop 换算,免得自己
      // 重算 CM 的内边距/行高,那笔账 CM 已经算过了。
      const pos = view.posAtCoords({ x: rect.left + 4, y: rect.top + 4 })
      if (pos === null) return
      const line = view.state.doc.lineAt(pos).number
      preview.scrollTop = previewTopForLine(collectPreviewAnchors(preview), line)
    }

    const onPreviewScroll = () => {
      if (driver === 'editor') return
      hold('preview')
      const line = lineForPreviewTop(collectPreviewAnchors(preview), preview.scrollTop)
      const clamped = Math.min(Math.max(line, 1), view.state.doc.lines)
      view.dispatch({ effects: EditorView.scrollIntoView(view.state.doc.line(clamped).from, { y: 'start' }) })
    }

    view.scrollDOM.addEventListener('scroll', onEditorScroll, { passive: true })
    preview.addEventListener('scroll', onPreviewScroll, { passive: true })
    return () => {
      clearTimeout(releaseTimer)
      view.scrollDOM.removeEventListener('scroll', onEditorScroll)
      preview.removeEventListener('scroll', onPreviewScroll)
    }
  }, [effectiveMode, view])

  const showEditor = effectiveMode !== 'preview'
  const showPreview = effectiveMode !== 'edit'

  /**
   * 纯预览时编辑器是 `display:none`,量不到尺寸;切回来必须让它重新测量,否则
   * 视口高度还留着 0,滚动条和光标定位全是错的(CM 的布局是自己算的,不靠回流)。
   */
  useEffect(() => {
    if (showEditor) view?.requestMeasure()
  }, [showEditor, view])

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
          event.preventDefault()
          void useFileExplorerStore.getState().saveActiveTab()
        }
      }}
    >
      {isMarkdown && (
        <div className="flex shrink-0 items-center justify-end gap-1 border-b border-cyan-500/10 bg-black/30 px-2 py-1">
          <div className="flex overflow-hidden rounded border border-cyan-500/20" role="group" aria-label="Markdown 视图">
            {MD_MODES.map((m) => (
              <button
                key={m.value}
                type="button"
                title={m.title}
                aria-pressed={mode === m.value}
                onClick={() => changeMode(m.value)}
                className={
                  'px-2 py-0.5 text-[11px] transition ' +
                  (mode === m.value
                    ? 'bg-cyan-500/20 text-cyan-100'
                    : 'text-cyan-200/50 hover:bg-cyan-500/10 hover:text-cyan-100')
                }
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* overflow-hidden 而不是 auto:滚动归 CodeMirror 自己的 .cm-scroller,
            外面再开一个滚动容器,两者会为同一次 scrollIntoView 打架。 */}
        <div className={`h-full min-w-0 overflow-hidden ${showEditor ? 'flex-1' : 'hidden'}`}>
          <CodeMirror
            ref={editorRef}
            value={initialDoc}
            height={EDITOR_HEIGHT}
            onCreateEditor={(createdView, state) => {
              setView(createdView)
              // 回到这个标签页时把上次的光标/选区/撤销栈一起恢复(state 里都带着)。
              if (tab.state) {
                if (createdView.state !== tab.state) createdView.setState(tab.state)
              } else {
                useFileExplorerStore.getState().setTabState(tab.id, state)
              }
            }}
            extensions={extensions}
            theme="dark"
            basicSetup={BASIC_SETUP}
          />
        </div>

        {showPreview && (
          <div
            ref={previewRef}
            data-testid="fx-md-preview-pane"
            className={`min-w-0 flex-1 overflow-auto bg-[#0b0d0f] ${showEditor ? 'border-l border-cyan-500/10' : ''}`}
          >
            <MarkdownPreview source={previewDoc} docPath={tab.path} />
          </div>
        )}
      </div>

      <SelectionFloatingBar view={view} onSend={() => view && sendSelectionToChat(view)} />
    </div>
  )
}
