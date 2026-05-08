import { useEffect, useMemo, useRef, useState } from 'react'
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { EditorView, keymap } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { useFileExplorerStore } from './store'
import { buildLangExtension } from './lang'
import { serializeQuoteDrag } from './dragHelpers'
import { SelectionFloatingBar } from './SelectionFloatingBar'
import type { FileTab } from './types'
import { formatSelectionForChat } from './selectionToChat'

export function FileViewer({ tab }: { tab: FileTab }) {
  const editorRef = useRef<ReactCodeMirrorRef>(null)
  const { saveActiveTab, setTabState } = useFileExplorerStore()
  const [langExt, setLangExt] = useState<Extension | null>(null)
  const [view, setView] = useState<EditorView | null>(null)

  useEffect(() => {
    let cancelled = false
    void buildLangExtension(tab.path).then((ext) => {
      if (!cancelled) setLangExt(ext)
    })
    return () => {
      cancelled = true
    }
  }, [tab.path])

  const sendSelectionToChat = (editorView: EditorView): boolean => {
    const sel = editorView.state.selection.main
    if (sel.empty) return false
    const text = editorView.state.sliceDoc(sel.from, sel.to)
    const fromLine = editorView.state.doc.lineAt(sel.from).number
    const toLine = editorView.state.doc.lineAt(sel.to).number
    const quote = formatSelectionForChat({ path: tab.path, fromLine, toLine, text })
    useFileExplorerStore.getState().appendToChatInput(quote)
    return true
  }

  const selectionDragHandler = useMemo(
    () =>
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
    [tab.path],
  )

  const extensions = useMemo<Extension[]>(() => {
    const exts: Extension[] = [
      keymap.of([
        {
          key: 'Mod-s',
          run: () => {
            void saveActiveTab()
            return true
          },
        },
        {
          key: 'Mod-l',
          run: (editorView) => sendSelectionToChat(editorView),
        },
      ]),
      selectionDragHandler,
      EditorView.lineWrapping,
    ]
    if (langExt) exts.push(langExt)
    return exts
  }, [langExt, saveActiveTab, selectionDragHandler, tab.path])

  useEffect(() => {
    const view = editorRef.current?.view
    if (!view || !tab.state) return
    if (view.state !== tab.state) view.setState(tab.state)
  }, [tab.id, tab.state])

  return (
    <div
      className="h-full overflow-auto"
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
          event.preventDefault()
          void saveActiveTab()
        }
      }}
    >
      <CodeMirror
        ref={editorRef}
        value={tab.state ? tab.state.doc.toString() : tab.diskContent}
        onCreateEditor={(createdView, state) => {
          setView(createdView)
          if (!tab.state) setTabState(tab.id, state)
        }}
        onUpdate={(viewUpdate) => {
          if (viewUpdate.docChanged || viewUpdate.selectionSet) {
            setTabState(tab.id, viewUpdate.state)
          }
        }}
        extensions={extensions}
        theme="dark"
        basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: true }}
      />
      <SelectionFloatingBar view={view} onSend={() => view && sendSelectionToChat(view)} />
    </div>
  )
}
