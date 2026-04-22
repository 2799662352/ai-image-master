import { useRef, useState, useEffect, useCallback, useMemo } from 'react'
import { useTokenAutocomplete } from '../../components/shared/media-tokens/useTokenAutocomplete'
import TokenAutocomplete from '../../components/shared/media-tokens/TokenAutocomplete'
import MentionChips from '../../components/shared/media-tokens/MentionChips'
import type { MediaRef } from '../../components/shared/media-tokens/types'
import '../../components/shared/media-tokens/media-tokens.css'

interface RawRefImage {
  base64: string
  fileName: string
  mimeType: string
  id: number
  [key: string]: unknown
}

function getGeneratePageInstance(): any {
  const w = window as any
  return w.getGeneratePageTS?.() ?? w.generatePageTS ?? null
}

export function GenerateTokenBridge() {
  const [value, setValue] = useState('')
  const [rawImages, setRawImages] = useState<RawRefImage[]>([])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const textareaElRef = useRef<HTMLTextAreaElement | null>(null)
  const isProgrammaticRef = useRef(false)

  useEffect(() => {
    const el = document.getElementById('promptInput') as HTMLTextAreaElement | null
    if (el) {
      textareaElRef.current = el
      ;(textareaRef as any).current = el
      setValue(el.value)
    }
  }, [])

  useEffect(() => {
    const poll = setInterval(() => {
      const page = getGeneratePageInstance()
      if (!page) return
      const imgs: RawRefImage[] = page.getReferenceImages?.() ?? []
      setRawImages((prev) => {
        if (prev.length !== imgs.length) return [...imgs]
        const changed = imgs.some((img, i) => img.id !== prev[i]?.id)
        return changed ? [...imgs] : prev
      })
    }, 800)
    return () => clearInterval(poll)
  }, [])

  const mediaRefs: MediaRef[] = useMemo(
    () =>
      rawImages.map((img, i) => ({
        index: i + 1,
        type: 'image' as const,
        url: img.base64.startsWith('data:')
          ? img.base64
          : `data:${img.mimeType};base64,${img.base64}`,
        label: img.fileName || `图片${i + 1}`,
      })),
    [rawImages],
  )

  const handleValueChange = useCallback((newVal: string) => {
    setValue(newVal)
    const el = textareaElRef.current
    if (el && el.value !== newVal) {
      isProgrammaticRef.current = true
      el.value = newVal
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
  }, [])

  const {
    visible,
    suggestions,
    selectedIndex,
    position,
    handleChange: hookHandleChange,
    handleKeyDown: hookHandleKeyDown,
    handleClose,
    handleHover,
    selectToken,
  } = useTokenAutocomplete({
    mediaRefs,
    textareaRef,
    value,
    onValueChange: handleValueChange,
  })

  useEffect(() => {
    const el = textareaElRef.current
    if (!el) return

    const onNativeInput = () => {
      if (isProgrammaticRef.current) {
        isProgrammaticRef.current = false
        return
      }
      setValue(el.value)
      const syntheticEvent = {
        target: el,
      } as React.ChangeEvent<HTMLTextAreaElement>
      hookHandleChange(syntheticEvent)
    }

    const onNativeKeyDown = (e: KeyboardEvent) => {
      const syntheticEvent = {
        key: e.key,
        preventDefault: () => e.preventDefault(),
        stopPropagation: () => e.stopPropagation(),
      } as React.KeyboardEvent
      hookHandleKeyDown(syntheticEvent)
    }

    el.addEventListener('input', onNativeInput)
    el.addEventListener('keydown', onNativeKeyDown)
    return () => {
      el.removeEventListener('input', onNativeInput)
      el.removeEventListener('keydown', onNativeKeyDown)
    }
  }, [hookHandleChange, hookHandleKeyDown])

  return (
    <>
      <TokenAutocomplete
        visible={visible}
        suggestions={suggestions}
        selectedIndex={selectedIndex}
        position={position}
        theme="default"
        onSelect={selectToken}
        onClose={handleClose}
        onHover={handleHover}
      />
      <MentionChips
        value={value}
        mediaRefs={mediaRefs}
        theme="default"
        onValueChange={handleValueChange}
      />
    </>
  )
}
