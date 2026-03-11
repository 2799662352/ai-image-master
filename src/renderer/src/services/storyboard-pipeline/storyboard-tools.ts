import { tool } from '@langchain/core/tools'
import { z } from 'zod'
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

export const mergeCharactersTool = tool(
  async ({ anchorsFile, spatialFile, narrativeFile }) => {
    return mergeCharactersFromJSON(anchorsFile, spatialFile, narrativeFile)
  },
  {
    name: 'merge_characters',
    description: 'Merge character identity, spatial, and narrative data from 3 JSON strings into unified character list with 11 fields. Call after all 3 character analysis subagents complete.',
    schema: z.object({
      anchorsFile: z.string().describe('JSON string from char-identity subagent: { objs: [{n,f,t}] }'),
      spatialFile: z.string().describe('JSON string from char-spatial subagent: { objs: [{n,s,p,a,m}] }'),
      narrativeFile: z.string().describe('JSON string from char-narrative subagent: { objs: [{n,act,fx,motive,tc}] }'),
    }),
  },
)

export const verifyStoryboardTool = tool(
  async ({ sceneJSON, objsJSON, seqJSON }) => {
    return verifyStoryboardFromJSON(sceneJSON, objsJSON, seqJSON)
  },
  {
    name: 'verify_storyboard',
    description: 'Verify storyboard completeness: check scene, character, and shot data integrity. Returns score (0-10) and issues list. Call after shot design.',
    schema: z.object({
      sceneJSON: z.string().describe('Scene JSON: { d, cap, env }'),
      objsJSON: z.string().describe('Merged characters JSON: { objs: [{n,f,t,...}] }'),
      seqJSON: z.string().describe('Shot sequence JSON: { seq: [{id,desc}], cont }'),
    }),
  },
)
