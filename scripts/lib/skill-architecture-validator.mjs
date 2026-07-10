/**
 * CATIMATION Skill 编排架构验证器。
 *
 * 固化的架构不变量(与 scripts/lib/skill-architecture-validator.test.mjs 及
 * tests/skill-architecture/repository-architecture.test.mjs 对应):
 *  - catimation-image / catimation-video 是各自领域唯一隐式生成入口;
 *  - Skill 引用图必须是单向 DAG,禁止 orchestrator/router 回环;
 *  - craft(叶子)不得强制回调 orchestrator/router;
 *  - SessionStart hook 不得 cat 整份 SKILL.md,静态注入文本设长度上限;
 *  - description 限长,禁止「MUST ... EVERY time / ANY image-video / 每次必用」
 *    式宽触发词与通用模型名单尾巴;
 *  - 四级预算:fast≤1、standard≤3、pro≤5 个下游引用,studio 仅 film-studio 持有;
 *  - 首方 Skill(resources/first-party-skills)与生成物
 *    (src/main/agent/generated/firstPartySkills.generated.ts)内容必须一致;
 *  - 同名 Skill 的插件源 / codex 镜像 / 顶层兼容副本 / 内联副本内容必须一致。
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

export const DEFAULT_OPTIONS = Object.freeze({
  maxHookInjectionChars: 2000,
  maxDescriptionChars: 480,
})

const BUDGET_LIMITS = Object.freeze({
  fast: 1,
  standard: 3,
  pro: 5,
  studio: Number.POSITIVE_INFINITY,
})

const STUDIO_OWNER = 'film-studio'

const ENTRY_OWNERS = Object.freeze({
  image: 'catimation-image',
  video: 'catimation-video',
})

const DOMAIN_KEYWORDS = Object.freeze({
  image: /\bimages?\b|image\/video|图片|图像|出图/i,
  video: /\bvideos?\b|image\/video|视频|出视频/i,
})

const BROAD_QUANTIFIER = /\b(whenever|any|every|all)\b|每次|任何|所有|一律/i
const GENERATION_CONTEXT = /generat|creat|produc|mak(e|ing)|render|生成|出图|出视频|制作|画/i

const FORBIDDEN_DESCRIPTION_PATTERNS = Object.freeze([
  /MUST\b[^.\n]{0,80}\bEVERY\s+time/i,
  /\bANY\s+(?:images?|videos?|image\/video)\b/i,
  /每次必用|每次必须|每次都要|任何图片|任何视频|所有图片|所有视频/,
])

const KNOWN_MODEL_NAMES = Object.freeze([
  'sora',
  'veo',
  'runway',
  'kling',
  'seedance',
  'hailuo',
  'midjourney',
  'pika',
  'luma',
  'wan2',
  'vidu',
  '可灵',
  '海螺',
  '即梦',
])

const ORCHESTRATOR_NAME = /orchestrator|router/i
const MANDATORY_PHRASE = /\bMUST\b|\balways\b|\bbefore\s+(any|writing|every)\b|必须|每次|一律|强制/i

function toPosix(filePath) {
  return String(filePath ?? '').replaceAll('\\', '/')
}

function normalizeContent(content) {
  return String(content ?? '').replaceAll('\r\n', '\n')
}

/**
 * 解析一份 SKILL.md:YAML frontmatter 的 name/description(支持 >- 折叠)、
 * 正文中的 `<!-- skill-budget: fast|standard|pro|studio -->` 预算标记与正文。
 */
export function parseSkillMarkdown(content, filePath) {
  const normalized = normalizeContent(content)
  const posixPath = toPosix(filePath)
  let frontmatter = ''
  let body = normalized
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?/)
  if (match) {
    frontmatter = match[1]
    body = normalized.slice(match[0].length)
  }

  const lines = frontmatter.split('\n')
  let name = null
  let description = null
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const nameMatch = line.match(/^name:\s*(.+?)\s*$/)
    if (nameMatch) {
      name = stripQuotes(nameMatch[1])
      continue
    }
    const descriptionMatch = line.match(/^description:\s*(.*)$/)
    if (descriptionMatch) {
      const inline = descriptionMatch[1].trim()
      if (inline === '' || /^[>|][+-]?$/.test(inline)) {
        const folded = []
        while (index + 1 < lines.length && /^\s+\S/.test(lines[index + 1])) {
          folded.push(lines[index + 1].trim())
          index += 1
        }
        description = folded.join(' ').trim()
      } else {
        description = stripQuotes(inline)
      }
    }
  }

  const budgetMatch = body.match(/<!--\s*skill-budget:\s*(fast|standard|pro|studio)\s*-->/i)

  return {
    name,
    description,
    budget: budgetMatch ? budgetMatch[1].toLowerCase() : null,
    body,
    content: normalized,
    path: posixPath,
  }
}

function stripQuotes(value) {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/**
 * 从 TypeScript 源码中提取以模板字面量内嵌的 Skill 内容
 * (`const XXX = \`---\nname: ...\`` 形式),并还原 \` \\ \${ 转义。
 */
export function extractFirstPartySkillsFromTypeScript(source, filePath) {
  const posixPath = toPosix(filePath)
  const results = []
  const literalPattern = /(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*=\s*`((?:\\[\s\S]|[^`\\])*)`/g
  for (const match of String(source ?? '').matchAll(literalPattern)) {
    const [, constantName, rawLiteral] = match
    const decoded = rawLiteral.replace(/\\([\s\S])/g, '$1')
    const parsed = parseSkillMarkdown(decoded, `${posixPath}#${constantName}`)
    if (!parsed.name) continue
    results.push({
      name: parsed.name,
      constant: constantName,
      content: normalizeContent(decoded),
      path: `${posixPath}#${constantName}`,
    })
  }
  return results
}

function referencedSkillNames(parsed, knownNames) {
  const references = new Set()
  for (const match of parsed.body.matchAll(/`([A-Za-z0-9][A-Za-z0-9_-]*)`/g)) {
    const candidate = match[1]
    if (candidate !== parsed.name && knownNames.has(candidate)) {
      references.add(candidate)
    }
  }
  return references
}

function claimedEntryDomains(description) {
  const domains = []
  if (!description) return domains
  if (!BROAD_QUANTIFIER.test(description) || !GENERATION_CONTEXT.test(description)) {
    return domains
  }
  for (const [domain, keyword] of Object.entries(DOMAIN_KEYWORDS)) {
    if (keyword.test(description)) domains.push(domain)
  }
  return domains
}

function detectCycles(nodes, edges) {
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const colors = new Map(nodes.map((node) => [node, WHITE]))
  const stack = []
  const cycles = []
  const seen = new Set()

  function visit(node) {
    colors.set(node, GRAY)
    stack.push(node)
    for (const next of [...(edges.get(node) ?? [])].sort()) {
      const color = colors.get(next)
      if (color === GRAY) {
        const start = stack.indexOf(next)
        const route = [...stack.slice(start), next]
        const key = [...route.slice(0, -1)].sort().join('|')
        if (!seen.has(key)) {
          seen.add(key)
          cycles.push(route)
        }
      } else if (color === WHITE) {
        visit(next)
      }
    }
    stack.pop()
    colors.set(node, BLACK)
  }

  for (const node of [...nodes].sort()) {
    if (colors.get(node) === WHITE) visit(node)
  }
  return cycles
}

function hookStaticInjections(content) {
  const injections = []
  const assignmentPattern = /\b[\w-]*context[\w-]*\s*\+?=\s*"((?:\\[\s\S]|[^"\\])*)"/gi
  for (const match of String(content ?? '').matchAll(assignmentPattern)) {
    injections.push(match[1])
  }
  return injections
}

const HOOK_CAT_PATTERNS = Object.freeze([
  /\bcat\b[^\n]*SKILL\.md/,
  /\$\(\s*<[^)\n]*SKILL\.md/,
  /Get-Content\b[^\n]*SKILL\.md/i,
])

/**
 * 主校验入口。输入是一份仓库快照:
 *   skills:    [{ path, content }] 所有 SKILL.md 副本(插件源/codex 镜像/顶层/首方/内联)
 *   hooks:     [{ path, content }] 所有 SessionStart 等 hook 脚本
 *   firstParty:{ sourceExists, generatedExists, sourceSkills, generatedSkills }
 * 返回 [{ code, message, path }] 诊断列表;空数组表示架构合规。
 */
export function validateArchitecture(snapshot, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const diagnostics = []
  const report = (code, message, diagnosticPath = null) => {
    diagnostics.push({ code, message, path: diagnosticPath })
  }

  const parsedSkills = (snapshot.skills ?? [])
    .map((entry) => parseSkillMarkdown(entry.content, entry.path))
    .filter((parsed) => Boolean(parsed.name))

  const byName = new Map()
  for (const parsed of parsedSkills) {
    if (!byName.has(parsed.name)) byName.set(parsed.name, [])
    byName.get(parsed.name).push(parsed)
  }

  const canonicalOf = (name) => {
    const copies = byName.get(name) ?? []
    return (
      copies.find((copy) => copy.path.includes('resources/plugins/')) ??
      [...copies].sort((a, b) => a.path.localeCompare(b.path))[0] ??
      null
    )
  }
  const knownNames = new Set(byName.keys())

  // 1. 唯一隐式生成入口
  for (const name of [...knownNames].sort()) {
    const canonical = canonicalOf(name)
    for (const domain of claimedEntryDomains(canonical.description)) {
      const owner = ENTRY_OWNERS[domain]
      if (name !== owner) {
        report(
          'IMPLICIT_GENERATION_ENTRY_COLLISION',
          `${canonical.path}: "${name}" claims the broad ${domain}-generation entry owned by "${owner}"`,
          canonical.path,
        )
      }
    }
  }

  // 2. description 纪律
  for (const name of [...knownNames].sort()) {
    const canonical = canonicalOf(name)
    const description = canonical.description ?? ''
    if (description.length > opts.maxDescriptionChars) {
      report(
        'DESCRIPTION_TOO_LONG',
        `${canonical.path}: description is ${description.length} chars (max ${opts.maxDescriptionChars})`,
        canonical.path,
      )
    }
    for (const pattern of FORBIDDEN_DESCRIPTION_PATTERNS) {
      if (pattern.test(description)) {
        report(
          'DESCRIPTION_FORBIDDEN_TRIGGER',
          `${canonical.path}: description contains a forbidden broad trigger (${pattern})`,
          canonical.path,
        )
        break
      }
    }
    const mentionedModels = KNOWN_MODEL_NAMES.filter((model) =>
      new RegExp(`(^|[^a-z0-9])${model}([^a-z0-9]|$)`, 'i').test(description),
    )
    if (mentionedModels.length >= 3) {
      report(
        'DESCRIPTION_MODEL_LIST_TAIL',
        `${canonical.path}: description enumerates a generic model list (${mentionedModels.join(', ')})`,
        canonical.path,
      )
    }
  }

  // 3. 依赖方向:DAG + craft 不得强制回调 orchestrator/router
  const edges = new Map()
  for (const name of knownNames) {
    edges.set(name, referencedSkillNames(canonicalOf(name), knownNames))
  }
  for (const route of detectCycles([...knownNames], edges)) {
    report(
      'DEPENDENCY_CYCLE',
      `dependency cycle: ${route.join(' -> ')}`,
      canonicalOf(route[0])?.path ?? null,
    )
  }
  for (const name of [...knownNames].sort()) {
    if (ORCHESTRATOR_NAME.test(name) || name === ENTRY_OWNERS.image || name === ENTRY_OWNERS.video || name === STUDIO_OWNER) {
      continue
    }
    const canonical = canonicalOf(name)
    for (const target of [...edges.get(name)].sort()) {
      if (!ORCHESTRATOR_NAME.test(target)) continue
      const referencePattern = new RegExp(`^.*\`${target}\`.*$`, 'gm')
      for (const line of canonical.body.match(referencePattern) ?? []) {
        if (MANDATORY_PHRASE.test(line)) {
          report(
            'CRAFT_FORCED_ORCHESTRATOR_BACK_EDGE',
            `${canonical.path}: craft skill "${name}" force-loads orchestrator "${target}"`,
            canonical.path,
          )
          break
        }
      }
    }
  }

  // 4. 四级预算
  for (const name of [...knownNames].sort()) {
    const canonical = canonicalOf(name)
    const budget = canonical.budget ?? 'fast'
    if (budget === 'studio' && name !== STUDIO_OWNER) {
      report(
        'BUDGET_STUDIO_OWNER',
        `${canonical.path}: only "${STUDIO_OWNER}" may own the studio budget (found on "${name}")`,
        canonical.path,
      )
    }
    const limit = BUDGET_LIMITS[budget] ?? BUDGET_LIMITS.fast
    const fanout = edges.get(name).size
    if (fanout > limit) {
      report(
        'BUDGET_FANOUT_EXCEEDED',
        `${canonical.path}: "${name}" (budget ${budget}) references ${fanout} skills (max ${limit})`,
        canonical.path,
      )
    }
  }

  // 5. Hook 注入纪律
  for (const hook of snapshot.hooks ?? []) {
    const hookPath = toPosix(hook.path)
    const content = normalizeContent(hook.content)
    if (HOOK_CAT_PATTERNS.some((pattern) => pattern.test(content))) {
      report('HOOK_CATS_SKILL', `${hookPath}: hook injects an entire SKILL.md`, hookPath)
    }
    for (const injection of hookStaticInjections(content)) {
      if (injection.length > opts.maxHookInjectionChars) {
        report(
          'HOOK_INJECTION_TOO_LARGE',
          `${hookPath}: static context injection is ${injection.length} chars (max ${opts.maxHookInjectionChars})`,
          hookPath,
        )
        break
      }
    }
  }

  // 6. 首方 parity
  const firstParty = snapshot.firstParty ?? {
    sourceExists: false,
    generatedExists: false,
    sourceSkills: [],
    generatedSkills: [],
  }
  if (!firstParty.sourceExists) {
    report(
      'FIRST_PARTY_PARITY_INPUT_MISSING',
      'resources/first-party-skills authoritative source directory is missing',
    )
  }
  if (!firstParty.generatedExists) {
    report(
      'FIRST_PARTY_PARITY_INPUT_MISSING',
      'src/main/agent/generated/firstPartySkills.generated.ts is missing',
    )
  }
  if (firstParty.sourceExists && firstParty.generatedExists) {
    const generatedByName = new Map(
      (firstParty.generatedSkills ?? []).map((entry) => {
        const parsed = parseSkillMarkdown(entry.content, entry.path)
        return [parsed.name, { parsed, content: normalizeContent(entry.content) }]
      }),
    )
    for (const entry of firstParty.sourceSkills ?? []) {
      const parsed = parseSkillMarkdown(entry.content, entry.path)
      if (!parsed.name) continue
      const generated = generatedByName.get(parsed.name)
      if (!generated || generated.content !== normalizeContent(entry.content)) {
        report(
          'FIRST_PARTY_PARITY_MISMATCH',
          `${parsed.path}: first-party skill "${parsed.name}" drifts from the generated copy`,
          parsed.path,
        )
      }
    }
  }

  // 7. 多副本一致性。顶层 `skills/` 是渲染管线的兼容镜像,允许自持
  //    appliesTo/priority 等管线 frontmatter,但 description+正文必须与权威源
  //    一致;其余副本(codex 镜像 / 首方生成物 / 内联)必须字节级一致。
  const isPipelineMirror = (copyPath) => /^skills\//.test(toPosix(copyPath))
  for (const name of [...knownNames].sort()) {
    const copies = byName.get(name)
    if (copies.length < 2) continue
    const canonical = canonicalOf(name)
    for (const copy of copies) {
      if (copy === canonical) continue
      const matches = isPipelineMirror(copy.path)
        ? copy.description === canonical.description &&
          copy.body.trim() === canonical.body.trim()
        : normalizeContent(copy.content) === normalizeContent(canonical.content)
      if (!matches) {
        report(
          'SKILL_COPY_DRIFT',
          `${copy.path}: copy of "${name}" drifts from canonical ${canonical.path}`,
          copy.path,
        )
      }
    }
  }

  return diagnostics
}

export function formatDiagnostics(diagnostics) {
  if (!diagnostics || diagnostics.length === 0) return 'no diagnostics'
  return diagnostics.map((item) => `${item.code} ${item.message}`).join('\n')
}

async function pathExists(target) {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

async function listDirectories(root) {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }
}

async function collectSkillFiles(repoRoot, relativeRoots) {
  const skills = []
  for (const relativeRoot of relativeRoots) {
    const absoluteRoot = path.join(repoRoot, ...relativeRoot.split('/'))
    for (const skillDirectory of await listDirectories(absoluteRoot)) {
      const skillFile = path.join(absoluteRoot, skillDirectory, 'SKILL.md')
      if (!(await pathExists(skillFile))) continue
      skills.push({
        path: `${relativeRoot}/${skillDirectory}/SKILL.md`,
        content: await readFile(skillFile, 'utf8'),
      })
    }
  }
  return skills
}

async function collectHookFiles(repoRoot) {
  const hooks = []
  const pluginsRoot = path.join(repoRoot, 'resources', 'plugins')
  for (const pluginName of await listDirectories(pluginsRoot)) {
    const hooksRoot = path.join(pluginsRoot, pluginName, 'hooks')
    let entries
    try {
      entries = await readdir(hooksRoot, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue
      hooks.push({
        path: `resources/plugins/${pluginName}/hooks/${entry.name}`,
        content: await readFile(path.join(hooksRoot, entry.name), 'utf8'),
      })
    }
  }
  return hooks
}

/**
 * 扫描真实仓库并运行全部校验。返回 { inventory: { skills, hooks }, diagnostics }。
 */
export async function auditRepository(repoRoot, options = {}) {
  const skills = []

  const pluginsRoot = path.join(repoRoot, 'resources', 'plugins')
  const pluginSkillRoots = (await listDirectories(pluginsRoot)).map(
    (pluginName) => `resources/plugins/${pluginName}/skills`,
  )
  skills.push(...(await collectSkillFiles(repoRoot, pluginSkillRoots)))
  skills.push(...(await collectSkillFiles(repoRoot, ['resources/codex-skills'])))
  skills.push(...(await collectSkillFiles(repoRoot, ['skills'])))

  const firstPartySourceRoot = 'resources/first-party-skills'
  const sourceSkills = await collectSkillFiles(repoRoot, [firstPartySourceRoot])
  skills.push(...sourceSkills)

  const legacyInlinePath = path.join(repoRoot, 'src', 'main', 'agent', 'firstPartySkills.ts')
  if (await pathExists(legacyInlinePath)) {
    const legacySource = await readFile(legacyInlinePath, 'utf8')
    for (const inline of extractFirstPartySkillsFromTypeScript(
      legacySource,
      'src/main/agent/firstPartySkills.ts',
    )) {
      skills.push({ path: inline.path, content: inline.content })
    }
  }

  const generatedRelativePath = 'src/main/agent/generated/firstPartySkills.generated.ts'
  const generatedAbsolutePath = path.join(repoRoot, ...generatedRelativePath.split('/'))
  const generatedExists = await pathExists(generatedAbsolutePath)
  let generatedSkills = []
  if (generatedExists) {
    const generatedSource = await readFile(generatedAbsolutePath, 'utf8')
    generatedSkills = extractFirstPartySkillsFromTypeScript(
      generatedSource,
      generatedRelativePath,
    ).map((entry) => ({ path: entry.path, content: entry.content }))
  }

  const hooks = await collectHookFiles(repoRoot)
  const snapshot = {
    skills,
    hooks,
    firstParty: {
      sourceExists: await pathExists(path.join(repoRoot, ...firstPartySourceRoot.split('/'))),
      generatedExists,
      sourceSkills,
      generatedSkills,
    },
  }

  return {
    inventory: { skills, hooks },
    diagnostics: validateArchitecture(snapshot, options),
  }
}
