import { useState, useRef, useMemo, useCallback } from 'react'
import type { MediaRef } from '../components/shared/media-tokens/types'
import { useTokenAutocomplete, TokenAutocomplete, MentionChips } from '../components/shared/media-tokens'
import { useAutosizeTextarea } from '../hooks/useAutosizeTextarea'
import { ReferenceImageList } from './generate/ReferenceImageList'
import { uploadRefImageOriginalFirst } from '../utils/refImageUpload'
import '../components/shared/media-tokens/media-tokens.css'

export default function DirectorPage() {
  const [prompt, setPrompt] = useState('')
  const [refs, setRefs] = useState<string[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [urlMode, setUrlMode] = useState(false)
  const [urlInput, setUrlInput] = useState('')
  const [busy, setBusy] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const mediaRefs = useMemo<MediaRef[]>(
    () => refs.map((url, i) => ({
      index: i + 1,
      type: 'image' as const,
      url,
      label: `图片${i + 1}`,
    })),
    [refs],
  )

  const ac = useTokenAutocomplete({
    mediaRefs,
    textareaRef,
    value: prompt,
    onValueChange: setPrompt,
  })
  useAutosizeTextarea(textareaRef, prompt, { minRows: 5, maxRows: 20 })

  // 原图直传 COS,存 URL(失败降级本地 base64);见 utils/refImageUpload。
  const ingestFiles = useCallback(async (files: File[]) => {
    const imgs = files.filter((f) => f.type.startsWith('image/'))
    if (imgs.length === 0) return
    setBusy(true)
    for (const file of imgs) {
      const outcome = await uploadRefImageOriginalFirst(file, {
        metadata: { source: 'director-ref-upload', fileName: file.name },
      })
      if (outcome.ok) setRefs((p) => [...p, outcome.src])
    }
    setBusy(false)
  }, [])

  const handleFileUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files
      e.target.value = ''
      if (files) void ingestFiles(Array.from(files))
    },
    [ingestFiles],
  )

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      setDragOver(false)
      if (busy) return
      const files = e.dataTransfer.files
      if (files?.length) void ingestFiles(Array.from(files))
    },
    [busy, ingestFiles],
  )

  /** 粘贴图片直链(按行 / 空白分隔多条),<img> 探活后存 URL。 */
  const addUrls = useCallback((raw: string) => {
    const urls = raw
      .split(/[\s\n]+/)
      .map((u) => u.trim())
      .filter((u) => /^https?:\/\//i.test(u))
    if (urls.length === 0) return
    setBusy(true)
    let pending = urls.length
    const done = () => {
      pending -= 1
      if (pending <= 0) {
        setBusy(false)
        setUrlInput('')
        setUrlMode(false)
      }
    }
    for (const url of urls) {
      const probe = new Image()
      const timer = setTimeout(() => {
        probe.onload = probe.onerror = null
        done()
      }, 15_000)
      probe.onload = () => {
        clearTimeout(timer)
        setRefs((p) => [...p, url])
        done()
      }
      probe.onerror = () => {
        clearTimeout(timer)
        done()
      }
      probe.src = url
    }
  }, [])

  const removeRef = useCallback((index: number) => {
    setRefs((p) => p.filter((_, i) => i !== index))
  }, [])

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <h1 className="text-2xl font-orbitron text-cyberpunk-yellow">Director — @参考图 Test</h1>
      <p className="text-sm text-zinc-500">上传参考图后在 textarea 中输入 @ 测试 autocomplete + chips</p>

      <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleFileUpload} />

      <div
        onDragOver={(e) => {
          e.preventDefault()
          if (!busy) setDragOver(true)
        }}
        onDragLeave={(e) => {
          e.preventDefault()
          setDragOver(false)
        }}
        onDrop={handleDrop}
        className={`rounded transition-colors ${
          dragOver ? 'ring-2 ring-cyberpunk-yellow bg-cyberpunk-yellow/5' : ''
        } ${busy ? 'opacity-60' : ''}`}
      >
        <ReferenceImageList
          images={refs}
          onRemove={removeRef}
          onAdd={() => fileInputRef.current?.click()}
        />
        {dragOver && (
          <p className="text-center text-[11px] font-mono uppercase tracking-wider text-cyberpunk-yellow py-1">
            松开以添加参考图
          </p>
        )}
      </div>

      <div className="space-y-2">
        <button
          type="button"
          onClick={() => setUrlMode((v) => !v)}
          className="text-[11px] font-mono uppercase tracking-wider text-zinc-500 hover:text-cyberpunk-yellow transition-colors"
        >
          {urlMode ? '× 收起链接' : '+ 粘贴图片链接'}
        </button>
        {urlMode && (
          <div className="flex gap-2">
            <input
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addUrls(urlInput)
              }}
              placeholder="https://… 图片直链(支持多条,空格 / 换行分隔)"
              disabled={busy}
              className="flex-1 px-3 py-2 bg-zinc-800 border-2 border-zinc-700 text-white placeholder-zinc-500 text-sm focus:outline-none focus:border-cyberpunk-yellow disabled:opacity-50"
            />
            <button
              type="button"
              onClick={() => addUrls(urlInput)}
              disabled={busy || !urlInput.trim()}
              className="px-4 py-2 border-2 border-zinc-700 bg-zinc-900 text-zinc-200 font-mono text-[11px] uppercase tracking-wider hover:border-cyberpunk-yellow hover:text-cyberpunk-yellow transition-colors disabled:opacity-50"
            >
              添加
            </button>
          </div>
        )}
      </div>

      <div className="relative">
        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={ac.handleChange}
          onKeyDown={ac.handleKeyDown}
          placeholder="输入提示词... 键入 @ 引用参考图"
          rows={5}
          className="w-full px-4 py-3 bg-zinc-800 border-2 border-zinc-700 text-white placeholder-zinc-500 focus:outline-none focus:border-cyberpunk-yellow resize-none transition-[height] duration-100"
        />
        <TokenAutocomplete
          visible={ac.visible}
          suggestions={ac.suggestions}
          selectedIndex={ac.selectedIndex}
          position={ac.position}
          theme="default"
          onSelect={ac.selectToken}
          onClose={ac.handleClose}
          onHover={ac.handleHover}
        />
        <MentionChips value={prompt} mediaRefs={mediaRefs} theme="default" onValueChange={setPrompt} />
      </div>
    </div>
  )
}
