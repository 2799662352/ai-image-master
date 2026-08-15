import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')
const skillRoot = 'resources/plugins/catimation-video/skills'

async function read(relativePath) {
  return readFile(path.join(repoRoot, ...relativePath.split('/')), 'utf8')
}

test('sd2-pe routes light and complex tasks without lowering content coverage', async () => {
  const source = await read(`${skillRoot}/sd2-pe/SKILL.md`)

  for (const existingContract of [
    '## 八大核心要素',
    '路径 A',
    '路径 B',
    '12 项要素覆盖清单',
    '五大必备内容块',
    '## 音频通道',
    '## 特殊字符规范',
    '## 强制约束',
  ]) {
    assert.match(source, new RegExp(existingContract), `existing sd2-pe contract lost: ${existingContract}`)
  }

  // 工作台复制了八大要素公式当落板自检清单。公式是 sd2-pe 的权威定义,两处必须逐字
  // 一致 —— 否则 sd2-pe 改了要素,工作台会静默停留在旧口径。
  const workbench = await read(`${skillRoot}/catimation-video-workbench/SKILL.md`)
  const formula = source.match(/精准主体[^\n]*约束条件/)?.[0]
  assert.ok(formula, 'sd2-pe 八大要素公式缺失')
  assert.ok(
    workbench.includes(formula),
    `工作台的八大要素公式与 sd2-pe 漂移了。sd2-pe: ${formula}`,
  )

  assert.match(source, /12 项要素是覆盖清单，不是格式模板/)
  assert.match(source, /不要求逐项写方括号标题、不要求空行分块/)
  assert.match(source, /八大核心要素同样一项都不能少/)
  assert.match(source, /后 6 项允许压缩成短语或由优化器自动补全，但不能.*消失/s)
  assert.match(source, /五大必备内容块缺一不可/)
  assert.match(source, /媒介 profile.*真人.*2D 动画.*3D 动画/s)
  assert.match(source, /电影.*检索.*意图词/s)
  assert.match(source, /seedance-cinematic-format/)
  assert.match(source, /路径 A 可跳过该叶子/)
  assert.match(source, /路径 B、混合媒介或需要展开导演\/作品参考时再加载该叶子/)
  assert.match(source, /只减少结构开销，不降低交付要求/)

  // 复杂度优先于任务类型：简单编辑可走 A，复杂/多镜编辑必须走 B。
  assert.match(source, /路径 B 条件优先于任务类型/)
  assert.match(source, /明确多镜.*直接进入路径 B/)
  assert.doesNotMatch(source, /编辑\s*\/\s*延长\s*\/\s*组合.*一律走.*路径 A/)
  assert.doesNotMatch(source, /路径 B.*严格三段论|三段必须齐全/)
  assert.match(source, /路径 B.*三组语义内容.*形式自由/s)

  // 路径 A 不强拆镜头，但不得借“简单”省略内容。
  assert.match(source, /路径 A：轻量连续任务/)
  assert.match(source, /内容一段式，不拆镜头/)
  assert.match(source, /路径 A.*12 项要素.*五大必备内容块/s)

  // 参考候选:落笔前主动检索 2–3 个已核实真实影视参考供用户挑选。
  assert.match(source, /#### 3\.3 参考候选/)
  assert.match(source, /2–3 个已核实的真实影视参考候选/)
  assert.match(source, /供用户挑选/)
})

test('storyboard grids and art-direction boards use explicit loose or exact reference paths', async () => {
  const sd2 = await read(`${skillRoot}/sd2-pe/SKILL.md`)
  const helper = await read(`${skillRoot}/seedance-cinematic-format/SKILL.md`)
  const template = await read(
    `${skillRoot}/seedance-cinematic-format/references/prompt-output-template.md`,
  )
  const videoEntry = await read(`${skillRoot}/catimation-video/SKILL.md`)
  const grid = await read(
    'resources/plugins/catimation-storyboard/skills/storyboard-grid-to-seedance/SKILL.md',
  )
  const artBoard = await read(
    'resources/plugins/catimation-storyboard/skills/storyboard-grid-to-seedance/references/cinematic-art-direction-board.md',
  )
  const industrialBoard = await read(
    'resources/plugins/catimation-storyboard/skills/storyboard-grid-to-seedance/references/gpt-image-industrial-storyboard-prompt.md',
  )
  const production = await read(
    'resources/plugins/catimation-storyboard-pro/skills/create-storyboard/SKILL.md',
  )
  const packageSpec = await read(
    'resources/plugins/catimation-storyboard-pro/skills/create-storyboard/assets/production_package_spec.md',
  )

  assert.match(grid, /单帧、网格故事板和电影美术设定板.*不冲突/s)
  assert.match(grid, /提示词主导 \+ 整板氛围低约束/)
  assert.match(grid, /拆格精确执行/)
  assert.match(grid, /不要宣称.*可靠解析成 N 个独立时间帧/s)
  assert.match(grid, /氛围网格或美术设定板不得在未确认时自动冒充身份锚点或 `firstFrame`/)
  assert.match(grid, /primary \/ hard \/ strong \/ atmosphere-loose \/ director-free.*语义职责.*不是模型\s*API 权重/s)
  assert.match(grid, /不复制网格布局、边框、编号、文字或拼贴版式/)
  assert.match(grid, /有板即用的提示词硬门[\s\S]*文字主导[\s\S]*低约束氛围参考/)
  assert.match(grid, /GPT Image 故事板提示词三（首选）/)

  assert.match(sd2, /长图 \/ 九宫格先问用户/)
  assert.match(sd2, /拆成单图（推荐默认）[\s\S]*整张作氛围板（低约束）/)
  assert.match(sd2, /文字提示词=`primary`[\s\S]*故事板\/多宫格\/美术设定板=`atmosphere-loose`/)
  assert.match(sd2, /权重=语义收束强调度[\s\S]*不是 API 参数/)
  assert.match(sd2, /氛围板前缀（用户选择整张参考时必带）/)

  for (const source of [helper, template]) {
    assert.match(source, /identity.*hard|身份.*hard/i)
    assert.match(source, /keyframe.*strong|关键帧.*strong/i)
    assert.match(source, /atmosphere.*loose|氛围板.*loose/i)
    assert.match(source, /director.*free|导演自由.*free/i)
    assert.match(source, /不.*firstFrame|不作 firstFrame/s)
  }

  assert.match(videoEntry, /每个复用角色先确定一套 `identity-hard` 主锚[\s\S]*多视图角色板/s)
  assert.match(videoEntry, /多套候选且拿不准时[\s\S]*`ask_user`/)
  assert.match(production, /overview_boards\/sequence/)
  assert.match(production, /overview_boards\/art_direction/)
  assert.match(production, /图像模型生成视觉底图\/缩略图[\s\S]*本地确定性层叠加/s)
  assert.match(production, /不是每个项目必交[\s\S]*提示词必须带“提示词主导 \/ 氛围板低约束”/)
  assert.match(packageSpec, /atmosphere-loose[\s\S]*提示词主导 \/ 氛围板低约束/s)

  assert.match(artBoard, /图像模型视觉层/)
  assert.match(artBoard, /本地确定性信息层/)
  assert.match(artBoard, /不是每个视频请求都必须生成本板/)
  assert.match(artBoard, /视频提示词必须带“提示词主导 \/[\s\S]*氛围板低约束”职责前缀/)
  assert.match(artBoard, /不要同时要求.*3840×2160 且 21:9/)
  assert.match(artBoard, /300 DPI.*不能替代真实像素/)

  assert.match(industrialBoard, /整张故事板工作台是 21:9[\s\S]*分镜格内部画面用 9:16/)
  assert.match(industrialBoard, /红色箭头=角色运动方向[\s\S]*蓝色箭头=镜头运动方向[\s\S]*绿色箭头=主光/)
  assert.match(industrialBoard, /无字幕\/无文字.*只约束每个镜头画面内部/s)
  for (const requiredModule of [
    '顶部项目信息栏',
    '角色参考区',
    '场景设计区',
    '分镜表格区',
    '底部备注说明区',
  ]) {
    assert.ok(industrialBoard.includes(requiredModule), `industrial board missing ${requiredModule}`)
  }
  assert.match(industrialBoard, /视频交接必带前缀/)
  assert.match(industrialBoard, /图片N 是故事板\/多宫格氛围参考/)
})

test('video and storyboard instructions match runtime limits and orchestration contracts', async () => {
  const videoEntry = await read(`${skillRoot}/catimation-video/SKILL.md`)
  const sd2 = await read(`${skillRoot}/sd2-pe/SKILL.md`)
  const helper = await read(`${skillRoot}/seedance-cinematic-format/SKILL.md`)
  const outputTemplate = await read(
    `${skillRoot}/seedance-cinematic-format/references/prompt-output-template.md`,
  )
  const liveAction = await read(
    `${skillRoot}/seedance-cinematic-format/references/live-action-film.md`,
  )
  const animation2d = await read(
    `${skillRoot}/seedance-cinematic-format/references/2d-animation-film.md`,
  )
  const animation3d = await read(
    `${skillRoot}/seedance-cinematic-format/references/3d-animation-film.md`,
  )
  const researchPrompting = await read(
    `${skillRoot}/codex-research-grounded-prompting/SKILL.md`,
  )
  const createStoryboard = await read(
    'resources/plugins/catimation-storyboard-pro/skills/create-storyboard/SKILL.md',
  )
  const storyboardWorkflow = await read(
    'resources/plugins/catimation-storyboard-pro/skills/create-storyboard/references/storyboard_workflow.md',
  )
  const storyboardTemplate = await read(
    'resources/plugins/catimation-storyboard-pro/skills/create-storyboard/assets/storyboard_template.md',
  )
  const img2Template = await read(
    'resources/plugins/catimation-storyboard-pro/skills/create-storyboard/assets/img2_seedance_prompt_template.md',
  )
  const videoCraft = await read(`${skillRoot}/seedance-video-craft/SKILL.md`)
  const filmStudio = await read(
    'resources/plugins/catimation-film/skills/film-studio/SKILL.md',
  )
  const filmHooks = await Promise.all([
    read('resources/plugins/catimation-film/hooks/session-start'),
    read('resources/plugins/catimation-film/hooks/session-start-codex'),
  ])
  const capabilities = await read(
    `${skillRoot}/seedance-video-craft/references/seedance-2.0-capabilities.md`,
  )
  const videoTool = await read('src/main/mcp/tools/videoTools.ts')
  const promptNormalizer = await read(
    'src/main/services/seedance/promptReferences.ts',
  )

  assert.match(createStoryboard, /生成时长必须为 4–15s/)
  assert.doesNotMatch(createStoryboard, /`0-15s`/)
  assert.match(createStoryboard, /至少 4s.*后期裁/s)
  assert.match(storyboardWorkflow, /1\.5-2\.5s.*generate at least `4s`/s)
  assert.match(img2Template, /generation must be 4-15 seconds/)

  for (const receiptField of [
    'task_level',
    'direction_confirmed',
    'spec_confirmed',
    'prompt_engineered',
    'qa_completed',
    'generation_attempts',
  ]) {
    assert.ok(videoEntry.includes(receiptField), `routing receipt missing ${receiptField}`)
  }
  // 预算表数的是「自选对症技法」,不是全部加载数 —— 表格与下方说明必须同口径,
  // 否则 agent 会同时读到「≤5 顶层含入口」和「入口不占额度」两种互斥读法。
  assert.match(videoEntry, /标准.*1 个对症技法/s)
  assert.match(videoEntry, /专业.*2 个对症技法/s)
  assert.match(videoEntry, /条件强制项不占这个额度/)
  assert.doesNotMatch(videoEntry, /≤\d+ 顶层/, '预算不应再用「≤N 顶层」表述')
  assert.match(videoEntry, /路径 A[\s\S]*跳过结构叶子/)
  assert.match(
    videoEntry,
    /复杂、多镜、混合媒介[\s\S]*路径 B[\s\S]*seedance-cinematic-format/,
  )
  assert.match(videoEntry, /STILL RUNNING \+ taskId[\s\S]*check_video_task/)
  assert.match(videoEntry, /自动修正[\s\S]*最多 2 次/)
  assert.doesNotMatch(videoEntry, /iterate at MOST 2–3 times/)

  assert.match(sd2, /Skill 写作主形式.*`@图片N` \/ `@视频N` \/ `@音频N`/s)
  assert.match(sd2, /工具边界规范形式.*`图片N` \/ `视频N` \/ `音频N`/s)
  assert.match(sd2, /不要把 `@` 描述成上游 API 参数/)
  assert.match(sd2, /接口支持时间戳\/scene-cut 指令/)
  assert.doesNotMatch(sd2, /精确时间支持不稳定/)
  assert.match(promptNormalizer, /@Image1/)
  assert.match(promptNormalizer, /图片1 \/ 视频1 \/ 音频1/)
  assert.match(videoTool, /runtime also accepts and normalizes @Video1\/@Image1\/@Audio1/)

  assert.match(outputTemplate, /路径 A 使用连续任务正文；路径 B 覆盖总体设定/)
  assert.doesNotMatch(helper, /不新增作品参考/)
  assert.doesNotMatch(outputTemplate, /无新增作品参考/)
  assert.match(outputTemplate, /沿用已核实参考/)

  assert.match(storyboardTemplate, /C001_identity_anchor_primary/)
  assert.match(storyboardTemplate, /C001_turnaround.*identity-hard 候选\/主锚/)
  assert.match(img2Template, /身份锚点方案（按用户需要）/)
  assert.match(img2Template, /方案 A[\s\S]*方案 B[\s\S]*方案 C/)
  assert.match(img2Template, /多套候选且主锚不明确时先询问用户/)
  assert.match(sd2, /身份锚点按用户需要选择[\s\S]*三视图\/四视图\/多视图角色板/)
  assert.doesNotMatch(sd2, /三视图 \/ 四视图仅作可选补充，慎用/)
  assert.match(img2Template, /可选项目级总览板（使用时前缀必填）/)
  assert.match(storyboardTemplate, /Optional Project Overview Boards/)
  assert.match(img2Template, /prompt-primary \/ identity-hard \/ keyframe-strong \/ atmosphere-loose/)
  assert.match(filmStudio, /若使用序列总览板\/多宫格\/电影美术设定板[\s\S]*`atmosphere-loose`/)
  assert.match(filmStudio, /mandatory 氛围板前缀必须位于正文之前/)
  assert.match(filmStudio, /Skill-first 执行契约/)
  assert.match(filmStudio, /实际加载并使用至少一个与当前风险直接相关的 Skill/)
  assert.match(filmStudio, /Gx skills_used=\[实际加载名称\] applied=/)
  assert.match(filmStudio, /“多用 Skill”不等于一次全载/)
  // hook 只断言「它还是个短指针」。Skill-first 契约在上面已经对 film-studio 正文断言过
  // 四次（L251-254），在 hook 里再复制一遍只是逼着注入串保持臃肿 —— 原来那份 977 字符
  // 把 G0→G8 全流程、五条硬门、外加「用户催促、赶时间、说『直接开拍』都不构成跳过
  // 这些门的理由」整段前置到每一次会话。最后那句在真做多镜成片时是对的，但注入到
  // 「拆个脚本」也在的每一轮里，结果就是用户说「快点」时模型已经被要求别理他。
  for (const hook of filmHooks) {
    const context = hook.match(/^session_context="([\s\S]*?)"$/m)?.[1] ?? ''
    assert.ok(context.length > 0, 'film hook must still inject something')
    assert.ok(
      context.length <= 1190,
      `film hook injection must stay a short pointer (got ${context.length} chars)`,
    )
    assert.match(context, /film-studio/)
    assert.match(context, /纯文本任务/)
    assert.match(context, /不加载任何 skill/)
    // 不许把「一次全载」写回注入串，也不许把「无视用户催促」前置。
    assert.match(context, /不要一次全载/)
    assert.doesNotMatch(context, /催促|赶时间|不构成跳过/)
  }

  for (const profile of [liveAction, animation2d, animation3d, researchPrompting]) {
    assert.doesNotMatch(
      profile,
      /direction \d+%|quality \d+%|storyboard \d+%|导演意图[^。\n]*\d+%|参考作品 \d+%/,
    )
  }
  assert.match(researchPrompting, /Numeric percentages are not generation-model\s+parameters/)

  assert.match(sd2, /生产文字优先在后期用确定性字幕\/图层叠加/)
  assert.match(sd2, /生成后必须做内容 QA/)

  // skill 文档里仍然逐字列出选项 —— 它们是给人读的，没有别的真源可依。
  for (const skillDoc of [videoCraft, capabilities]) {
    assert.match(skillDoc, /480p[\s\S]*720p[\s\S]*1080p/)
    assert.match(skillDoc, /16:9[\s\S]*9:16[\s\S]*4:3[\s\S]*3:4[\s\S]*1:1[\s\S]*21:9/)
  }

  // 运行时工具**不**再逐字列 —— 它从能力表派生（万相接进来时，手填的那份漏了
  // wan3，而这正是 2.5 踩过的坑：导出含该模型卡片的板子再 apply 会被 zod 当场拒）。
  // 断言因此从「字面量对得上」升级为「确实取自单一真源」，这是更强的保证：
  // 加模型时工具自动跟上，不需要有人记得同步这里。
  assert.match(videoTool, /ALL_VIDEO_MODEL_ALIASES/)
  assert.match(videoTool, /ALL_VIDEO_RESOLUTIONS/)
  assert.match(videoTool, /ALL_VIDEO_RATIOS/)
  assert.doesNotMatch(videoTool, /z\.enum\(\['480p', '720p', '1080p'\]\)/)
})

test('skill-authored media tokens use @ while runtime canonicalization stays explicit', async () => {
  const videoEntry = await read(`${skillRoot}/catimation-video/SKILL.md`)
  const helper = await read(`${skillRoot}/seedance-cinematic-format/SKILL.md`)
  const animation2d = await read(
    `${skillRoot}/seedance-cinematic-format/references/2d-animation-film.md`,
  )
  const outputTemplate = await read(
    `${skillRoot}/seedance-cinematic-format/references/prompt-output-template.md`,
  )
  const videoCraft = await read(`${skillRoot}/seedance-video-craft/SKILL.md`)
  const timeAllocation = await read(
    `${skillRoot}/seedance-video-craft/references/time-allocation-and-multimodal.md`,
  )
  const capabilities = await read(
    `${skillRoot}/seedance-video-craft/references/seedance-2.0-capabilities.md`,
  )
  const director = await read(
    'resources/plugins/catimation-director/skills/director-orchestrator/SKILL.md',
  )
  const film = await read('resources/plugins/catimation-film/skills/film-studio/SKILL.md')
  const grid = await read(
    'resources/plugins/catimation-storyboard/skills/storyboard-grid-to-seedance/SKILL.md',
  )
  const gridRules = await read(
    'resources/plugins/catimation-storyboard/skills/storyboard-grid-to-seedance/references/seedance-6-rules.md',
  )
  const industrialBoard = await read(
    'resources/plugins/catimation-storyboard/skills/storyboard-grid-to-seedance/references/gpt-image-industrial-storyboard-prompt.md',
  )
  const artBoard = await read(
    'resources/plugins/catimation-storyboard/skills/storyboard-grid-to-seedance/references/cinematic-art-direction-board.md',
  )

  for (const source of [
    videoEntry,
    helper,
    animation2d,
    outputTemplate,
    videoCraft,
    timeAllocation,
    director,
    film,
    grid,
    gridRules,
    industrialBoard,
    artBoard,
  ]) {
    assert.match(source, /@图片N|@图片1/)
  }
  assert.match(capabilities, /Skill 写作.*@图片1 \/ @视频1 \/ @音频1/)
  assert.match(capabilities, /工具边界.*图片1 \/ 视频1 \/ 音频1/)
  assert.doesNotMatch(videoCraft, /单次前向/)
  assert.doesNotMatch(gridRules, /独立的推理过程|不会"记住"前一镜/)
  assert.match(gridRules, /每段重复绑定素材职责/)
  assert.match(grid, /百分比.*语义收束方向.*不是.*API 参数/s)
})

test('cinematic format helper is a conditional leaf with 12 content indexes and three profiles', async () => {
  const source = await read(`${skillRoot}/seedance-cinematic-format/SKILL.md`)
  const marketplaceSync = await read('scripts/sync-plugin-skills-to-codex.mjs')

  assert.match(source, /角色.*纯知识辅助模块/s)
  assert.match(source, /不负责.*任务编排/s)
  assert.doesNotMatch(source, /generate_video|catimation-video|film-studio|director-orchestrator/)
  assert.match(source, /复杂、多镜、混合媒介[\s\S]*路径 B/)
  assert.match(source, /路径 A 只处理简单单镜的轻量连续任务，可跳过本叶子/)
  assert.match(source, /不要求逐项写方括号标题/)
  assert.match(source, /方括号名称只是语义索引，不是强制输出模板/)

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
    assert.ok(source.includes(requiredField), `missing required content index: ${requiredField}`)
  }

  for (const categoryReference of [
    'references/live-action-film.md',
    'references/2d-animation-film.md',
    'references/3d-animation-film.md',
  ]) {
    assert.ok(source.includes(categoryReference), `missing category reference: ${categoryReference}`)
    const category = await read(`${skillRoot}/seedance-cinematic-format/${categoryReference}`)
    assert.match(category, /不得遗漏通用 12 项内容/)
    assert.match(category, /标题[\s\S]*语义索引/)
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

  // 参考候选给用户选 + 路径 A/B 条件加载契约。
  assert.match(helper, /供用户挑选/)
  assert.match(template, /单镜：\[镜头1/)
  assert.match(helper, /复杂、多镜、混合媒介[\s\S]*路径 B/)
  assert.match(helper, /路径 A 只处理简单单镜的轻量连续任务，可跳过本叶子/)
  assert.match(template, /路径 A 使用连续任务正文；路径 B 覆盖总体设定/)
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
  assert.match(template, /吸收.*演出.*优先级.*空间.*导演.*声音/s)
  assert.match(template, /不照搬.*固定 10 秒.*权重.*API 参数.*固定导演/s)
  assert.match(template, /2D.*优先.*日语.*真人.*3D.*优先.*中英/s)
  assert.match(template, /台词.*沿用.*用户.*语言.*不擅自翻译/s)
  // hook 只断言「它还是个短指针」，不再逐句复制正文。
  //
  // 这里原本断言 7 句话——媒介 profile、台词语言、路径 A/B 条件、12 项内容、参考候选——
  // 而那些正是把 catimation-video / seedance-cinematic-format 的正文提前搬进每一轮会话的
  // 元凶：注入串因此涨到约 1900 字符，模型把它当成「每次都要照做的清单」而不是索引，
  // 拆个脚本都要先过一遍分级和闸门。这些不变量在上面已经对 sd2-pe、helper、template
  // 的正文各断言过一次，在 hook 里再断言一遍只是逼着 hook 保持臃肿。
  for (const hook of hooks) {
    const context = hook.match(/^session_context="([\s\S]*?)"$/m)?.[1] ?? ''
    assert.ok(context.length > 0, 'hook must still inject something')
    assert.ok(
      context.length <= 1190,
      `hook injection must stay a short pointer (got ${context.length} chars) —— 正文该由 Skill 工具按需读`,
    )
    // 指路仍要指得准：入口名 + 底座按模型二选一，其余按需。
    assert.match(context, /catimation-video/)
    assert.match(context, /sd25-pe/)
    assert.match(context, /sd2-pe/)
    // 纯文本任务必须被明确豁免，否则「拆个脚本」又会被拖进分级流程。
    assert.match(context, /纯文本任务/)
    assert.match(context, /不加载任何 skill/)
    // 不许再把「每次都要」这类全称强制写回注入串。
    assert.doesNotMatch(context, /自动加载两个|两个同级底座/)
  }
})
