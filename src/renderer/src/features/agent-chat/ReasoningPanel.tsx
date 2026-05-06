export function ReasoningPanel({ reasoning }: { reasoning: string }) {
  if (!reasoning.trim()) return null

  return (
    <details className="mb-3 rounded-xl border border-amber-300/20 bg-amber-300/5 p-3 text-xs text-amber-100/80">
      <summary className="cursor-pointer select-none font-semibold text-amber-200">Reasoning trace</summary>
      <p className="mt-2 whitespace-pre-wrap leading-relaxed">{reasoning}</p>
    </details>
  )
}
