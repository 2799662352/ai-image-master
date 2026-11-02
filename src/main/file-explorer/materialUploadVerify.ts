import { ipcMain, net } from 'electron'
import fs from 'node:fs/promises'

/**
 * `media:verify-uploaded-materials` —— 视频工作台素材「预传地址」落库后的体检。
 *
 * 背景:拖进工作台的本地素材会立刻传到中转桶(见 renderer `materialPreupload`),拿到一个
 * COS 地址挂在素材的 `uploadedUrl` 上。这个地址以前**不落库**,重启后丢掉、提交时重传一遍
 * (而且每次是个新的随机地址)。现在落库了 —— 于是「用之前确认它还对」就成了必须做的事:
 *
 * - **本地文件被改过**:拿旧地址提交的是旧字节。这种错最难查(任务照样成功,只是素材不对),
 *   所以指纹用 `size + mtimeMs`,宁可误判成「变了」也不放过;
 * - **云端对象没了**:拿死链去提交,失败后重试仍是同一个死链,这张卡就永久废了。
 *
 * 判定底线:**拿不准就丢掉缓存地址**。丢掉的代价只是回到「提交时由主进程从本地路径现传」
 * 的老行为(慢一点,但一定对);留着一个不确定的地址才有风险。唯一的例外是「本地没变、
 * 云端暂时探不通(断网 / 5xx)」—— 此时丢掉等于对一个可能几 GB 的视频白白重传,所以保留;
 * 真死了的话,下次提交会再探一次(只有探到 alive 才会被渲染端记成本会话已确认)。
 *
 * 本地文件已不存在(被 7 天清理扫掉 / 换了机器)并不是丢弃理由:这时云端地址反而是
 * 唯一的来源,只要它还活着就该留着。
 *
 * **安全边界**:HEAD 只发给本应用自己的 COS 域名(`https://*.myqcloud.com`),这条 IPC
 * 不能被当成任意 URL 探测器;`fs.stat` 只读元数据,不读内容、不回传路径以外的信息。
 * (渲染进程本就是 nodeIntegration 开着的,这里防的是调用方失误,而不是恶意渲染进程。)
 */

/** 渲染端要体检的一条素材。 */
export interface UploadedMaterialProbe {
  /** 素材当前的 src(本地绝对路径)。 */
  src: string
  /** 缓存的预传 COS 地址。 */
  uploadedUrl: string
  /** 预传当时的指纹。缺失(旧数据 / 当时没取到)一律视为「验证不了」。 */
  uploadedFrom?: { src: string; size?: number; mtimeMs?: number }
}

export type LocalState = 'same' | 'changed' | 'missing' | 'unverifiable'
export type RemoteState = 'alive' | 'dead' | 'unknown' | 'skipped'

export interface UploadedMaterialVerdict {
  /** 这个缓存地址还能不能继续用。 */
  keep: boolean
  local: LocalState
  remote: RemoteState
}

export interface VerifyOptions {
  /** 要不要探云端。启动时只验本地(便宜,上千条也无妨);提交前才探云端。 */
  checkRemote: boolean
}

export interface VerifyDeps {
  /** 对一个地址发 HEAD,返回状态码。抛错 = 网络不通 / 超时。 */
  head: (url: string) => Promise<{ status: number }>
}

/** mtime 容差(毫秒):不同文件系统取整精度不一,≤1ms 的差不算变。 */
const MTIME_TOLERANCE_MS = 1
/** 云端探活并发上限。 */
const HEAD_CONCURRENCY = 12
/** 单次 HEAD 超时。批量里最坏 = ceil(n/并发) × 超时,所以宁可短一点。 */
const HEAD_TIMEOUT_MS = 5_000
/** 单次 IPC 最多处理多少条(防误传超大数组)。 */
const MAX_ITEMS = 2_000

/** 只认本应用自己的 COS 地址:`https://<桶>.cos.<区域>.myqcloud.com/...`。 */
function isOwnCosUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' && /(^|\.)myqcloud\.com$/i.test(u.hostname)
  } catch {
    return false
  }
}

async function localState(p: UploadedMaterialProbe): Promise<LocalState> {
  const from = p.uploadedFrom
  // 指纹绑的是预传那一刻的路径。素材的 src 被换过(撤销 / agent 改写)就不是同一个文件了。
  if (!from || typeof from.src !== 'string') return 'unverifiable'
  if (from.src !== p.src) return 'changed'
  if (typeof from.size !== 'number' || typeof from.mtimeMs !== 'number') return 'unverifiable'
  try {
    const st = await fs.stat(p.src)
    if (!st.isFile()) return 'missing'
    if (st.size !== from.size) return 'changed'
    if (Math.abs(st.mtimeMs - from.mtimeMs) > MTIME_TOLERANCE_MS) return 'changed'
    return 'same'
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    // 路径不存在才算 missing;权限不足 / 驱动器离线等说不清的,当验证不了。
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unverifiable'
  }
}

function statusToRemote(status: number): RemoteState {
  if (status >= 200 && status < 300) return 'alive'
  // 对象没了 / 被撤权 / 已清理。COS 对不存在的对象在公有读桶上回 404,在私有读桶回 403。
  if (status === 404 || status === 403 || status === 410) return 'dead'
  // 5xx / 429 / 其它:云端的问题,不是这个素材的问题。
  return 'unknown'
}

/** 并发受限地对一批去重后的地址发 HEAD。 */
async function probeRemote(
  urls: string[],
  deps: VerifyDeps,
): Promise<Map<string, RemoteState>> {
  const result = new Map<string, RemoteState>()
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < urls.length) {
      const url = urls[cursor++]
      try {
        const { status } = await deps.head(url)
        result.set(url, statusToRemote(status))
      } catch {
        result.set(url, 'unknown')
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(HEAD_CONCURRENCY, urls.length) }, () => worker()),
  )
  return result
}

/**
 * 体检一批素材。**返回数组与输入一一对应**,坏条目只影响自己。
 * 纯逻辑,`fs.stat` 之外的副作用(HEAD)由 `deps` 注入,方便测试。
 */
export async function verifyUploadedMaterials(
  items: UploadedMaterialProbe[],
  opts: VerifyOptions,
  deps: VerifyDeps,
): Promise<UploadedMaterialVerdict[]> {
  const list = Array.isArray(items) ? items.slice(0, MAX_ITEMS) : []
  const wellFormed = (p: unknown): p is UploadedMaterialProbe =>
    !!p &&
    typeof (p as UploadedMaterialProbe).src === 'string' &&
    typeof (p as UploadedMaterialProbe).uploadedUrl === 'string'

  const locals = await Promise.all(
    list.map((p) => (wellFormed(p) ? localState(p) : Promise.resolve<LocalState>('unverifiable'))),
  )

  // 只对「本地没判死」且地址合法的去探云端 —— 本地已经 changed / unverifiable 的
  // 反正要丢,不用浪费一次网络。
  let remotes = new Map<string, RemoteState>()
  if (opts.checkRemote) {
    const need = new Set<string>()
    list.forEach((p, i) => {
      if (!wellFormed(p)) return
      if (locals[i] === 'changed' || locals[i] === 'unverifiable') return
      if (isOwnCosUrl(p.uploadedUrl)) need.add(p.uploadedUrl)
    })
    remotes = await probeRemote([...need], deps)
  }

  return list.map((p, i): UploadedMaterialVerdict => {
    const local = locals[i]
    if (!wellFormed(p)) return { keep: false, local, remote: 'skipped' }
    // 不是自家 COS 的地址:不该出现在 uploadedUrl 里,丢掉最稳。
    if (!isOwnCosUrl(p.uploadedUrl)) return { keep: false, local, remote: 'dead' }
    const remote: RemoteState = opts.checkRemote ? (remotes.get(p.uploadedUrl) ?? 'skipped') : 'skipped'
    const keep = local !== 'changed' && local !== 'unverifiable' && remote !== 'dead'
    return { keep, local, remote }
  })
}

/** 生产用的 HEAD:走 Electron 网络栈(自动跟随系统代理),带超时。 */
async function headWithNet(url: string): Promise<{ status: number }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), HEAD_TIMEOUT_MS)
  try {
    const res = await net.fetch(url, { method: 'HEAD', signal: ctrl.signal })
    return { status: res.status }
  } finally {
    clearTimeout(timer)
  }
}

export function registerMaterialUploadVerifyIpc(): void {
  ipcMain.handle(
    'media:verify-uploaded-materials',
    async (
      _event,
      payload: { items?: UploadedMaterialProbe[]; checkRemote?: boolean } | undefined,
    ): Promise<UploadedMaterialVerdict[]> =>
      verifyUploadedMaterials(
        payload?.items ?? [],
        { checkRemote: payload?.checkRemote === true },
        { head: headWithNet },
      ),
  )
}
