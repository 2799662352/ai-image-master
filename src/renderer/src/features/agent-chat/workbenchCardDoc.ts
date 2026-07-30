import type { WorkbenchCardDragItem } from '../file-explorer/dragHelpers'

/**
 * 还没有产物的工作台卡片 → 一份可读的规格说明(Markdown)。
 *
 * 为什么是「文档」而不是「视频」:这张卡磁盘上确实没有任何文件,而聊天栏的附件
 * (`AgentAttachmentInput`)必须二选一地给出 `path` 或 `buffer`。合成文档走 buffer,
 * 主进程 AttachmentService 会把它落进 `<userData>/agent/uploads/<sha>.md`,
 * buildPromptWithAttachments 再把那个路径写进提示词 —— 于是模型既拿得到内容,也拿
 * 得到一个自己的文件工具能打开的路径。
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
  const lines: string[] = [
    '# 视频工作台卡片(还没有产物)',
    '',
    `- 卡片 id:\`${item.cardId}\``,
    `- 状态:${describeStatus(item.status)}`,
  ]
  if (typeof item.error === 'string' && item.error) lines.push(`- 错误:${item.error}`)

  const spec = asRecord(item.spec)
  if (!spec) {
    // 老版本渲染进程写的载荷没有 spec(或者形状不对)。少一半信息也仍然比「只弹一句
    // 提示」有用:模型至少拿到了 cardId,能自己去查这张卡。
    lines.push(
      '',
      '(拖拽载荷里没有规格摘要 —— 请用 video_workbench 工具按上面的 id 读取这张卡。)',
      '',
    )
    return lines.join('\n')
  }

  const brief = asRecord(spec.referenceBrief) ?? {}
  const prompt = typeof spec.prompt === 'string' ? spec.prompt.trim() : ''
  lines.push(
    `- 规格:seedance-${asText(spec.model)} · ${asText(spec.resolution)} · ${asText(spec.ratio)} · ${describeDuration(spec.duration)}`,
    `- 音频:${spec.generateAudio ? '生成' : '不生成'}`,
    `- 生成模式:${asText(spec.mode)}`,
    `- 种子:${typeof spec.seed === 'number' ? String(spec.seed) : '随机'}`,
    `- 联网搜索增强:${spec.webSearch ? '开' : '关'}`,
    '',
    '## 提示词',
    '',
    prompt || '(空)',
    '',
    '## 参考素材',
    '',
    // 只有名字是刻意的:素材源可能是 data: URL,原样带进来会让这份说明膨胀到几十 MB。
    '(以下只列展示名。素材字节不在这份说明里 —— 需要看图请用 video_workbench 工具读这张卡。)',
    '',
    `- 参考图${countSuffix(brief.images)}:${joinNames(brief.images)}`,
    `- 参考视频${countSuffix(brief.videos)}:${joinNames(brief.videos)}`,
    `- 参考音频${countSuffix(brief.audios)}:${joinNames(brief.audios)}`,
    '',
  )
  return lines.join('\n')
}

/** 附件名。同一张卡反复拖进来会命中主进程的内容寻址去重,所以名字里带 id 前缀就够。 */
export function workbenchCardDocName(item: WorkbenchCardDragItem): string {
  return `workbench-card-${item.cardId.slice(0, 8)}.md`
}

function describeStatus(status: unknown): string {
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
      // 走到这里说明状态是成功但三级地址一个都没留下 —— 本地被清理、云端也没有。
      return '成功过,但产物地址已全部失效'
    default:
      return typeof status === 'string' && status ? status : '未知'
  }
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
