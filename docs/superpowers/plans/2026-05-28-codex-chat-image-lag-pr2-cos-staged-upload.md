# PR-2: COS 异步上传通道（可选）

- **Date**: 2026-05-28
- **Branch**: `feature/codex-chat-image-lag-pr2`（基于 PR-1 已合并的 `main`）
- **设计**: `docs/superpowers/specs/2026-05-28-codex-chat-image-lag-design.md` § PR-B
- **OpenSpec tasks**: `openspec/changes/fix-codex-chat-image-attachment-lag/tasks.md` § PR-B
- **估行**: ~300 行（含测试 + 迁移）
- **目标合并时长**: ≤ 2 天
- **前置**: PR-1 已合并

## 前置安全决策（要先和团队对齐）

| 决策点 | 建议 | 不达成共识就不发 PR |
|---|---|---|
| `cos-credentials.json` 进仓库现状是否影响 PR-2 推进 | 否；本 PR 不修这个问题，但通过 `CosCredentialProvider` 抽象铺路。**同时立即开独立 issue 跟踪 SecretKey 治理。** | ✅ |
| 桶 `map-tiles-bucket-1345773498` 是否能存用户附件 | 复用现有桶；新增前缀 `agent-attachments/<threadId>/` | 是 |
| 公开读还是签名 GET | v1 公开读（与 `storyboardSplit` 一致）；v2 评估 1h 签名 GET | 是 |
| STS 启用 | 接口铺好，`CATIMATION_COS_USE_STS=1` 才生效；本 PR 默认仍是 long-lived | 是 |

## 任务清单

### 1. Prisma 迁移

- [ ] **1.1** `npx prisma migrate dev --name agent_attachment_remote_url` 生成迁移：
  ```sql
  ALTER TABLE "AgentAttachment" ADD COLUMN "remoteUrl" TEXT;
  ALTER TABLE "AgentAttachment" ADD COLUMN "remoteKey" TEXT;
  ALTER TABLE "AgentAttachment" ADD COLUMN "uploadStatus" TEXT NOT NULL DEFAULT 'pending';
  ```
- [ ] **1.2** 编辑 `prisma/init.sql`（PGlite seed 用，必须同步）。
- [ ] **1.3** 在迁移末尾 backfill：`UPDATE "AgentAttachment" SET "uploadStatus" = 'skipped';`（已存在的历史行不会被 uploader 重传）。
- [ ] **1.4** 在 `src/main/agent/ensureSchema.ts` 里 verify-after-migrate 的查询列表加这三列检查。

### 2. `CosCredentialProvider` 抽象

- [ ] **2.1** 新文件 `src/main/services/tencent/CosCredentialProvider.ts`：
  ```ts
  export interface TencentCreds {
    secretId: string
    secretKey: string
    securityToken?: string
    expiresAt?: Date
    bucket: string
    region: string
  }
  export interface CosCredentialProviderScope {
    keyPrefix?: string
  }
  export interface CosCredentialProvider {
    getCredentials(scope?: CosCredentialProviderScope): Promise<TencentCreds>
  }
  ```
- [ ] **2.2** `LongLivedCredentialProvider`：直接 wrap 现有 `getCredentials()`，返回 `{ ...creds, securityToken: undefined }`。
- [ ] **2.3** `StsCredentialProvider`（接入但不默认开启）：
  - `npm i qcloud-cos-sts`
  - 调 `STS.getCredential({ secretId, secretKey, durationSeconds: 3600, policy })` 拿 token
  - `policy` 限定 `cos:PutObject` on `qcs::cos:<region>:uid/<uin>:<bucket>/<keyPrefix>*`
  - 缓存 token 到 `expiresAt - 60s`；过期就重新申请
- [ ] **2.4** `cosClient.ts` 改造：把现有 `getCredentials()` 直读改成 `provider.getCredentials({ keyPrefix })`；当 `securityToken` 存在时 SDK 调用加 `XCosSecurityToken: token`（cos-nodejs-sdk-v5 SDK 透传到请求 header）。
- [ ] **2.5** `src/main/index.ts` 装配：
  ```ts
  const credProvider: CosCredentialProvider =
    process.env.CATIMATION_COS_USE_STS === '1'
      ? new StsCredentialProvider(...)
      : new LongLivedCredentialProvider()
  setCosCredentialProvider(credProvider)
  ```
- [ ] **2.6** 单测 `CosCredentialProvider.test.ts`：long-lived 直通 / STS mock 后返回 token / STS token expire 自动续。

### 3. `AttachmentUploader`

- [ ] **3.1** 新文件 `src/main/agent/AttachmentUploader.ts`。
  - 构造接收 `prisma`、`attachmentService`、可选 `concurrency = 2`。
  - 内部 semaphore（不依赖 `services/tencent/jobQueue.ts` 除非形状完美匹配——否则就内联）。
- [ ] **3.2** `start()` 订阅 `attachmentService.on('attachment-added', cb)`；`stop()` 取消订阅、`drain` 队列。
- [ ] **3.3** `shouldUpload(saved)`：见设计文档。
- [ ] **3.4** `uploadOne(saved)`：
  - 先 `update uploadStatus='uploading'`
  - key = `agent-attachments/${saved.threadId}/${path.basename(saved.localPath)}`
  - `size < 5MB` → `uploadBufferToBucket(...)` 但读 buffer 是 main process 内的 `fs.readFile`，先 `await fs.promises.readFile(saved.localPath)` 再调
  - `>= 5MB` → `uploadStream({ key, filePath: saved.localPath, contentType: saved.mime })` —— 直接 stream 上传，零内存峰值
  - 拼最终 URL `https://${bucket}.cos.${region}.myqcloud.com/${key}`
  - `update uploadStatus='done', remoteUrl, remoteKey`
  - `this.emit('attachment-uploaded', { id: saved.id, remoteUrl, remoteKey })`
- [ ] **3.5** 错误处理：catch 后 `update uploadStatus='failed'` + `console.warn`，**不 rethrow**。
- [ ] **3.6** 在 `AgentManager` init 时 `new AttachmentUploader(prisma, attachmentService).start()`；`app.on('before-quit')` 调 `stop()`。

### 4. 渲染端优先 `remoteUrl`

- [ ] **4.1** `src/types/agent.ts` `AttachmentRef` 加 `remoteUrl?: string`。
- [ ] **4.2** Store / DB hydration：`bootstrapThread` 等读 AgentAttachment 的地方把 `remoteUrl` 带回。
- [ ] **4.3** 新 helper `src/renderer/src/lib/cosImageView.ts`：
  ```ts
  export function appendCosImageView(url: string, width: number): string {
    if (!/\.cos\.[a-z0-9-]+\.myqcloud\.com\//.test(url)) return url
    // 已有 query 就用 & 拼，否则用 ?
    return `${url}${url.includes('?') ? '&' : '?'}imageView2/2/w/${width}`
  }
  ```
- [ ] **4.4** `MediaThumbnail` 调用点：`AttachmentCard.tsx`、`EvidenceStack.tsx`、`Lightbox.tsx`、`MentionInput.tsx` —— 改成 `src = remoteUrl ? appendCosImageView(remoteUrl, 128/512/1024) : toRenderableUri(localPath)`。Lightbox 用大尺寸 query（或原图）。
- [ ] **4.5** `useResolvedMediaSrc`：当 `src.startsWith('https://')` 时（COS URL）直接透传给 `<img>`，跳过整个 IPC 链 —— 实际上现有 `toOsPathIfLocal` 已经返回 `null` 对 https，所以应该已经 work，加用例确认。
- [ ] **4.6** IPC `attachments:changed`：在 AttachmentUploader 完成时 emit；渲染端 store 订阅，触发 thread 重新读 AttachmentRef。

### 5. 验收

- [ ] **5.1** 单测 `AttachmentUploader.test.ts`：
  - 触发上传：mock `uploadBufferToBucket` 返回 URL → assert prisma update + emit
  - 跳过小文件：100KB 文件不触发上传
  - 跳过非媒体：text/plain 不触发
  - 失败保活：mock 抛错 → status='failed'，不抛出
  - flag 关：`CATIMATION_ATTACHMENT_REMOTE_UPLOAD=0` 全部跳过
- [ ] **5.2** 集成测 `AttachmentUploader.integration.test.ts`（gated `if (!process.env.RUN_COS_E2E) test.skip()`）：
  - 真传 2MB JPEG → 轮询 `prisma.findUnique` 等 `uploadStatus='done'` ≤ 10s
  - `fetch(remoteUrl + '?imageView2/2/w/256')` → 200 + content-type image/jpeg
- [ ] **5.3** 渲染端网络断言：drop 一张 1MB 图 → 等 `remoteUrl` 到位 → 触发 re-render → Playwright `page.waitForRequest(/cos\.ap-guangzhou\.myqcloud\.com.*imageView2/)` 应该命中
- [ ] **5.4** 离线 rollback：网络 down + `CATIMATION_ATTACHMENT_REMOTE_UPLOAD=0`，确认 PR-1 的 `media:thumb` 路径仍然正常出图
- [ ] **5.5** CI lint：新增 ESLint rule 或一个 `scripts/check-no-secret-in-renderer.js`，`grep -r "secretKey\|SecretKey\|secret_key" src/renderer src/preload` 必须 0 命中

### 6. 提交节奏

1. Commit 1：第 1 步（Prisma migration）+ ensureSchema 校验
2. Commit 2：第 2 步（CosCredentialProvider）+ 单测
3. Commit 3：第 3 步（AttachmentUploader）+ 单测
4. Commit 4：第 4 步（渲染端 prefer remoteUrl）
5. Commit 5：第 5 步（验收 + lint）
6. 自评 review，发 PR

## 风险点 ad-hoc

- **历史行**：backfill 成 `skipped` 后，老 thread 重新打开**不会**触发上传。但用户可能困惑"为什么我老的图没有 URL"——release notes 写清楚"本次起新附件走 CDN，老附件保持本地"。
- **重复触发**：单个 ingest 错误重试 → 多次 emit attachment-added → 多次入队。在 `enqueue` 里加 `if (saved.uploadStatus !== 'pending') return` 幂等。
- **桶配额**：COS 默认无文件数硬上限，但成本曲线注意。月报里盯一下 `agent-attachments/` 前缀的 size。
- **STS 启用阻塞**：本 PR **不开** STS；先合 + soak，独立 PR 翻 `CATIMATION_COS_USE_STS=1`。

## 完成判定

- [ ] CI 全绿（含集成测）
- [ ] 在 100 Mbps 网络下 drop 5 张 2MB 图 → DevTools 看 `attachment-uploaded` 5 次 → COS 控制台能看到 5 个 object
- [ ] 渲染端切换 `remoteUrl` 后 `MediaThumbnail` 的 IPC 调用归零（Network panel 只有 https）
- [ ] OpenSpec tasks PR-B 全部 `[x]`
