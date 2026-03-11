export function charMergeSubAgent(
  anchors: Array<{ n: string; f: string; t: string }>,
  spatialData: any[],
  narrativeData: any[],
): any[] {
  const normalize = (s: string) => s.trim().toLowerCase()
  const stopWords = new Set(['the', 'a', 'an', 'and', 'of', 'in', 'on', 'at'])

  const fuzzyGet = (map: Map<string, any>, anchorKey: string) => {
    const exact = map.get(anchorKey)
    if (exact) return exact
    for (const [k, v] of map.entries()) {
      if (k.includes(anchorKey) || anchorKey.includes(k)) return v
    }
    const anchorWords = new Set(anchorKey.split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w)))
    for (const [k, v] of map.entries()) {
      const cWords = k.split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w))
      if (cWords.some(w => anchorWords.has(w))) return v
    }
    return null
  }

  const spatialMap = new Map(spatialData.map((o: any) => [normalize(o.n), o]))
  const narrativeMap = new Map(narrativeData.map((o: any) => [normalize(o.n), o]))

  return anchors.map(anchor => {
    const key = normalize(anchor.n)
    const sp = fuzzyGet(spatialMap, key) || {}
    const nr = fuzzyGet(narrativeMap, key) || {}
    return {
      n: anchor.n, f: anchor.f, t: anchor.t,
      s: sp.s || 'fg|center|Z1', p: sp.p || 'artic',
      a: sp.a || '', m: sp.m || '',
      act: nr.act || '', fx: nr.fx ?? null,
      motive: nr.motive || '', tc: nr.tc || '',
    }
  })
}
