import { useEffect, useMemo, useCallback } from 'react'
import { useToastStore, useTemplatesStore } from '../stores'
import { useTemplates } from '../hooks/useTemplates'
import type { Template } from '../hooks/useTemplates'

export default function PromptTemplatesPage() {
  const templatesSvc = useTemplates()
  const addToast = useToastStore((s) => s.addToast)

  const templates = useTemplatesStore((s) => s.templates)
  const searchQuery = useTemplatesStore((s) => s.searchQuery)
  const activeCategory = useTemplatesStore((s) => s.activeCategory)

  const { loadTemplates, setSearchQuery, setActiveCategory } = useTemplatesStore.getState()

  useEffect(() => {
    loadTemplates(templatesSvc)
  }, [])

  const categories = useMemo(
    () => ['all', ...new Set(templates.map((t) => t.category))],
    [templates]
  )

  const filtered = useMemo(() => {
    return templates.filter((t) => {
      const matchCategory = activeCategory === 'all' || t.category === activeCategory
      const matchSearch =
        !searchQuery ||
        t.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        t.prompt.toLowerCase().includes(searchQuery.toLowerCase())
      return matchCategory && matchSearch
    })
  }, [templates, activeCategory, searchQuery])

  const handleUse = useCallback(
    (template: Template) => {
      navigator.clipboard.writeText(template.prompt)
      addToast({ message: `"${template.name}" 已复制到剪贴板`, type: 'success' })
    },
    [addToast]
  )

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <h1 className="text-2xl font-orbitron text-cyberpunk-yellow">📝 提示词模板</h1>

      <input
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        placeholder="搜索模板..."
        className="w-full px-4 py-2 bg-zinc-800 border-2 border-zinc-700 text-white placeholder-zinc-500 focus:outline-none focus:border-cyberpunk-yellow"
      />

      <div className="flex flex-wrap gap-2">
        {categories.map((cat) => (
          <button
            key={cat}
            onClick={() => setActiveCategory(cat)}
            className={`px-3 py-1 text-sm border transition-colors ${
              activeCategory === cat
                ? 'border-cyberpunk-yellow text-cyberpunk-yellow bg-cyberpunk-yellow/10'
                : 'border-zinc-700 text-zinc-400 hover:border-zinc-500'
            }`}
          >
            {cat === 'all' ? '全部' : cat}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {filtered.map((t) => (
          <div
            key={t.id}
            className="bg-zinc-900 border-2 border-zinc-700 p-4 space-y-2 hover:border-zinc-500 transition-colors"
          >
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-white">{t.name}</h3>
              <span className="text-xs text-zinc-500 px-2 py-0.5 border border-zinc-700">{t.category}</span>
            </div>
            <p className="text-sm text-gray-400 line-clamp-3">{t.prompt}</p>
            {t.tags && (
              <div className="flex gap-1 flex-wrap">
                {t.tags.map((tag) => (
                  <span key={tag} className="text-xs text-zinc-500 bg-zinc-800 px-1.5 py-0.5">
                    #{tag}
                  </span>
                ))}
              </div>
            )}
            <button
              onClick={() => handleUse(t)}
              className="text-sm text-cyberpunk-yellow hover:underline"
            >
              使用此模板
            </button>
          </div>
        ))}
      </div>

      {filtered.length === 0 && (
        <div className="text-center py-12 text-zinc-600">没有找到匹配的模板</div>
      )}
    </div>
  )
}
