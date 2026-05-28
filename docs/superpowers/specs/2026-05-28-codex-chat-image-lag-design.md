# Codex 聊天图片附件卡顿 — 设计文档

- **Date**: 2026-05-28
- **Status**: Approved (brainstorming + 三个上游 issue 群核对完成)
- **Branch**: `feature/codex-chat-image-lag`（off `origin/main`）
- **Estimated**: 3 PRs（PR-A ~150 行 / PR-B ~300 行 / PR-C ~80 行）
- **OpenSpec mirror**: `openspec/changes/fix-codex-chat-image-attachment-lag/`

## 问题

用户拖图进 Codex 聊天框 → 渲染器卡 300 ms ~ 2 s 不等。`onDrop` 已经是 path-only（PR-1 落地的 `openai/codex#21108` 模型），但 **缩略图渲染** 这条副路径把这个优势全吃了：

```
<img> ← blob: ← Uint8Array ← atob(base64) ← IPC structuredClone(string)
       ← base64(Buffer) ← fs.readFile(原文件,最多 100 MB) ← attachments:read-thumb
```

`MentionInput` 的 pending chip / `AttachmentCard` / `EvidenceStack` / `Lightbox` / `ReferencePreview` 共用这条慢路径，等于全员降级。Chromium 还会按原分辨率 decode（4000×3000 ≈ 48 MB RGBA），主线程再卡一次。

## 上游同类 agent 真实处置（核对过 issue）

| Agent | 现场（真实 issue 链接） | 真实修法 | 我们能抄什么 |
|---|---|---|---|
| OpenAI Codex Desktop | `#13508`（134 MB PNG 拖入 → 413 → thread 卡死、重启循环）、`#15270`（3.6 MB JPEG 也卡死 Windows，证明 **不是大小问题，是 I/O 阻塞模型**） | PR **`#21108`**：**保住 path-based attachment contract**；远端 Codex Cloud 用 SFTP-over-WebSocket 二进制帧串流到 `$CODEX_HOME/uploads/<session>/`；从不在客户端做 base64 大块塞 IPC | 路径契约（已有）；不在客户端做大块 IPC（待修） |
| VSCode + Copilot Chat | `#295334`（PNG 序列化成 `{"0":137,"1":80,...}` 逐字节 JSON，1.5 MB → 3.78 MB，渲染崩） | commit `5e112a5`：attachment 只存 `URI`，用到才 `fileService.readFile`+`resizeImage` | 渲染只持 URI；大图发送前 resize |
| VSCode + Copilot Chat | `#305184` / `#308609`（Anthropic API：`messages.x.content.y.image.source.base64.data: At least one of the image dimensions exceed max allowed size: 8000 pixels`） | 客户端先 resize 到 8000 px 上限 + ≤ 5 MB 再发 | 同样必须做，否则用户的 12 MP 手机照片一律静默 400 |
| OpenCode (sst) | `#4668` / `#18107` —— TUI 把 drop 的 path 当字符串塞进 prompt，模型看不见图 | path 不是 bug，是没 read bytes —— 修复方向：检测 path → 读盘转给 LLM | 反向佐证：path-only 是行业默认，争议永远是"什么时候/谁来 read bytes" |
| Cursor | `anthropics/claude-code#34529` 验证 PTY 粘贴卡死是 **Cursor 渲染层** 不是 Claude；论坛贴长聊天 / 含图聊天卡顿 | 没开源；自己的私有上传后端 + 历史塞 SQLite 单行 JSON（也被诟病） | 教训：任何同步逐字节循环 / 大字符串 IPC 都会让主线程死 |
| Electron 官方 | docs / electron#49073 | `protocol.handle('local-file', ...)` + `net.fetch` 直接喂 `<img>`；`nativeImage.createThumbnailFromPath` 走系统级缩图 | 都用 |

**主流没人用"全员上桶 → 只塞 URL"做主修法。** 他们都在**保 path 契约** + **分层（渲染 / 远端 / 发送前）** 上做文章。

## 用户原始设想"上桶传 URL"评估

| 维度 | 上桶帮没帮 |
|---|---|
| 渲染卡顿（**根因**） | **不直接解决**。要么先把 IPC base64 那段砍掉，否则 URL 还没拿到时还是卡 |
| 远端 CDN 缩图 | ✅ Tencent COS `?imageView2/2/w/N` 直接返回小图，渲染端只 fetch 几 KB |
| Vision API 上行 | ✅ 直接传 URL，省客户端 base64 5 MB 上行 |
| 离线 / 隐私 | ❌ 公网桶必走网络 |
| Codex Rust CLI | ❌ 它只读本地 path，不 fetch URL |
| 首次 drop 延迟 | ❌ 上传 1-3 s 内 URL 还不存在，本地缩略图必须先到位 |
| Secret 风险 | ⚠️ `cos-credentials.json` 现在是 **明文 SecretKey 进仓库**，扩大使用前必须先治理 |

**结论：上桶是个乘数，不是地基。地基必须先修渲染热路径。**

## 设计 —— 三个相互独立可发版的 PR

### PR-A. 渲染热路径修缩略图（地基，~150 行）

#### A.1 新 IPC `media:thumb`（主进程）

文件：`src/main/file-explorer/mediaThumbIpc.ts`

```ts
import { protocol, nativeImage } from 'electron'
import sharp from 'sharp'

export async function handleMediaThumb(p: string): Promise<MediaThumbResult> {
  // 1. 校验：traversal / mime whitelist / 100MB 上限（复用 attachmentsIpc.ts 的常量）
  const validated = await validatePath(p)
  if (!validated.ok) return validated

  // 2. 首选 Electron NativeImage —— 走系统原生 thumbnail provider（macOS QLThumbnail /
  //    Windows IThumbnailProvider / Linux gnome-thumbnailer），零 libvips 冷启动。
  const thumb = await nativeImage.createThumbnailFromPath(validated.realPath, {
    width: 512, height: 512,
  })
  if (!thumb.isEmpty() && thumb.getSize().width > 0) {
    return { ok: true, base64: thumb.toPNG().toString('base64'), mime: 'image/png' }
  }

  // 3. 兜底 sharp —— Linux 无 thumbnail backend / SVG / 动图首帧
  const buf = await sharp(validated.realPath, { animated: false })
    .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toBuffer()
  return { ok: true, base64: buf.toString('base64'), mime: 'image/png' }
}
```

效果对比（5 MB JPEG）：

| 路径 | IPC 载荷 | 渲染端 atob 主线程时长 | `<img>` decode 时长 |
|---|---|---|---|
| 老 `attachments:read-thumb` | ~7 MB base64 string | 80–200 ms | 100–300 ms（4000×3000） |
| 新 `media:thumb` | ~25 KB base64 string | < 1 ms | < 5 ms（512×512） |

#### A.2 渲染端 `useResolvedMediaSrc` 改默认调用

```ts
async function readBytes(osPath, { fullFidelity = false } = {}) {
  const attachments = getAttachmentsApi()
  if (!fullFidelity && attachments?.readMediaThumb) {
    const res = await attachments.readMediaThumb(osPath)
    if (res.ok) return res  // 99% 路径走这里 → 25KB base64
  }
  // Lightbox / 文件预览全图视图才走老路径
  if (attachments?.readThumb) return attachments.readThumb(osPath)
  return getFsApi()?.readBinary(osPath) ?? { ok: false, reason: 'no IPC' }
}
```

Lightbox 显式传 `fullFidelity: true` 拿原图。

#### A.3 顺手修 `local-file://` 直渲

- 验证 `toRenderableUri` 的 `%3A` 编码全链路无解码。已写 `D:\path with space\foo.png` 回归用例。
- `installLocalFileHandler` 已经在主进程注册并 `net.fetch(pathToFileURL(...))`。在三平台跑 Playwright 验通后，加 feature flag `CATIMATION_LOCAL_FILE_DIRECT=1`，渲染端直接 `<img src="local-file:///D%3A/...">` 跳过 IPC。两周 soak 后翻默认。

### PR-B. COS 异步上传通道（可选，~300 行）

#### B.1 Prisma 迁移

```prisma
model AgentAttachment {
  // ...existing
  remoteUrl    String?
  remoteKey    String?
  uploadStatus String  @default("pending")  // pending | uploading | done | failed | skipped
}
```

历史行 backfill 成 `skipped`，永不重传。

#### B.2 `CosCredentialProvider` 抽象

`src/main/services/tencent/CosCredentialProvider.ts`:

```ts
export interface CosCredentialProvider {
  getCredentials(scope?: { keyPrefix?: string }): Promise<TencentCreds>
}

// 默认：现状（safeStorage 解密 + 长效 SecretKey）
export class LongLivedCredentialProvider implements CosCredentialProvider { /* ... */ }

// 接口已就位，flag 控制是否启用 —— 不阻塞 PR-B 主路径
export class StsCredentialProvider implements CosCredentialProvider {
  // 调 qcloud-cos-sts.getCredential() 拿 1 小时 token
  // 策略限定 cos:PutObject on agent-attachments/<threadId>/*
}
```

`cosClient.ts` 把 `getCredentials()` 直接读改成 `provider.getCredentials({ keyPrefix })`。Provider 装配在主进程 init 时一次性完成，`CATIMATION_COS_USE_STS=1` 才切到 STS。

#### B.3 `AttachmentUploader`

`src/main/agent/AttachmentUploader.ts`:

```ts
class AttachmentUploader {
  start() {
    this.attachmentService.on('attachment-added', (e) => this.enqueue(e.saved))
  }

  enqueue(saved: SavedAttachment) {
    if (!this.shouldUpload(saved)) return
    this.queue.add(() => this.uploadOne(saved))
  }

  shouldUpload(s): boolean {
    if (process.env.CATIMATION_ATTACHMENT_REMOTE_UPLOAD === '0') return false
    if (!s.mime.startsWith('image/') && !s.mime.startsWith('video/')) return false
    if (s.size <= 256 * 1024) return false
    return true
  }

  async uploadOne(saved) {
    await this.prisma.agentAttachment.update({ where: { id: saved.id }, data: { uploadStatus: 'uploading' } })
    try {
      const key = `agent-attachments/${saved.threadId}/${path.basename(saved.localPath)}`
      const remoteUrl = saved.size < 5 * 1024 * 1024
        ? await uploadBufferViaPath({ key, filePath: saved.localPath, contentType: saved.mime })
        : await uploadStreamReturnUrl({ key, filePath: saved.localPath, contentType: saved.mime })
      await this.prisma.agentAttachment.update({ where: { id: saved.id }, data: { uploadStatus: 'done', remoteUrl, remoteKey: key } })
      this.emit('attachment-uploaded', { id: saved.id, remoteUrl })
    } catch (err) {
      await this.prisma.agentAttachment.update({ where: { id: saved.id }, data: { uploadStatus: 'failed' } })
      console.warn('[AttachmentUploader] failed', { id: saved.id, error: String(err) })
      // 静默失败 —— 不阻塞 turn，本地 path 仍然有效
    }
  }
}
```

并发上限 2，队列复用 `services/tencent/jobQueue.ts`（如形状不合就内联一个简单 semaphore）。

#### B.4 渲染端优先 `remoteUrl`

`AttachmentCard` / `EvidenceStack` / `Lightbox` 改成：

```tsx
const src = remoteUrl
  ? appendCosImageView(remoteUrl, 512)   // 缩略 ?imageView2/2/w/512
  : toRenderableUri(localPath)
return <MediaThumbnail src={src} kind={kind} />
```

`MentionInput` 的 pending chip 仍 **立即** 用本地 `media:thumb`（用户无感等待），URL 到位后 IPC `attachments:changed` 触发 re-render 才换到 CDN。

#### B.5 安全护栏

| 项 | 现状 | 修后 |
|---|---|---|
| `cos-credentials.json` 进仓库 | 是（明文 SecretKey） | 不在本提案 scope，但 `CosCredentialProvider` 抽象已让单点替换可行；建议立即开独立安全提案处理 |
| 渲染端能拿到 SecretKey | 否（preload 没暴露） | 否，**加 CI lint** `grep -r secretKey src/renderer` 必须 0 命中 |
| 桶可写权限 | 全桶 | 走 STS 后限定 `agent-attachments/<threadId>/*` 前缀 |
| 上传 URL 是否签名 | 公开读 | v1 公开读（与现有 `storyboardSplit` 一致）；v2 切短期签名 GET |

### PR-C. 发送前 client-side resize（~80 行）

`src/main/agent/resizeForVision.ts`:

```ts
const MAX_DIM = 8000
const MAX_BYTES = 5 * 1024 * 1024

export async function resizeForVision(srcPath: string, mime: string): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime)) return srcPath

  const stat = await fs.stat(srcPath)
  const meta = await sharp(srcPath).metadata()
  if (meta.pages && meta.pages > 1) return srcPath   // 动图直接放过
  if (stat.size <= MAX_BYTES && Math.max(meta.width ?? 0, meta.height ?? 0) <= MAX_DIM) return srcPath

  const dest = srcPath.replace(/(\.[^.]+)$/, '.resized$1')
  const destStat = await fs.stat(dest).catch(() => null)
  if (destStat && destStat.mtimeMs >= stat.mtimeMs) return dest   // cache hit

  const pipeline = sharp(srcPath).resize({
    width: MAX_DIM, height: MAX_DIM, fit: 'inside', withoutEnlargement: true,
  })
  if (mime === 'image/png') await pipeline.png({ compressionLevel: 9 }).toFile(dest)
  else await pipeline.jpeg({ quality: 90, mozjpeg: true }).toFile(dest)
  return dest
}
```

接入：`agent:send-message` 在拼 Codex JSON-RPC payload 前，对每个 image attachment `await resizeForVision(saved.localPath, saved.mime)`，把得到的路径写进 payload + 记进 message item（resend 共享同一份 resized 文件）。

`CATIMATION_ATTACHMENT_RESIZE=0` 关闭整段（rollback）。

## 验证矩阵

| 性质 | 测什么 | 在哪 |
|---|---|---|
| 5 MB JPEG 拖入到 thumbnail 可见 ≤ 200 ms p99 | Playwright + `performance.mark` | `e2e/codex-chat-image-drop.spec.ts`（新） |
| drop 后 2 秒内主线程 long-task = 0 | Playwright trace + 断言 | 同上 |
| 100 MB 文件被拒 | Vitest 单测 `attachmentsIpc.test.ts` | 沿用 |
| 2 MB JPEG 在 100 Mbps 下 10 s 内 `remoteUrl` 就位 | 集成测，`RUN_COS_E2E` 门控 | `src/main/agent/__tests__/AttachmentUploader.integration.test.ts` |
| Resize 后图片满足 provider 限制 | sharp metadata 断言 | `src/main/agent/__tests__/resizeForVision.test.ts` |
| 渲染端无 SecretKey | `grep -r secretKey src/renderer` 必须 0 | CI lint |
| 离线场景（flag 关）正常 | 网络禁用 VM 手测 | release checklist |

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| `nativeImage.createThumbnailFromPath` 在某用户机器返回空图 | sharp 兜底；`thumb.isEmpty()` 检测 |
| Tencent COS 限流（突发 20 文件 drop） | concurrency 上限 2；既有 20 文件总配额 |
| 99 MB 文件触发 sharp OOM | 主流程 100 MB 上限早于 sharp 调用就拒掉 |
| `local-file://` 在 Linux 某发行版回归 | feature flag 兜底，关掉走 `media:thumb` IPC |
| Anthropic 改变 size 上限 | 限制写成常量 + 注释引用 provider 文档 |
| Resize 损画质 | quality=90 对 vision API 无损；只在已超限时触发 |
| 网络弱时上传失败 | 静默 `failed`，不影响 turn |

## 不在本提案范围

- 粘贴 Ctrl+V 图片（独立 capability）
- 文件夹拖入
- 用 R2/S3 替代 Tencent COS
- 把 PGlite 搬到 utilityProcess（已在 `2026-05-11-attachment-streaming-design.md` Phase C 待办）
- 处理 `cos-credentials.json` 进仓库这个根本性安全问题（独立提案；本 PR 把 `CosCredentialProvider` 抽象铺好作为 enabler）

## 配套实施文档

- `docs/superpowers/plans/2026-05-28-codex-chat-image-lag-pr1-renderer-thumb.md`（PR-A 执行清单）
- `docs/superpowers/plans/2026-05-28-codex-chat-image-lag-pr2-cos-staged-upload.md`（PR-B 执行清单）
- `docs/superpowers/plans/2026-05-28-codex-chat-image-lag-pr3-pre-send-resize.md`（PR-C 执行清单）
- `openspec/changes/fix-codex-chat-image-attachment-lag/`（AI 工具消费侧；与上述等价）

## 参考

- `openai/codex` #13508 / #15270 / PR #21108
- `microsoft/vscode` #295334 / commit `5e112a5` / #305184 / #308609
- `anthropics/claude-code` #34529
- `electron/electron` #49073
- `docs/superpowers/specs/2026-05-11-attachment-streaming-design.md`
- `docs/superpowers/specs/2026-05-21-codex-drag-drop-design.md`
- Electron docs: `nativeImage.createThumbnailFromPath`, `protocol.handle`
- Tencent COS: presigned URL, STS GetFederationToken, image processing
