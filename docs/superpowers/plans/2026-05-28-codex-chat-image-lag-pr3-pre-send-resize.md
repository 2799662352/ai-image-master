# PR-3: 发送前 client-side resize（兼容 vision API 硬限制）

- **Date**: 2026-05-28
- **Branch**: `feature/codex-chat-image-lag-pr3`（基于 PR-1 已合并的 `main`，**不**依赖 PR-2）
- **设计**: `docs/superpowers/specs/2026-05-28-codex-chat-image-lag-design.md` § PR-C
- **OpenSpec tasks**: `openspec/changes/fix-codex-chat-image-attachment-lag/tasks.md` § PR-C
- **估行**: ~80 行（含测试）
- **目标合并时长**: ≤ 半天
- **前置**: PR-1 已合并；PR-2 可以并行或之后

## 背景

Anthropic vision API 对任何图都有硬限制：
- 任一边长 > 8000 px → 400
- 文件 > 5 MB → 400

参考：`microsoft/vscode#305184`、`microsoft/vscode#308609` 真实报错：

```
messages.13.content.20.image.source.base64.data:
At least one of the image dimensions exceed max allowed size: 8000 pixels
```

现代手机一张照片轻松超线（iPhone 4032×3024、Pixel 4080×3072、Samsung 4080×3072 + HDR 后 6-12 MB）。当前流程会把原图路径直接给 Codex，触发模型侧静默失败 —— 用户看到"模型没看到我的图"。

VSCode 在 commit `5e112a5` 里加了 `resizeImage`；我们抄它的做法但在 main process 用 sharp 做（renderer 不参与）。

## 任务清单

### 1. `resizeForVision` 主进程 helper

- [ ] **1.1** 新文件 `src/main/agent/resizeForVision.ts`：
  ```ts
  import sharp from 'sharp'
  import { promises as fs } from 'node:fs'
  import path from 'node:path'

  const MAX_DIM = 8000
  const MAX_BYTES = 5 * 1024 * 1024
  const RESIZE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

  export async function resizeForVision(srcPath: string, mime: string): Promise<string> {
    if (process.env.CATIMATION_ATTACHMENT_RESIZE === '0') return srcPath
    if (!RESIZE_MIMES.has(mime)) return srcPath

    const stat = await fs.stat(srcPath)
    let meta: sharp.Metadata
    try {
      meta = await sharp(srcPath).metadata()
    } catch {
      return srcPath  // sharp 看不懂就放过，Codex 自己处理
    }
    if ((meta.pages ?? 1) > 1) return srcPath  // 动图直接放过
    const longest = Math.max(meta.width ?? 0, meta.height ?? 0)
    if (stat.size <= MAX_BYTES && longest <= MAX_DIM) return srcPath  // 已合规

    const ext = path.extname(srcPath)
    const dest = srcPath.replace(new RegExp(`${ext.replace('.', '\\.')}$`), `.resized${ext}`)

    // Cache: same content + dest fresher than src → skip
    const destStat = await fs.stat(dest).catch(() => null)
    if (destStat && destStat.mtimeMs >= stat.mtimeMs) return dest

    const pipeline = sharp(srcPath, { animated: false }).resize({
      width: MAX_DIM,
      height: MAX_DIM,
      fit: 'inside',
      withoutEnlargement: true,
    })
    if (mime === 'image/png') {
      await pipeline.png({ compressionLevel: 9 }).toFile(dest)
    } else if (mime === 'image/webp') {
      await pipeline.webp({ quality: 90, effort: 4 }).toFile(dest)
    } else {
      await pipeline.jpeg({ quality: 90, mozjpeg: true }).toFile(dest)
    }
    return dest
  }
  ```
- [ ] **1.2** 单测 `src/main/agent/__tests__/resizeForVision.test.ts`：
  - 10000×8000 PNG → resized 8000×6400 输出大小 ≤ 5MB
  - 1024×1024 PNG → 路径不变
  - 4032×3024 / 4MB JPEG（超大小不超尺寸）→ resized
  - 4032×3024 / 800KB JPEG（不超）→ 路径不变（？—— 看 size 是不是真的不超）
  - 动图 GIF → 路径不变（assertion: 不写 dest）
  - SVG → 不被 RESIZE_MIMES 包含，路径不变
  - 不存在的 mime → 路径不变
  - Cache hit：第二次调用 mtime 不变 → assert `sharp` 没被调用
  - flag off：`CATIMATION_ATTACHMENT_RESIZE=0` → 不 resize 任何东西

### 2. 接入 agent 发送链路

- [ ] **2.1** 定位 `agent:send-message` IPC handler（应该在 `src/main/agent/AgentManager.ts` 或 `src/main/agent/codexUserInput.ts`）。用 `Grep 'agent:send-message'` 找。
- [ ] **2.2** 在 `AttachmentService.ingest()` 返回后、组装 Codex JSON-RPC payload 之前，对每个 `mime.startsWith('image/')` 的 saved attachment：
  ```ts
  const sendPath = await resizeForVision(saved.localPath, saved.mime)
  ```
- [ ] **2.3** 拼 input items 时用 `sendPath` 而不是 `saved.localPath`。**注意：DB 行的 `localPath` 不改**（原图保留，UI 还是显示原图缩略图）；只是给 Codex 的那一份是 resized。
- [ ] **2.4** 在 message item（保存进 `AgentMessage.items`）里记录 `effectivePath: sendPath`，这样 rewind / edit-and-resend 共享同一份 resized 文件。

### 3. 验收

- [ ] **3.1** 单测：见 1.2
- [ ] **3.2** 集成测（gated `if (!process.env.RUN_VISION_API_E2E) test.skip()`）：
  - fixture：1 张 12 MP iPhone JPEG
  - 走完整 send 链路（mock 掉真实 Codex 调用，只断言传给 codex 的 attachment path）
  - assert：传出的 path 是 `.resized.jpg` 后缀
  - 直接 `await sharp(path).metadata()` 验证 ≤ 8000×8000 + size ≤ 5MB
- [ ] **3.3** 真模型烟测（手测，单次）：
  - 拖 12 MP 手机照 → 发"描述这张图"给 Anthropic claude-3.7-sonnet → 模型成功描述
  - 同样的图，临时关掉 resize（flag off）→ 应该 400 报错
- [ ] **3.4** Regression：小图 1024×1024 走链路 → 传给 Codex 的 path 应该是原路径（identity check，用 mock 抓取）

### 4. 提交节奏

1. Commit 1：第 1 步（helper + 单测）
2. Commit 2：第 2 步（接入 send 链路）
3. Commit 3：第 3 步（集成测 + 手测记录截图）
4. 发 PR

## 风险点 ad-hoc

- **sharp 内存峰值**：sharp 处理 12 MP 输入 ≈ 36 MB RGB buffer。100 MB 上限的原图理论上能产生 ≈ 300 MB 中间态。AttachmentService 已经做了 sequential ingest；这里也是 sequential（一次 send 走完一个 attachment），没问题。
- **EXIF orientation**：sharp 默认会按 EXIF 旋转输出。`.rotate()` 不传参就是这个行为；我们要保留 orientation —— 不显式调，依赖默认 ✅
- **PNG → JPEG 转换**：透明 PNG 千万别转 JPEG（黑底）。我们保持 PNG-stays-PNG，质量稍降但语义对。
- **Cache 失效**：用 mtime 比较，如果用户原图被修改（不太可能但有可能），cache 失效重做。`<sha>.resized.<ext>` 在内容寻址路径上，所以 `<sha>` 改 = 新文件 = 新 resize。

## 完成判定

- [ ] CI 全绿
- [ ] 手测：iPhone 12MP 照片 + claude-3.7-sonnet "描述这张图" 成功
- [ ] Performance：单次 resize 12MP 图主进程 ≤ 500 ms（不阻塞 UI，因为是 main process + sharp 内部已经是 worker thread）
- [ ] OpenSpec tasks PR-C 全部 `[x]`
