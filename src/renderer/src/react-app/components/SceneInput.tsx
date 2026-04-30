import { useRef, useMemo } from 'react'
import { useDirectorStore } from '../stores/useDirectorStore'
import { useTokenAutocomplete } from '../../components/shared/media-tokens/useTokenAutocomplete'
import TokenAutocomplete from '../../components/shared/media-tokens/TokenAutocomplete'
import MentionChips from '../../components/shared/media-tokens/MentionChips'
import type { MediaRef } from '../../components/shared/media-tokens/types'
import '../../components/shared/media-tokens/media-tokens.css'
import { DirectorPromptHelperBar } from './DirectorPromptHelperBar'

export function SceneInput() {
  const sceneDescription = useDirectorStore((s) => s.sceneDescription)
  const setSceneDescription = useDirectorStore((s) => s.setSceneDescription)
  const referenceImages = useDirectorStore((s) => s.referenceImages)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const mediaRefs: MediaRef[] = useMemo(
    () =>
      referenceImages.map((img, i) => ({
        index: i + 1,
        type: 'image' as const,
        url: `data:${img.mimeType};base64,${img.data}`,
        label: img.name || `图片${i + 1}`,
      })),
    [referenceImages],
  )

  const {
    visible,
    suggestions,
    selectedIndex,
    position,
    handleChange,
    handleKeyDown,
    handleClose,
    handleHover,
    selectToken,
  } = useTokenAutocomplete({
    mediaRefs,
    textareaRef,
    value: sceneDescription,
    onValueChange: setSceneDescription,
  })

  return (
    <div className="bg-[#27272A] rounded-none p-4">
      <h3 className="text-white font-semibold flex items-center mb-3">
        <i className="fas fa-pen-fancy mr-2 text-purple-400" />
        场景描述
      </h3>
      <DirectorPromptHelperBar />
      <textarea
        ref={textareaRef}
        value={sceneDescription}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder="描述你想要的漫画场景…（可选）输入 @ 引用参考图"
        rows={4}
        className="w-full bg-[#09090B] border border-[#3F3F46] rounded-none px-3 py-2 text-sm text-white placeholder-white placeholder-opacity-30 resize-none focus:outline-none focus:border-purple-400 transition-colors"
      />
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
        value={sceneDescription}
        mediaRefs={mediaRefs}
        theme="default"
        onValueChange={setSceneDescription}
      />
    </div>
  )
}
