# PR-1: 渲染热路径修缩略图（地基）

- **Date**: 2026-05-28
- **Branch**: `feature/codex-chat-image-lag-pr1`（off `origin/main`）
- **设计**: `docs/superpowers/specs/2026-05-28-codex-chat-image-lag-design.md` § PR-A
- **OpenSpec tasks**: `openspec/changes/fix-codex-chat-image-attachment-lag/tasks.md` § PR-A
- **估行**: ~150 行（含测试）
- **目标合并时长**: ≤ 1 天

## 任务清单（按依赖顺序）

### 1. 主进程 `media:thumb` IPC

- [ ] **1.1** 新文件 `src/main/file-explorer/mediaThumbIpc.ts`。先把 `attachmentsIpc.ts` 里的 `hasTraversalSegment`、`ALLOWED_MIME_BY_EXT`、`MAX_ATTACHMENT_BYTES` 抽到共享 module `src/main/file-explorer/mediaPathValidation.ts` 让两个 IPC 复用（≤ 30 行的纯校验函数，不引入新依赖）。
- [ ] **1.2** `handleMediaThumb(p)` 实现：
  - 校验路径（traversal / mime / 100MB 大小上限）
  - `nativeImage.createThumbnailFromPath(realPath, { width: 512, height: 512 })`
  - 成功且 `!thumb.isEmpty() && thumb.getSize().width > 0` → 返回 `{ ok: true, base64: thumb.toPNG().toString('base64'), mime: 'image/png' }`
  - 否则进 sharp fallback：`sharp(p, { animated: false }).resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer()`
  - sharp 异常 → `{ ok: false, reason: 'thumb failed: ${err}' }`
- [ ] **1.3** `registerMediaThumbIpc()` 注册 `ipcMain.handle('media:thumb', ...)`。在 `src/main/index.ts` 紧邻 `registerAttachmentsThumbIpc()` 调用。
- [ ] **1.4** preload 暴露：`src/preload/index.ts` 的 `electronAPI.attachments` 新增 `readMediaThumb: (p: string) => ipcRenderer.invoke('media:thumb', p)`。
- [ ] **1.5** 单测 `src/main/file-explorer/__tests__/mediaThumbIpc.test.ts`：
  - traversal 拒绝 (`/abs/../etc/passwd`)
  - 非白名单后缀拒绝
  - 100MB 上限拒绝
  - 正常 PNG → 返回 base64 长度 ≤ 100KB（用 1MB fixture）
  - SVG → 走 sharp 路径（mock `nativeImage` 返回 empty）
  - 不存在文件 → `{ ok: false, reason: 'file not found' }`

### 2. 渲染端 `useResolvedMediaSrc` 改默认调用

- [ ] **2.1** `src/renderer/src/components/shared/media/useResolvedMediaSrc.ts` 加 `MediaSrcOpts` 类型：
  ```ts
  export interface MediaSrcOpts {
    /**
     * Lightbox / full-screen 预览专用 —— 拿原图原分辨率 base64。
     * MediaThumbnail 默认 `false`，走轻量的 media:thumb IPC。
     */
    fullFidelity?: boolean
  }
  ```
- [ ] **2.2** `AttachmentsApi` 接口加 `readMediaThumb: (p: string) => Promise<ReadThumbResult>`（与 readThumb 同形）。
- [ ] **2.3** `readBytes(osPath, opts)` 修改优先级：
  1. `!opts.fullFidelity && attachments?.readMediaThumb` → 优先调；ok 直接返；`whitelist|size|mime` reason 才往下走 readThumb 兜底。
  2. `attachments?.readThumb` → 现有行为，留给 Lightbox。
  3. `getFsApi()?.readBinary` → 现状不变。
- [ ] **2.4** `useResolvedMediaSrc(src, hint, opts?: MediaSrcOpts)` 签名扩展；`useEffect` 依赖加 `opts?.fullFidelity`（用 stable ref / JSON.stringify 防止每次 render 都变）。
- [ ] **2.5** `Lightbox.tsx` 调用 `useResolvedMediaSrc(src, kind, { fullFidelity: true })`。
- [ ] **2.6** `MediaThumbnail.test.tsx` 调整：mock `readMediaThumb` 而不是 `readThumb`；新增"`MediaThumbnail` 不应该调用 `readThumb`"的断言。

### 3. `local-file://` 直渲优化（feature-flag 上线）

- [ ] **3.1** `src/renderer/src/features/file-explorer/uri.ts` 加用例：`toRenderableUri('D:\\path with space\\foo.png')` → `'local-file:///D%3A/path%20with%20space/foo.png'`（空格也要编码）。补回归测试 `uri.test.ts`。
- [ ] **3.2** `src/main/file-explorer/protocolHandler.ts` `resolveOsPathFromRequest`：补 `'local-file://d/D%3A/path%20with%20space/foo.png'` 这类 hostname=`d` 加 pathname 含编码空格的用例（已有部分逻辑，确认覆盖 Windows / POSIX）。
- [ ] **3.3** `e2e/codex-chat-image-drop.spec.ts`（新）：启动 packaged renderer → 写一张 PNG → 用 `evaluate` 注入 `<img src="local-file:///<encoded-tmp-path>">` → 等 `image.naturalWidth > 0`。
  - macOS / Windows / Linux 三跑 matrix
- [ ] **3.4** flag 接入：`useResolvedMediaSrc` 顶部读 `import.meta.env.VITE_LOCAL_FILE_DIRECT === '1' || globalThis.electronAPI?.flags?.localFileDirect === true`。开启时：
  ```ts
  function initialResolved(src: string): string | null {
    if (typeof src !== 'string' || src.length === 0) return null
    const transformed = toRenderableUri(src)
    if (LOCAL_FILE_DIRECT && transformed.startsWith('local-file://')) return transformed
    if (toOsPathIfLocal(src) === null) return src
    return null
  }
  ```
  Effect = 跳过整段 IPC，直接喂 `<img>`。
- [ ] **3.5** 把 flag 文档化在 README 调试章节（dev 环境默认开；packaged 默认关，由 release notes 控制翻 default 的时机）。

### 4. 验收

- [ ] **4.1** Vitest 性能门：`MentionInput.lag.test.tsx` 用 `vi.mock` 把 `readMediaThumb` mock 成立即返回 25 KB base64；渲染 3 个 chip + assert `performance.now()` < 100 ms。
- [ ] **4.2** 手测：开 DevTools Performance，drop 一张 5 MB JPEG。Long-tasks 面板在 2 秒内必须 0 个 > 50ms 的红条。
- [ ] **4.3** 反向 sanity：把 `readMediaThumb` 临时强制走老 `readThumb` 路径，确认能复现原 lag（说明我们测对了路径）。

### 5. 提交节奏

1. Commit 1：第 1 步全部（IPC）+ 单测 → 自测通过即可推
2. Commit 2：第 2 步全部（渲染端）+ 单测
3. Commit 3：第 3 步全部（local-file:// 直渲 + flag）+ e2e
4. Commit 4：第 4 步验收测试
5. 自评 review 用 `code-reviewer` subagent 跑一遍，按反馈调，再发 PR

## 风险点 ad-hoc

- `nativeImage.createThumbnailFromPath` 在 Linux 无 backend 会返回 empty —— 务必 `isEmpty()` 检测+走 sharp；不要 silently 返回 0×0 图给渲染端。
- `media:thumb` IPC 输入路径来源是 **用户已经授权的 attachment path**（onDrop / picker），不是渲染端任意输入；但仍然做完整校验，遵循 attachmentsIpc 既有的纵深防御。
- 不要把 `readBytes` 改成把 fullFidelity 标志当 cache key —— 同一个 src 在 Thumbnail 和 Lightbox 之间切换时希望各自命中各自的 blob URL；不共享。

## 完成判定

- [ ] CI 全绿（unit + e2e）
- [ ] DevTools Performance 录制（drop 5 个 5MB JPEG）附在 PR 描述里，long-tasks 截图说明 0 红条
- [ ] OpenSpec tasks PR-A 全部 `[x]`
