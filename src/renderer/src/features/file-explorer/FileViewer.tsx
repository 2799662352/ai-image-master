import { useEffect, useMemo, useRef, useState } from 'react'
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { EditorView, keymap } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { useFileExplorerStore } from './store'
import { buildLangExtension } from './lang'
import type { FileTab } from './types'

export function FileViewer({ tab }: { tab: FileTab }) {
  const editorRef = useRef<ReactCodeMirrorRef>(null)
  const { saveActiveTab, setTabState } = useFileExplorerStore()
  const [langExt, setLangExt] = useState<Extension | null>(null)

  useEffect(() => {
    let cancelled = false
    void buildLangExtension(tab.path).then((ext) => {
      if (!cancelled) setLangExt(ext)
    })
    return () => {
      cancelled = true
    }
  }, [tab.path])

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
      ]),
      EditorView.lineWrapping,
    ]
    if (langExt) exts.push(langExt)
    return exts
  }, [langExt, saveActiveTab])

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
        onCreateEditor={(_view, state) => {
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
    </div>
  )
}
