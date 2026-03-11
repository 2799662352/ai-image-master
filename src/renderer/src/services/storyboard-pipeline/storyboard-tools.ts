import { charMergeSubAgent } from './storyboard-char-merge'
import { storyboardCodeVerify } from './storyboard-verify'

export function mergeCharactersFromJSON(
  anchorsJSON: string,
  spatialJSON: string,
  narrativeJSON: string,
): string {
  const anchors = JSON.parse(anchorsJSON).objs || []
  const spatialData = JSON.parse(spatialJSON).objs || []
  const narrativeData = JSON.parse(narrativeJSON).objs || []
  const merged = charMergeSubAgent(anchors, spatialData, narrativeData)
  return JSON.stringify({ objs: merged })
}

export function verifyStoryboardFromJSON(
  sceneJSON: string,
  objsJSON: string,
  seqJSON: string,
): string {
  const scene = JSON.parse(sceneJSON)
  const objs = JSON.parse(objsJSON).objs || []
  const seqData = JSON.parse(seqJSON)
  const seq = seqData.seq || []
  const cont = seqData.cont || ''
  const result = storyboardCodeVerify({ scene, objs, seq, cont, notes: '' })
  return JSON.stringify(result)
}
