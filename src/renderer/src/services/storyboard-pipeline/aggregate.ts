import type { StoryboardResponse } from '../LangChainStoryboardService'
import type { SceneAnalysis, CharacterAnchor, ShotData, ConsistencyReport } from './schemas'

export function aggregateToStoryboardResponse(
  scene: SceneAnalysis,
  characters: CharacterAnchor[],
  shots: ShotData[],
  report: ConsistencyReport
): StoryboardResponse {
  return {
    scene: {
      d: scene.d,
      cap: scene.cap,
      env: scene.env,
      bgm: scene.bgm,
      timeline: scene.timeline
    },
    objs: characters.map(c => ({
      n: c.n,
      f: c.f,
      s: c.s,
      p: c.p,
      t: c.t,
      tc: c.tc,
      act: '',
      fx: null,
      motive: c.motive,
      a: '',
      m: c.m
    })),
    seq: shots.map(s => ({
      id: s.id,
      desc: s.desc,
      act: s.act || undefined,
      fx: s.fx || null,
      motive: s.motive || undefined,
      audio: s.audio || undefined
    })),
    cont: report.cont,
    notes: report.notes
  }
}
