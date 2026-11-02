import type { WorkbenchCardDragItem } from '../file-explorer/dragHelpers'

/**
 * 工作台卡片 → 一份可读的「卡片清单」(Markdown)。
 *
 * **任何状态的卡都配一份**(草稿 / 渲染中 / 失败 / 已完成),拖进聊天栏时与产物(视频
 * 文件或地址)一起递给模型。产物 URL 只是清单里的一节,**不是**「没有产物时的替代品」:
 * - 产物只说明「生成了什么」;清单说明「怎么生成的」(提示词、规格、素材名)、「现在
 *   在哪」(本地 / 云端地址、任务号)和「出过哪几版」。换机器、换会话、本地 mp4 被 7 天
 *   清理之后,只剩一个 URL 是复现不了的。
 * - 模型据清单就知道有哪几版、各自在哪,而不必为了知道这些再去调一遍工作台工具。
 *
 * **篇幅纪律**(别让清单把一次读取变贵):当前版本的提示词给全文,历史版本只给
 * 「地址 + 提示词首行(≤120 字)」;要某一版的完整提示词用 `video_workbench_export`
 * 按 cardId 读。素材只记展示名,绝不带 `data:` URL 或字节。
 *
 * 为什么是「文档」而不是别的:聊天栏的附件(`AgentAttachmentInput`)必须二选一地给出
 * `path` 或 `buffer`。合成文档走 buffer,主进程 AttachmentService 会把它落进
 * `<userData>/agent/uploads/<sha>.md`,buildPromptWithAttachments 再把那个路径写进
 * 提示词。注意提示词里只有那一行路径、**不内联全文**:模型要用自己的文件工具打开
 * 这个路径才能读到清单(这样长清单不会每轮都占 token)。
 *
 * 文档里刻意带上 `cardId`:模型据此可以直接调 video_workbench 工具改这张卡或启动
 * 生成,而不是只能干看一份描述。
 *
 * **每个字段都当作外来数据读。** 载荷来自 DataTransfer,而聊天栏接受来自任何地方的
 * 拖放 —— 一个外部页面在 dragstart 里照样能写我们这个 MIME。parseWorkbenchCardDrop
 * 只校验到 cardId 是字符串就放行(它的纪律是「载荷损坏按没有卡片处理,不抛」),所以
 * 形状兜底得在这里做:一个 `spec.prompt` 是对象的伪造载荷不该让整个 drop 静默失败。
 */
export function buildWorkbenchCardDoc(item: WorkbenchCardDragItem): string {
  return [
    '# 视频工作台卡片',
    '',
    '> 这张卡的清单:意图(提示词与规格)+ 现状(状态、任务号、产物地址)+ 历史版本。素材字节不在其中。',
    '',
    ...renderCard(item, '##'),
  ].join('\n')
}

/**
 * 多张卡合成**一份**清单:每张卡一个 `## 卡片 <id>` 段。
 *
 * 为什么不是每张卡一份:聊天栏附件上限 20,10 张完成卡各挂「视频 + 清单」就正好占满;
 * 合并之后清单只占 1 个位置,视频才有位置挂。
 */
export function buildWorkbenchCardsDoc(items: WorkbenchCardDragItem[]): string {
  const lines: string[] = [
    `# 视频工作台卡片(共 ${items.length} 张)`,
    '',
    '> 每张卡一个「## 卡片 <id>」段:意图(提示词与规格)+ 现状(状态、任务号、产物地址)+ 历史版本。素材字节不在其中。',
  ]
  for (const item of items) {
    lines.push('', `## 卡片 ${safeId(item.cardId)}`, '', ...renderCard(item, '###'))
  }
  return lines.join('\n')
}

/** 附件名。同一张卡反复拖进来会命中主进程的内容寻址去重,所以名字里带 id 前缀就够。 */
export function workbenchCardDocName(item: WorkbenchCardDragItem): string {
  return `workbench-card-${safeId(item.cardId).replace(/[^\w.-]/g, '_').slice(0, 8)}.md`
}

/** 合并清单的附件名。 */
export function workbenchCardsDocName(count: number): string {
  return `workbench-cards-${count}.md`
}

/** 版本列表最多列几版(最近的)。一张卡重生成上百次也不该把清单撑成长文。 */
const MAX_LISTED_VERSIONS = 20
/** 历史版本里提示词首行最多留多少字(当前版本的全文在「提示词」段)。 */
const MAX_VERSION_PROMPT_CHARS = 120
/** 一个地址最长多少字符。超过的当不可信丢掉,**不截断**:截断过的 URL 是错的。 */
const MAX_URL_CHARS = 4000
const MAX_PATH_CHARS = 1000
/** 项目名 / 分段名 / 错误文本这类自由文本的上限。 */
const MAX_LABEL_CHARS = 80
const MAX_ERROR_CHARS = 1000

/**
 * 一张卡的正文。`h` 是小节标题前缀:单卡用 `##`,合并清单里每张卡嵌在
 * `## 卡片 <id>` 之下,所以用 `###`。
 */
function renderCard(item: WorkbenchCardDragItem, h: '##' | '###'): string[] {
  const product = productOf(item)
  const versions = asVersions(item.versions)
  const currentSeq = item.status === 'succeeded' && versions.length > 0 ? versions[versions.length - 1].seq : null

  const lines: string[] = [`- 卡片 id:\`${safeId(item.cardId)}\``]
  const project = oneLine(item.projectName, MAX_LABEL_CHARS)
  const board = oneLine(item.boardName, MAX_LABEL_CHARS)
  if (project) lines.push(`- 项目:${project}`)
  if (board) lines.push(`- 分段:${board}`)
  lines.push(`- 状态:${describeStatus(item.status, product.any, currentSeq)}`)
  const error = oneLine(item.error, MAX_ERROR_CHARS)
  if (error) lines.push(`- 错误:${error}`)

  const spec = asRecord(item.spec)
  let prompt = ''
  if (spec) {
    prompt = typeof spec.prompt === 'string' ? spec.prompt.trim() : ''
    lines.push(
      `- 规格:${describeSpec(spec)}`,
      `- 音频:${spec.generateAudio ? '生成' : '不生成'}`,
      `- 生成模式:${asText(spec.mode)}`,
      `- 请求种子:${typeof spec.seed === 'number' ? String(spec.seed) : '随机'}`,
    )
    // 实际种子是结果不是意图:与请求种子分开写,请求是随机时它才是复现这一版的钥匙。
    if (typeof item.actualSeed === 'number' && Number.isFinite(item.actualSeed)) {
      lines.push(`- 实际种子:${item.actualSeed}`)
    }
    lines.push(`- 联网搜索增强:${spec.webSearch ? '开' : '关'}`)
  }

  const taskId = tokenText(item.taskId)
  const upstreamTaskId = tokenText(item.upstreamTaskId)
  if (taskId) lines.push(`- 任务号(网关):\`${taskId}\``)
  if (upstreamTaskId) lines.push(`- 上游任务号:\`${upstreamTaskId}\``)
  const created = formatTime(item.createdAt)
  if (created) lines.push(`- 创建时间:${created}`)

  if (!spec) {
    // 老版本渲染进程写的载荷没有 spec(或者形状不对)。少一半信息也仍然比「只弹一句
    // 提示」有用:模型至少拿到了 cardId,能自己去查这张卡。
    lines.push('', '(拖拽载荷里没有规格摘要 —— 请用 video_workbench 工具按上面的 id 读取这张卡。)')
  } else {
    lines.push('', `${h} 提示词`, '', prompt || '(空)')
  }

  lines.push('', ...artifactSection(item, h, product, currentSeq, versions.length))
  lines.push(...historySection(item, h, versions))

  if (spec) {
    const brief = asRecord(spec.referenceBrief) ?? {}
    lines.push(
      '',
      `${h} 参考素材`,
      '',
      // 只有名字是刻意的:素材源可能是 data: URL,原样带进来会让清单膨胀到几十 MB。
      '(以下只列展示名。素材字节不在这份清单里 —— 需要看图请用 video_workbench 工具读这张卡。)',
      '',
      `- 参考图${countSuffix(brief.images)}:${joinNames(brief.images)}`,
      `- 参考视频${countSuffix(brief.videos)}:${joinNames(brief.videos)}`,
      `- 参考音频${countSuffix(brief.audios)}:${joinNames(brief.audios)}`,
    )
  }
  lines.push('')
  return lines
}

interface Product {
  local: string | null
  remote: string | null
  temp: string | null
  any: boolean
}

function productOf(item: WorkbenchCardDragItem): Product {
  const local = pathText(item.localPath)
  const remote = urlText(item.remoteUrl)
  const temp = urlText(item.videoUrl)
  return { local, remote, temp, any: Boolean(local || remote || temp) }
}

/**
 * 「产物」段:这张卡**现在**的结果在哪。
 *
 * 本地路径随时可能已被 7 天清理扫掉(卡片对那个清理是隐形的),而这里是纯函数、
 * 没法看磁盘,所以如实标注「可能已被清理」,把云端地址标成耐久来源,让模型自己权衡。
 */
function artifactSection(
  item: WorkbenchCardDragItem,
  h: string,
  product: Product,
  currentSeq: number | null,
  versionCount: number,
): string[] {
  const lines: string[] = [`${h} 产物`, '']

  if (!product.any) {
    lines.push(
      item.status === 'succeeded'
        ? '- 当前结果:成功过,但产物地址已全部失效(本地文件被清理,云端也没有留下)'
        : '- 当前结果:暂无(原因见上面的状态)',
    )
    // 重新生成会清掉这一轮的结果地址,但上一轮的成品还躺在版本存档里。
    if (versionCount > 0) lines.push(`- 之前出过 ${versionCount} 版,见下面「历史版本」`)
    return lines
  }

  if (currentSeq !== null) lines.push(`- 当前版本:v${currentSeq}`)
  lines.push(
    `- 本地文件:${product.local ?? '无'}`,
    `- 云端地址(永久):${product.remote ?? '无'}`,
    `- 上游临时地址(有效期未知):${product.temp ?? '无'}`,
  )
  const completed = formatTime(item.completedAt)
  if (completed) lines.push(`- 完成时间:${completed}`)
  lines.push('', '(本地文件可能已被 7 天清理;云端地址是耐久来源。)')
  return lines
}

/**
 * 「历史版本」段:每版一行 `vN · 时间 · 规格 · 地址 · 提示词首行`。
 * 地址只挑一个最耐久的(云端 > 本地 > 临时),当前版本的全部地址在「产物」段。
 */
function historySection(item: WorkbenchCardDragItem, h: string, versions: VersionRecord[]): string[] {
  if (versions.length === 0) return []
  const listed = versions.slice(-MAX_LISTED_VERSIONS)
  const id = safeId(item.cardId)
  return [
    '',
    listed.length < versions.length
      ? `${h} 历史版本(共 ${versions.length} 版,只列最近 ${listed.length} 版)`
      : `${h} 历史版本(共 ${versions.length} 版)`,
    '',
    `(每版只留地址和提示词首行。某一版的完整提示词用 \`video_workbench_export({ cardIds: ${JSON.stringify([id])} })\` 读取。)`,
    '',
    ...listed.map(describeVersion),
  ]
}

type VersionRecord = Record<string, unknown> & { seq: number }

function asVersions(value: unknown): VersionRecord[] {
  if (!Array.isArray(value)) return []
  const out: VersionRecord[] = []
  for (const entry of value) {
    const record = asRecord(entry)
    if (record && typeof record.seq === 'number' && Number.isFinite(record.seq)) {
      out.push(record as VersionRecord)
    }
  }
  return out
}

function describeVersion(version: VersionRecord): string {
  const parts: string[] = [`v${version.seq}`]
  const when = formatTime(version.createdAt)
  if (when) parts.push(when)
  const specText = describeVersionSpec(version)
  if (specText) parts.push(specText)
  const remote = urlText(version.remoteUrl)
  const local = pathText(version.localPath)
  const temp = urlText(version.videoUrl)
  if (remote) parts.push(`云端:${remote}`)
  else if (local) parts.push(`本地:${local}`)
  else if (temp) parts.push(`临时:${temp}`)
  else parts.push('地址已失效')
  const first = firstLine(version.prompt, MAX_VERSION_PROMPT_CHARS)
  if (first) parts.push(`提示词:${first}`)
  return `- ${parts.join(' · ')}`
}

function describeVersionSpec(version: VersionRecord): string {
  const bits: string[] = []
  if (typeof version.model === 'string' && version.model) bits.push(`seedance-${version.model}`)
  if (typeof version.resolution === 'string' && version.resolution) bits.push(version.resolution)
  if (typeof version.duration === 'number') bits.push(describeDuration(version.duration))
  return bits.join(' ')
}

/**
 * 状态行的文案。`succeeded` 要看产物在不在:有地址就是「成功」(并带上当前是第几版),
 * 没地址才是「成功过,但产物地址已全部失效」—— 后者对完成卡是事实、对有产物的完成卡
 * 却是谎话,所以不能只看 status。
 */
function describeStatus(status: unknown, hasProduct: boolean, currentSeq: number | null): string {
  switch (status) {
    case 'draft':
      return '草稿(还没提交生成)'
    case 'preparing':
      return '准备中(素材上送 / 创建任务)'
    case 'queued':
      return '排队中(上游已受理,尚未开始渲染)'
    case 'running':
      return '渲染中'
    case 'failed':
      return '失败(可重试)'
    case 'cancelled':
      return '已取消'
    case 'succeeded':
      if (!hasProduct) return '成功过,但产物地址已全部失效(本地文件被清理,云端也没有留下)'
      return currentSeq !== null ? `成功(当前 v${currentSeq})` : '成功'
    default:
      return typeof status === 'string' && status ? status : '未知'
  }
}

function describeSpec(spec: Record<string, unknown>): string {
  return `seedance-${asText(spec.model)} · ${asText(spec.resolution)} · ${asText(spec.ratio)} · ${describeDuration(spec.duration)}`
}

function describeDuration(duration: unknown): string {
  if (typeof duration !== 'number') return '未知时长'
  return duration === -1 ? '智能时长(模型决定)' : `${duration}s`
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asText(value: unknown): string {
  return typeof value === 'string' && value ? value : '未知'
}

function asNames(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((name): name is string => typeof name === 'string') : []
}

function countSuffix(value: unknown): string {
  const count = asNames(value).length
  return count > 0 ? `(${count})` : ''
}

function joinNames(value: unknown): string {
  const names = asNames(value)
  return names.length > 0 ? names.join('、') : '无'
}

/**
 * 卡片 id 要进标题和反引号:控制字符(含换行)一律换成下划线,别让一个伪造的 id
 * 把一行写成多行 Markdown;不是字符串就写「未知」。
 */
function safeId(value: unknown): string {
  if (typeof value !== 'string') return '未知'
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f`]/g, '_').trim()
  return text ? text.slice(0, 80) : '未知'
}

/** 任务号:只认 `[A-Za-z0-9_.:-]`(`task_…` / `cgt-…` / uuid 都在内),别的一律不写。 */
function tokenText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text && text.length <= 200 && /^[\w.:-]+$/.test(text) ? text : null
}

/** 折成一行(换行会把一个字段写成多行 Markdown)并截长;不是字符串或空 → null。 */
function oneLine(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const text = value.replace(/\s+/g, ' ').trim()
  if (!text) return null
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 第一行非空文字,截长;一版提示词很长也只露个头。 */
function firstLine(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const line = value.split(/\r?\n/).map((part) => part.trim()).find((part) => part.length > 0)
  if (!line) return null
  return line.length > max ? `${line.slice(0, max)}…` : line
}

/** 本地路径:一行文本即可,路径里的空格要原样保留,所以只处理换行。 */
function pathText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.replace(/[\r\n]+/g, ' ').trim()
  return text && text.length <= MAX_PATH_CHARS ? text : null
}

/**
 * 地址:只认 http(s)、不含空白、不超长。`data:` 之类一律不收 —— 一个伪造载荷的
 * `remoteUrl` 不该让清单膨胀,也不该让一个看不出是什么的串被当成「云端地址」。
 */
function urlText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text || text.length > MAX_URL_CHARS) return null
  return /^https?:\/\/\S+$/i.test(text) ? text : null
}

function formatTime(value: unknown): string | null {
  // NaN / ±Infinity 造出来的是 Invalid Date,下面那一道就够了,不再重复判有限。
  if (typeof value !== 'number') return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
