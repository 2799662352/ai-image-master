import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')
const skillRoot = 'resources/plugins/catimation-video/skills'

async function read(relativePath) {
  return readFile(path.join(repoRoot, ...relativePath.split('/')), 'utf8')
}

test('sd2-pe keeps its existing workflow and adds the mandatory cinematic format layer', async () => {
  const source = await read(`${skillRoot}/sd2-pe/SKILL.md`)

  for (const existingContract of [
    '## 八大核心要素',
    '路径 A：简单视频',
    '路径 B：复杂影视化场景',
    '## 音频通道',
    '## 特殊字符规范',
    '## 强制约束',
  ]) {
    assert.match(source, new RegExp(existingContract), `existing sd2-pe contract lost: ${existingContract}`)
  }

  assert.match(source, /每次视频任务.*格式化骨架/s)
  assert.match(source, /只能叠加.*不得替代.*路径 A.*路径 B/s)
  assert.match(source, /媒介 profile.*真人.*2D 动画.*3D 动画/s)
  assert.match(source, /电影.*检索.*意图词/s)
  assert.match(source, /seedance-cinematic-format/)
  assert.match(source, /每次\s*视频任务.*都必须先加载该 skill/s)
  assert.doesNotMatch(source, /简单任务\s*不必额外加载/)
})

test('cinematic format helper is a leaf and defines all common fields plus three category overlays', async () => {
  const source = await read(`${skillRoot}/seedance-cinematic-format/SKILL.md`)
  const marketplaceSync = await read('scripts/sync-plugin-skills-to-codex.mjs')

  assert.match(source, /角色.*纯知识辅助模块/s)
  assert.match(source, /不负责.*任务编排/s)
  assert.doesNotMatch(source, /generate_video|catimation-video|film-studio|director-orchestrator/)

  for (const requiredField of [
    '[任务与创作意图]',
    '[创作重心与自由度]',
    '[空间结构与主体绑定]',
    '[动作流程与镜头设计]',
    '[导演与参考系]',
    '[表演或运动系统]',
    '[视觉设计]',
    '[声音设计]',
    '[时空一致性]',
    '[技术规格与约束]',
    '[多粒度对齐检查]',
    '[综合 Dense Caption]',
  ]) {
    assert.ok(source.includes(requiredField), `missing mandatory field: ${requiredField}`)
  }

  for (const categoryReference of [
    'references/live-action-film.md',
    'references/2d-animation-film.md',
    'references/3d-animation-film.md',
  ]) {
    assert.ok(source.includes(categoryReference), `missing category reference: ${categoryReference}`)
    const category = await read(`${skillRoot}/seedance-cinematic-format/${categoryReference}`)
    assert.match(category, /不得删减通用骨架字段/)
    assert.match(category, /导演与参考作品.*可替换/s)
    assert.equal(
      category.match(/^# /gm)?.length,
      1,
      `category reference contains duplicated document roots: ${categoryReference}`,
    )
  }

  assert.match(
    marketplaceSync,
    /ADD_LIST[\s\S]*seedance-cinematic-format/,
    'standalone sd2-pe must ship its companion helper too',
  )
  assert.match(
    marketplaceSync,
    /--only=/,
    'sync must support selecting these skills without publishing unrelated dirty sources',
  )
})

test('media profiles stay flexible, inherit dialogue language, and preserve template provenance', async () => {
  const sd2 = await read(`${skillRoot}/sd2-pe/SKILL.md`)
  const helper = await read(`${skillRoot}/seedance-cinematic-format/SKILL.md`)
  const liveAction = await read(
    `${skillRoot}/seedance-cinematic-format/references/live-action-film.md`,
  )
  const animation2d = await read(
    `${skillRoot}/seedance-cinematic-format/references/2d-animation-film.md`,
  )
  const animation3d = await read(
    `${skillRoot}/seedance-cinematic-format/references/3d-animation-film.md`,
  )
  const research = await read(
    `${skillRoot}/seedance-cinematic-format/references/research-methods.md`,
  )
  const template = await read(
    `${skillRoot}/seedance-cinematic-format/references/prompt-output-template.md`,
  )
  const hooks = await Promise.all([
    read('resources/plugins/catimation-video/hooks/session-start'),
    read('resources/plugins/catimation-video/hooks/session-start-codex'),
  ])

  assert.match(sd2, /媒介 profile.*不是.*硬分类/s)
  assert.match(sd2, /电影.*检索.*意图词/s)
  assert.match(sd2, /日式.*2D.*优先.*日语.*真人.*3D.*优先.*中文.*英语/s)
  assert.match(sd2, /台词.*沿用.*用户.*语言.*不擅自翻译/s)
  assert.doesNotMatch(sd2, /台词一律保留中文/)

  for (const category of [animation2d, liveAction, animation3d]) {
    assert.match(category, /语言建议.*不是硬约束/s)
    assert.match(category, /台词.*沿用.*用户.*语言/s)
  }
  assert.match(animation2d, /日式.*2D.*优先.*日语/s)
  assert.match(liveAction, /优先.*中文.*英语/s)
  assert.match(animation3d, /优先.*中文.*英语/s)

  assert.match(helper, /references\/research-methods\.md/)
  assert.match(helper, /references\/prompt-output-template\.md/)
  assert.match(helper, /真人.*2D.*3D.*媒介 profile.*允许.*组合/s)
  assert.match(helper, /电影.*检索.*意图词/s)
  assert.doesNotMatch(helper, /只选择一个主体类别|只选一个主体类别/)
  assert.match(research, /## 2D 动画调查方法[\s\S]*Sakugabooru[\s\S]*ANN/)
  assert.match(research, /## 真人剧与电影调查方法[\s\S]*ASC[\s\S]*ShotDeck/)
  assert.match(research, /## 3D 动画与电影调查方法[\s\S]*SIGGRAPH/)
  assert.match(research, /核实.*职务/)

  for (const requiredField of [
    '[任务与创作意图]',
    '[创作重心与自由度]',
    '[空间结构与主体绑定]',
    '[动作流程与镜头设计]',
    '[导演与参考系]',
    '[表演或运动系统]',
    '[视觉设计]',
    '[声音设计]',
    '[时空一致性]',
    '[技术规格与约束]',
    '[多粒度对齐检查]',
    '[综合 Dense Caption]',
  ]) {
    assert.ok(template.includes(requiredField), `output template missing: ${requiredField}`)
  }
  assert.match(template, /完美1\.md.*学习参考/s)
  assert.match(template, /吸收.*演出.*权重.*空间.*导演.*声音/s)
  assert.match(template, /不照搬.*固定 10 秒.*固定.*权重.*固定.*导演/s)
  assert.match(template, /2D.*优先.*日语.*真人.*3D.*优先.*中英/s)
  assert.match(template, /台词.*沿用.*用户.*语言.*不擅自翻译/s)
  for (const hook of hooks) {
    assert.match(hook, /真人、2D、3D是可组合profile.*电影是检索意图词/s)
    assert.match(hook, /台词语言按用户要求或原文/)
  }
})
