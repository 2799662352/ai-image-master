# Codex 页拖入文件 设计文档

**Date**: 2026-05-21
**Status**: Approved (brainstorming complete)
**Branch**: `feature/codex-drag-drop` (off `origin/main` at `9693a12`)
**Estimated**: 2 PRs (~30 行 + ~200 行)

## 目的

让用户从操作系统(Windows 资源管理器 / macOS Finder / 桌面)直接把文件拖到 Codex 页两个目标:

1. **聊天输入框**(`MentionInput`) → 作为 path-only 引用,codex 直接读路径(不复制、不进内存)
2. **工作区文件管理器**(`FileExplorerPanel`) → 复制到 workspace 目录(传统文件管理器直觉)

## 当前状态(已存在 vs 缺失)

| 组件 | 已有 | 缺失 |
|---|---|---|
| `MentionInput.onDrop` | `parseQuoteDrop` ✅; `parseFileDrop`(内部 MIME `application/x-catimation-file-paths`)✅; 配额/skip 提示 ✅; `addPendingReference` 通道 ✅ | **外部 OS 拖入未处理 `dt.files`**(静默失败) |
| `electronAPI.getFilePath` | 走 Electron 32+ `webUtils.getPathForFile`,文件选择器(`<input type=file>`)已用 ✅ | 拖入路径未调用 |
| `FileExplorerPanel` | 是拖出源(`serializeFileDrag` ✅) | **没 drop handler**(不接受任何 drop) |
| IPC `fs.copyIntoWorkspace` | — | **新建** |

## 设计

### Task A — `MentionInput` 接收外部 OS 拖入(path-only)

**文件**: `src/renderer/src/features/agent-chat/MentionInput.tsx` 的 `onDrop`(line 762)

**改动**: 在已有的 `parseQuoteDrop` → `parseFileDrop` 链路后增加 Tier 3 fallback:

```ts
// Tier 3 (NEW): external OS drop via webUtils.getPathForFile
if (paths.length === 0 && event.dataTransfer.files.length > 0) {
  const getFilePath = (window as Window & {
    electronAPI?: { getFilePath?: (f: File) => string }
  }).electronAPI?.getFilePath
  if (getFilePath) {
    paths = Array.from(event.dataTransfer.files)
      .map((f) => getFilePath(f))
      .filter((p): p is string => Boolean(p))
  }
}
```

后续 `for (const filePath of paths)` 配额/stat/`addAttachment`/`addPendingReference` 流程**完全复用**(line 776-811)。

**语义**: path-only。codex 主进程读文件,渲染进程不持有 buffer。

**边界**:
- 单文件 ≤ 100 MB(沿用 `MAX_ATTACHMENT_BYTES`)
- 总附件 ≤ 250 MB / ≤ 10 个(沿用现有上限)
- 超出 → 收集到 `skippedReasons` → toast 提示(已有逻辑)

### Task B — `FileExplorerPanel` 接收外部 OS 拖入(import-copy)

**新增 IPC**: `fs:import-external(sources: string[], destDir: string)` —— 与 `fs:copy` 区别:**不 sandbox 校验 `sources`**(外部 OS 文件按定义就在沙盒外;drag-drop 本身就是用户授权)

返回:
```ts
type ImportResult =
  | { ok: true; written: string[] }
  | { ok: false; reason: 'is_dir' | 'oversize' | 'unreadable' | string; written?: string[] }
```

**主进程职责**(`src/main/file-explorer/fsIpc.ts` 新加 `handleImportExternal`):
1. **只**校验 `destDir` 在 `allowedRoots` 内(`assertContained(destDir)`)
2. 对每个 `src` `fs.stat`:不存在 → `unreadable`;是目录 → `is_dir`;大小 > 200 MB → `oversize`
3. 同名冲突 → 沿用 `uniquePath` 算法(VSCode 风格 `name copy.ext` / `name copy 2.ext` —— 与 `handleCopy`/`handleCreateFile` 完全一致,**不引入新算法**)
4. `fs.cp(src, target, { recursive: false, errorOnExist: false })` 复制(Node 22+ API,与 `handleCopy` 一致)
5. fail-fast:首个失败停止 + 返回 `written` 列出之前已成功的(让 UI 局部刷新)

**渲染进程**(`FileExplorerPanel.tsx` / `FileTreeNode.tsx`):
1. `onDragOver={(e) => { e.preventDefault(); setDropTarget(nodeId) }}` → 高亮(`bg-cyan-400/10` 边框)
2. `onDragLeave` → 清高亮
3. `onDrop`:
   - 解析 `dt.files` + `getFilePath` 拿源路径数组
   - 解析目标节点:文件夹节点 = 该文件夹;文件节点 = 父文件夹;空白 = workspace 根
   - **拒绝文件夹**:`entry.isDirectory` 不能 OS 端判,需要先 `fs.stat` 在主进程 —— 走 IPC 时 main 端检测 `stat.isDirectory()` 返回 `reason:'is_dir'`,UI toast "暂不支持文件夹拖入"
   - 对每个文件 **sequential** `for (const src of sources)`(与现存 `handleCopy` / `handleMove` 风格一致;v0 拒绝并发以避免磁盘抖动 + 简化 fail-fast 语义。drop 通常 ≤5 个文件,顺序 = 可预测 + 0 EBUSY 风险)
   - 进度反馈:一句 toast `已导入 N 个`(完成后);**byte-level 进度推迟到 v0.2**(`fs.cp` 不暴露 progress hook,需要重写为 `pipeline(createReadStream, createWriteStream)` 才能拿到字节流,这是独立的 PR)
   - 完成后:`useFileExplorerStore.refreshTree(destDir)` + `selectFile(newRelPath)` + 1s 高亮

### 决策快照(brainstorm 冻结)

| | 决策 |
|---|---|
| 拖入语义(MentionInput) | path-only 引用(不复制) |
| 拖入语义(FileExplorerPanel) | import-copy(复制到 workspace) |
| 同名冲突 | 静默自动 rename(沿用 `uniquePath`,VSCode 风格 ` copy` / ` copy 2`)|
| 文件夹拖入 | v0 拒绝 + toast,YAGNI |
| 多文件 | 支持,**sequential** copy(与 `handleCopy`/`handleMove` 一致) |
| 大小上限 | A: 100MB 单 / 250MB 总;B: 200MB 单 / 无总量上限 |
| 进度反馈 | v0:完成后一句 toast `已导入 N 个`;**byte 进度推迟 v0.2** |
| 复制后动作 | 自动 refresh + 选中 + 1s 高亮 |
| PR 拆分 | PR-1(Task A,30 行)/ PR-2(Task B,200+ 行) |

### Out of scope(明确推迟)

- 文件夹拖入(递归 copy + 冲突合并语义复杂)
- 浏览器 URL / 图片拖入(只识别本地 `dt.files`,不解析 `text/uri-list`)
- 粘贴图片 Ctrl+V → 附件(单独需求)
- 拖到 AgentChatPanel 任意位置(沉浸式)(超出 v0 范围)
- 拖到右侧 ThreadSidebar(无明确用例)
- 跨设备 / 云盘路径(`webUtils.getPathForFile` 已经能给本地路径)
- **Byte 级进度上报** —— 需要从 `fs.cp` 切到手写 `pipeline(createReadStream, createWriteStream)` + 进度 IPC channel + 渲染端进度 toast 组件,独立 PR

## 测试

**Task A**(PR-1)
- `MentionInput.tsx` 单测新增:外部 `dt.files` 拖入 → `getFilePath` 解析 → `addAttachment` + `addPendingReference` 调用断言
- 仿照已有 `MentionInput.*.test.tsx` 风格,mock `electronAPI.getFilePath`

**Task B**(PR-2)
- IPC 契约单测:`fs.copyIntoWorkspace` 沙盒越界、目录拒绝、冲突 rename、流式复制完整性、>200MB 拒绝
- `FileExplorerPanel` 渲染层单测:dragover 高亮、drop 触发 IPC、错误 toast
- `dragHelpers` 不需改(已有 schema 沿用)

## PR 推进顺序

1. **PR-1**:Task A —— 改 `MentionInput.onDrop` + 单测(目标 <1h 合并)
2. **PR-2**:Task B —— IPC 契约 + `FileExplorerPanel` drop UI + 单测(目标 <1 天合并)

PR-1 独立可发,不依赖 PR-2。

## 后续(post-merge)

- 文件夹拖入(v0.2)
- 拖到 ThreadSidebar 创建新 thread(idea)
- 浏览器 URL 拖入解析 `text/uri-list`(idea)
