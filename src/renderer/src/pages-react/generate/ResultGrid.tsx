import { useMemo, useState } from 'react'
import type { GenerateRun, ResultUploadMeta } from '../../stores/useGenerateStore'
import { useGenerateStore } from '../../stores/useGenerateStore'
import { StatusCard } from '../../components/shared/result-cards/StatusCard'
import { CosResultThumb, DoneMarks, UploadBadge } from '../../components/shared/result-cards/CosResultThumb'
import { buildDownloadFilename, downloadImage } from '../../components/shared/result-cards/download'
import ImageEditToolbar from '../../components/shared/image-editors/ImageEditToolbar'
import ImageEditorModal from '../../components/shared/image-editors/ImageEditorModal'
import { addImageUrlToReferences } from '../../components/shared/image-editors/referenceTargets'
import { LayerStackViewer } from './LayerStackViewer'

/**
 * 把平行数组按 `layerGroupId` 收成「渲染单元」。
 *
 * 一次图层拆分产出 1 底图 + N 层,它们是**一个带内部结构的产物**,不是 N 个互不相干
 * 的结果 —— 平铺进网格会让用户以为自己一次生成了 17 张图。所以同组收成一张卡片,
 * 点开进 LayerStackViewer。
 *
 * 保留原索引:放大预览 / 重编辑都按父组件那份 urls 的下标回调,收组不能打乱它。
 */
interface GridItem {
  /** 卡片代表的图在原数组里的索引（图层组取底图那张）。 */
  index: number
  /** 图层组的全部成员（含底图），按原索引升序；非图层组为空。 */
  group?: Array<{ index: number; url: string; meta: ResultUploadMeta }>
}

export function groupResultItems(urls: string[], meta?: ResultUploadMeta[]): GridItem[] {
  const items: GridItem[] = []
  const groupPos = new Map<string, number>()

  urls.forEach((url, index) => {
    const m = meta?.[index]
    const gid = m?.layerGroupId
    if (!gid || !m) {
      items.push({ index })
      return
    }
    const member = { index, url, meta: m }
    const at = groupPos.get(gid)
    if (at === undefined) {
      groupPos.set(gid, items.length)
      // 卡片先认第一张为代表；下面遇到 zIndex 更小的（底图）再让位。
      items.push({ index, group: [member] })
      return
    }
    const item = items[at]
    item.group!.push(member)
    // 卡片封面用底图（zIndex 最小）—— 拿一张透明图层当封面等于一张空白卡。
    const coverZ = meta?.[item.index]?.layer?.zIndex ?? 0
    if ((m.layer?.zIndex ?? 0) < coverZ) item.index = index
  })

  return items
}

interface ResultGridProps {
  /**
   * 展示用 URL 列表。已经经过 store 层的热切:
   * - 异步上传完成后,这里的元素会被替换成 cosUrl(持久化)
   * - 上传中/失败时,这里仍是 modelUrl(临时签名)
   *
   * UI 不用关心这个细节,直接渲染即可。
   */
  urls: string[]
  /**
   * 与 `urls` 一一对齐(同索引)的元数据。用于角标提示上传状态 + 重编辑快照。
   * 不传也能用 —— 兼容老调用方。
   */
  meta?: ResultUploadMeta[]
  /** 在飞 / 失败的 generate() —— RUN / ERR 卡(设计稿 M5)。不传 = 只画结果卡。 */
  runs?: GenerateRun[]
  /**
   * 点击 [重编辑] 按钮时被调用, 接收该结果对应的 snapshot。
   * 父组件负责把 snapshot 灌回 useGenerateStore + 把 tab 切到 generate。
   * 若不传或 meta[i].snapshot 不存在, 按钮自动隐藏(保持向后兼容)。
   */
  onEditFromResult?: (snapshot: NonNullable<ResultUploadMeta['snapshot']>) => void
  /**
   * 点击缩略图放大预览。父组件用同一份 urls + 该图索引打开共享 ImageLightbox,
   * 支持在结果集里左右切换。不传时缩略图不可点。
   */
  onPreview?: (index: number) => void
  /**
   * 提供后,每张结果图的悬停工具栏出现「图层分离」。图层组自己的卡片不显示
   * (它已经是拆分产物了,再拆一次没有意义)。
   */
  onLayerSplit?: (imageUrl: string) => void
  /** × 移除一张结果(图层组整组移除)。不传时按钮隐藏。 */
  onRemoveResult?: (id: string) => void
  /** 失败卡「重试」。 */
  onRetryRun?: (runId: string) => void
  /** 失败卡 ×。 */
  onDismissRun?: (runId: string) => void
  /** RUN 卡「已用 / 预计」的预计值(秒),按模型给;不给就只显示已用。 */
  expectedSecondsFor?: (modelKey: string) => number | undefined
  /** 元数据行里模型的短名;不给就显示 modelKey。 */
  modelLabelFor?: (modelKey: string) => string
}

type EditorType = 'angle' | 'light' | 'panorama' | 'director'

function formatElapsed(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms)) return undefined
  return `${(ms / 1000).toFixed(1)}s`
}

function joinMeta(parts: Array<string | undefined>): string | undefined {
  const kept = parts.filter((p): p is string => !!p && p.length > 0)
  return kept.length ? kept.join(' · ') : undefined
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard?.writeText(text)
  } catch {
    // 剪贴板不可用(测试环境 / 权限)时静默 —— 文案本身仍在卡上,hover 可见全文。
  }
}

export function ResultGrid({
  urls,
  meta,
  runs = [],
  onEditFromResult,
  onPreview,
  onLayerSplit,
  onRemoveResult,
  onRetryRun,
  onDismissRun,
  expectedSecondsFor,
  modelLabelFor,
}: ResultGridProps) {
  const [editorState, setEditorState] = useState<{ url: string; type: EditorType } | null>(null)
  const [layerGroup, setLayerGroup] = useState<GridItem['group'] | null>(null)
  const items = useMemo(() => groupResultItems(urls, meta), [urls, meta])

  // 结果卡新在前:按入库时刻,没有(老数据)就按下标。运行中 / 失败卡由 runs 的顺序
  // (store 里已是新在前)决定,统一排在结果卡前面 —— 点「开始生成」的一瞬间 RUN 卡
  // 就出现在结果区第一格。
  const orderedItems = useMemo(
    () =>
      [...items].sort((a, b) => {
        const ta = meta?.[a.index]?.createdAt ?? a.index
        const tb = meta?.[b.index]?.createdAt ?? b.index
        return tb - ta || b.index - a.index
      }),
    [items, meta],
  )
  const runningRuns = runs.filter((r) => r.status === 'running')
  const failedRuns = runs.filter((r) => r.status === 'error')
  const orderedRuns = [...runningRuns, ...failedRuns]

  // 注入 360 提示词 / 全景反推:追加到生成框 prompt 尾部。
  const injectPrompt = (p: string) => {
    const { prompt, setPrompt } = useGenerateStore.getState()
    setPrompt(prompt ? `${prompt}\n${p}` : p)
  }

  if (urls.length === 0 && runs.length === 0) {
    return (
      <div className="st-hatch relative border-2 border-dashed border-zinc-800 px-4 py-12 text-center" data-testid="result-grid-empty">
        <span aria-hidden className="st-tick st-tick-tl">+</span>
        <span aria-hidden className="st-tick st-tick-tr">+</span>
        <span aria-hidden className="st-tick st-tick-bl">+</span>
        <span aria-hidden className="st-tick st-tick-br">+</span>
        <span aria-hidden className="st-cross mx-auto mb-3.5 block text-zinc-500" />
        <div className="font-orbitron text-base uppercase tracking-wider text-zinc-400">
          生成的图片将在这里显示
        </div>
        <div className="mt-1 font-mono text-[11px] text-zinc-500">
          // 输入提示词,点"开始生成"后结果会在此处展示,点缩略图可放大预览
        </div>
        <span className="absolute bottom-2 left-3 font-mono text-[9px] uppercase tracking-[0.08em] text-zinc-600">OUTPUT_SLOT · EMPTY</span>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
      {orderedRuns.map((run, i) => {
        const label = modelLabelFor?.(run.modelKey) ?? run.modelKey
        const seq = urls.length + (orderedRuns.length - i) - 1
        return (
          <StatusCard
            key={run.id}
            data-testid={`run-card-${run.id}`}
            index={seq}
            status={run.status}
            prompt={run.prompt || (run.overrides.layerDecomposition ? '图层分离' : '')}
            startedAt={run.startedAt}
            expectedSeconds={run.status === 'running' ? expectedSecondsFor?.(run.modelKey) : undefined}
            error={run.error}
            meta={joinMeta([label, run.ratio, run.resolution, run.status === 'running' ? '进行中' : undefined])}
            onEdit={onEditFromResult ? () => onEditFromResult(run.snapshot) : undefined}
            onRetry={run.status === 'error' && onRetryRun ? () => onRetryRun(run.id) : undefined}
            onCopyError={run.status === 'error' && run.error ? () => void copyText(run.error!) : undefined}
            onRemove={run.status === 'error' && onDismissRun ? () => onDismissRun(run.id) : undefined}
          />
        )
      })}

      {orderedItems.map(({ index: i, group }) => {
        const url = urls[i]
        const m = meta?.[i]
        const snapshot = m?.snapshot
        const canEdit = !!(onEditFromResult && snapshot)
        // 图层组:整张卡片改成「进图层查看器」,而不是放大单张。放大一张透明图层
        // 对用户毫无意义,他要的是图层栈。
        const openGroup = group ? () => setLayerGroup(group) : undefined
        const activate = openGroup ?? (onPreview ? () => onPreview(i) : undefined)
        const label = m?.modelKey ? (modelLabelFor?.(m.modelKey) ?? m.modelKey) : (snapshot?.modelKey ? (modelLabelFor?.(snapshot.modelKey) ?? snapshot.modelKey) : undefined)
        const metaLine = group
          ? joinMeta([label, '图层分离', `${group.length} 层`])
          : joinMeta([label, snapshot?.ratio, m?.resolution, formatElapsed(m?.elapsedMs)])
        const alt = group ? '图层分离底图' : `Result ${i + 1}`

        return (
          <StatusCard
            key={m?.id ?? `${i}-${url}`}
            data-testid={m ? `result-card-${m.id}` : undefined}
            index={i}
            status="done"
            prompt={snapshot?.prompt ?? ''}
            meta={metaLine}
            media={<CosResultThumb url={url} alt={alt} localPath={m?.localPath} size={1024} />}
            overlay={
              <>
                {group ? (
                  <span
                    className="absolute left-1 top-1 border border-cyberpunk-yellow/70 bg-zinc-950/85 px-1.5 py-px font-mono text-[10px] font-bold uppercase tracking-wider text-cyberpunk-yellow"
                    data-testid="layer-group-badge"
                  >
                    {`▤ ${group.length} 层`}
                  </span>
                ) : (
                  <ImageEditToolbar
                    theme="default"
                    imageUrl={url}
                    onOpenEditor={(type) => setEditorState({ url, type })}
                    onInjectPrompt={injectPrompt}
                    onAddReference={(u) => addImageUrlToReferences('generate', u)}
                    onLayerSplit={onLayerSplit}
                  />
                )}
                <UploadBadge status={m?.uploadStatus} error={m?.uploadError} />
                <DoneMarks />
              </>
            }
            onOpen={activate}
            onEdit={canEdit ? () => onEditFromResult!(snapshot!) : undefined}
            editTitle={group ? '把这次拆分用的 prompt / 比例 / 参考图灌回输入框' : undefined}
            onDownload={() => void downloadImage(url, buildDownloadFilename('generate', i, snapshot?.prompt ?? ''))}
            onRemove={
              onRemoveResult && m
                ? () => {
                    if (group) for (const member of group) onRemoveResult(member.meta.id)
                    else onRemoveResult(m.id)
                  }
                : undefined
            }
          />
        )
      })}

      {editorState && (
        <ImageEditorModal
          key={editorState.type}
          editorType={editorState.type}
          imageUrl={editorState.url}
          theme="default"
          directorEntry={editorState.type === 'director' ? 'panorama' : 'native'}
          onInjectPrompt={injectPrompt}
          onClose={() => setEditorState(null)}
        />
      )}
      {layerGroup && (
        <LayerStackViewer
          layers={layerGroup.map((g) => ({
            id: g.meta.id,
            // 用 urls[i] 而不是 meta 里存的地址:上传完成后 store 会把它热切成
            // cosUrl,用 meta 自带的那份等于用一条会过期的临时链接。
            url: g.url,
            zIndex: g.meta.layer?.zIndex ?? 0,
            ...(g.meta.layer?.name ? { name: g.meta.layer.name } : {}),
            ...(g.meta.layer?.description ? { description: g.meta.layer.description } : {}),
            ...(g.meta.layer?.boundingBox ? { boundingBox: g.meta.layer.boundingBox } : {}),
          }))}
          onClose={() => setLayerGroup(null)}
        />
      )}
    </div>
  )
}
