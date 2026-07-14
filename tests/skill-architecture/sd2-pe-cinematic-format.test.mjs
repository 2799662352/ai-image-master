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
    '统一高规格单轨',
    '总体设定 → 镜头分镜 → 风格与约束',
    '## 音频通道',
    '## 特殊字符规范',
    '## 强制约束',
  ]) {
    assert.match(source, new RegExp(existingContract), `existing sd2-pe contract lost: ${existingContract}`)
  }

  assert.match(source, /每次视频任务.*格式化骨架/s)
  assert.match(source, /只能叠加.*不得替代.*三段内容/s)
  assert.match(source, /媒介 profile.*真人.*2D 动画.*3D 动画/s)
  assert.match(source, /电影.*检索.*意图词/s)
  assert.match(source, /seedance-cinematic-format/)
  assert.match(source, /每次\s*视频任务.*都必须先加载该 skill/s)
  assert.doesNotMatch(source, /简单任务\s*不必额外加载/)

  // 无简单视频降级路径:删除路径 A/B 双轨,单镜只减镜头数不降规格。
  assert.match(source, /没有"简单视频"路径/)
  assert.doesNotMatch(source, /路径 A|路径 B|路径A|路径B/)
  assert.match(source, /单镜.*只写 `镜头1`|分镜段只有 `镜头1`/s)

  // 参考候选:落笔前主动检索 2–3 个已核实真实影视参考供用户挑选。
  assert.match(source, /#### 3\.3 参考候选/)
  assert.match(source, /2–3 个已核实的真实影视参考候选/)
  assert.match(source, /供用户挑选/)
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

  // 永不降级 + 检索复用:导演与参考系每次都要有已核实的真实参考,不分任务档位;
  // 回执写回参考知识库、先复用后检索;仅检索工具完全不可用时才写无归属技法。
  assert.match(helper, /永不降级/)
  assert.match(helper, /复用/)
  assert.doesNotMatch(helper, /允许完全不写人名/)
  assert.doesNotMatch(helper, /只有用户点名[\s\S]{0,40}才由上游/)
  assert.doesNotMatch(helper, /轻量核实/)
  assert.match(sd2, /永不降级/)
  assert.match(sd2, /复用/)
  assert.match(research, /永不降级/)
  assert.match(research, /先复用后检索/)
  assert.match(research, /## 调查回执与复用/)
  assert.match(research, /reference-receipts\.md/)
  assert.doesNotMatch(research, /不是每次视频任务的前置门/)
  assert.match(template, /已核实参考：\[必填/)
  assert.match(template, /仅当检索工具完全不可用/)

  // 参考候选给用户选 + 无路径 A/B 残留(镜头规划以 单镜/多镜 表述)。
  assert.match(helper, /供用户挑选/)
  assert.match(template, /单镜：\[镜头1/)
  assert.doesNotMatch(helper, /路径 A|路径 B/)
  assert.doesNotMatch(template, /路径 A|路径 B/)
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
    assert.match(hook, /无简单视频降级路径/)
    assert.match(hook, /真实影视参考候选/)
    assert.doesNotMatch(hook, /路径A·B|路径 A\/B/)
  }
})
