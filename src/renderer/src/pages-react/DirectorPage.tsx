import { useState, useRef, useMemo, useCallback } from 'react'
import type { MediaRef } from '../components/shared/media-tokens/types'
import { useTokenAutocomplete, TokenAutocomplete, MentionChips } from '../components/shared/media-tokens'
import { useAutosizeTextarea } from '../hooks/useAutosizeTextarea'
import { ReferenceImageList } from './generate/ReferenceImageList'
import '../components/shared/media-tokens/media-tokens.css'

export default function DirectorPage() {
  const [prompt, setPrompt] = useState('')
  const [refs, setRefs] = useState<string[]>([])
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

  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files) return
    Array.from(files).forEach((file) => {
      const reader = new FileReader()
      reader.onload = () => {
        if (typeof reader.result === 'string') setRefs((p) => [...p, reader.result as string])
      }
      reader.readAsDataURL(file)
    })
  }, [])

  const removeRef = useCallback((index: number) => {
    setRefs((p) => p.filter((_, i) => i !== index))
  }, [])

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <h1 className="text-2xl font-orbitron text-cyberpunk-yellow">Director — @参考图 Test</h1>
      <p className="text-sm text-zinc-500">上传参考图后在 textarea 中输入 @ 测试 autocomplete + chips</p>

      <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleFileUpload} />
      <ReferenceImageList
        images={refs}
        onRemove={removeRef}
        onAdd={() => fileInputRef.current?.click()}
      />

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
