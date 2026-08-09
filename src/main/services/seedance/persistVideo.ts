/**
 * 把上游那条临时地址的字节抓下来变成永久副本:下载 → 归档 → 转存 COS。
 *
 * 核心不变量:**下载一旦成功,那份字节就是唯一一份不会过期的副本**(上游地址约
 * 一天后失效),后面每一步都只能在它之上做增量,任何一步失败都不许把它带走。
 * 这条规则是照着图片链路来的 —— 图片是「先落盘、再从盘上传」,所以 COS 挂掉时
 * 图片从来不会真丢;视频多了一次昂贵的下载,更要守住已经到手的字节。
 *
 * 依赖全部注入,一是能被主进程和手动重试(`video-workbench:repersist`)共用,
 * 二是让「ingest 失败时留不留文件」这个决策可以被测试钉住。
 */

export interface PersistVideoTask {
  videoUrl?: string
  model: string
  taskId: string
  threadId?: string
}

export interface PersistVideoResult {
  localPath: string
  remoteUrl?: string
  /** 文件是否已归档进 attachments 目录。false = 仍是 downloads 里的原始下载。 */
  archived: boolean
}

export interface PersistVideoDeps {
  downloadVideo: (videoUrl: string, destPath: string) => Promise<string>
  ingest: (
    threadId: string,
    files: { name: string; mime: string; size: number; path: string }[],
  ) => Promise<{ localPath: string }[]>
  relayFileToCos: (
    filePath: string,
    mime: string,
    opts: { fileSize: number },
  ) => Promise<string>
  stat: (p: string) => Promise<{ size: number }>
  mkdir: (p: string) => Promise<unknown>
  unlink: (p: string) => Promise<unknown>
  downloadsDir: string
  fallbackThreadId: string
  uuid: () => string
  join: (...parts: string[]) => string
}

export async function persistVideoBytes(
  task: PersistVideoTask,
  deps: PersistVideoDeps,
): Promise<PersistVideoResult> {
  if (!task.videoUrl) throw new Error('seedance persist: task has no videoUrl')

  const name = `seedance-${task.model.replace('.', '_')}-${task.taskId.slice(-8)}.mp4`
  await deps.mkdir(deps.downloadsDir)
  const destPath = deps.join(deps.downloadsDir, `${deps.uuid()}-${name}`)

  const filePath = await deps.downloadVideo(task.videoUrl, destPath)
  const { size } = await deps.stat(filePath)

  // 按 path 而非 buffer 交给 ingest。这不只是省内存 —— buffer 路径的上限是
  // 100MB(MAX_BUFFER_ATTACHMENT_BYTES),path 路径是 2GB。走 buffer 时任何
  // 超过 100MB 的视频都会 ingest 失败。
  let localPath = filePath
  let archived = false
  try {
    const [saved] = await deps.ingest(task.threadId ?? deps.fallbackThreadId, [
      { name, mime: 'video/mp4', size, path: filePath },
    ])
    if (saved) {
      localPath = saved.localPath
      archived = true
    } else {
      console.warn('[seedance] attachment ingest produced no file; keeping raw download')
    }
  } catch (e) {
    // 曾经这里是 throw,而外层 finally 会无条件删掉 filePath —— 于是一次 sidecar
    // DB 抖动就能把几分钟才下完的 mp4 一起带走,卡片只剩明天过期的上游地址,
    // 唯一补救是花钱重生成。ingest 只决定文件**归档到哪**,决定不了文件还在不在。
    console.warn('[seedance] attachment ingest failed; keeping raw download:', e)
  }

  // 转存到历史桶（COS）拿永久 https URL —— 聊天气泡 / 历史记录用它做持久来源,
  // 重启后不会因上游代理地址过期或本地文件清理而丢失。上传失败不致命:本地 mp4
  // 仍在,降级用 file:// 路径。
  let remoteUrl: string | undefined
  try {
    remoteUrl = await deps.relayFileToCos(localPath, 'video/mp4', { fileSize: size })
  } catch (e) {
    console.warn('[seedance] video COS upload failed, falling back to local path:', e)
  }

  // 只有确认 attachments 目录里已有一份,这份临时副本才可以删。
  // `cleanupOrphanParts` 只扫 `.part`,留下的完整 mp4 不会被后续清理误伤。
  if (archived) await deps.unlink(filePath).catch(() => undefined)
  return { localPath, remoteUrl, archived }
}
