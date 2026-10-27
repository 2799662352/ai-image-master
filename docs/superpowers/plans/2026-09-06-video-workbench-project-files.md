# 视频工作台工程文件导入/导出 + `data:` 残留回填 实现计划(计划 2+3 / 3)

> **For agentic workers:** 按 superpowers 的 executing-plans 逐任务做,每个任务先红后绿再提交。
> 设计依据:`docs/superpowers/specs/2026-09-04-video-workbench-projects-design.md` §6、§7、§9、§10。

**目标:** 剧栏底部与总览右上的「导入工程 / 导出当前剧」从「即将推出」变成可用:一部剧导出为 URL-first 的 `*.catwb.json`,可在任何机器导入成一部新剧;两侧各有一个确认页。顺带把残留在库里的 `data:` 图片素材在水合后重新走一遍既有的 COS 转存。

**架构:**
- 文件格式与校验是**纯函数**(渲染端 `features/video-workbench/projectFile.ts`),与 store / IPC 解耦,单测直接喂对象。
- 主进程只做**文件 IO**:默认路径、保存/打开对话框、原子写、带体积闸的读。解析在渲染端用同一份纯函数(设计稿 §6.4 写的是主进程解析;改到渲染端是为了不写两份校验,主进程仍守 50 MB 闸)。
- 上传复用 `attachments.resolveRefMedia(path)`(本地路径 → 主进程流式传 COS),成片只有 `localPath` 的同样走它;人像库 `asset://` 取 `previewUrl`。
- 导入走 store 新动作 `importProject`,形状照 `duplicateProject`:全新 id、排队/生成中重置为草稿、已完成/失败保留状态与 `remoteUrl`。
- 两个确认页复用 `ProjectSearchPalette` 的 backdrop/panel 样式。

**与设计稿的偏离(实施时记录):**
1. 解析放渲染端(见上)。
2. 导出成功的「已导出 · 在文件夹中显示」做成确认页的成功态(按钮),而不是可点击 toast —— 现有 `ToastItem` 没有 action,加一个字段影响全站 toast 组件,不值。
3. §7 `data:` 落盘收窄:仓库里已有 `materialTransfer.ts`,粘贴的 `data:image/*` 联网时几秒内就换成 COS 地址;本期只补「水合后对残留 `data:image/*` 重新发起转存」,不新建 `workbench-assets` 目录与 GC。内联视频/音频仍留原样(转存字节通道只认 image/*)。若用户仍要文件方案,另开计划。

**测试口径:** `pnpm exec vitest run <path>`;渲染端测试无 jest-dom(用 `toBeTruthy()` / `toBeNull()`);`__tests__/` 里 types 的相对路径是 `'../../../../../types/videoWorkbench'`。

---

## Task 1:工程文件格式 + 纯函数(`projectFile.ts`)

**Files:**
- Create: `src/renderer/src/features/video-workbench/projectFile.ts`
- Test: `src/renderer/src/features/video-workbench/__tests__/projectFile.test.ts`

**内容:**
- 常量 `PROJECT_FILE_FORMAT = 'catimation-workbench-project'`、`PROJECT_FILE_VERSION = 1`、`PROJECT_FILE_MAX_BYTES = 50 * 1024 * 1024`、`PROJECT_FILE_EXT = '.catwb.json'`。
- 类型 `WorkbenchProjectFile { format, formatVersion, app: {name, version}, exportedAt, project: {name, createdAt, updatedAt, summary?}, boards: ProjectFileBoard[] }`;`ProjectFileBoard { name, summary?, cards }`;`ProjectFileCard` = `VideoWorkbenchSpec` 的规格字段(素材为 `{name, src}`,src 必为 https)+ `summary?` + `result?: { status: 'draft'|'succeeded'|'failed', remoteUrl?, error?, versions?: [{seq, remoteUrl?, prompt}] }`。
- `isHttpsUrl(src)`。
- `collectExportTargets(boards, cards)` → `{ segments, cards, materials, pending: Array<{ kind: 'material'|'result', cardId, field?, index?, src }> }`:待上传 = 素材 src 非 https 且不是带 previewUrl 的 `asset://`;成片 = 无 `remoteUrl` 但有 `localPath`。
- `buildProjectFile({ project, boards, cards, app, now, resolve })`:`resolve(src) → https | null`;任何素材解析不到 → 返回 `{ ok: false, reason }`(不写半个文件);排队/生成中 → `result.status = 'draft'`;`asset://` 用 previewUrl。
- `parseProjectFile(text)`:体积闸;`JSON.parse` reviver 拒 `__proto__` / `constructor` / `prototype` 键;`format` 不符 → `code: 'format'`;`formatVersion > PROJECT_FILE_VERSION` → `code: 'version'`(提示更新客户端);必填字段校验(project.name、boards 数组、每卡 prompt 字符串、素材 name/src 字符串)→ `code: 'invalid'`;未知字段放行。返回 `{ ok: true, file, summary: { segments, cards, materials, exportedAt, appVersion } }`。
- `uniqueProjectName(name, existing)`:`name` → `name (2)` → `name (3)`。
- `planImport(file)` → `{ boards: Array<{ name, summary?, cards: Array<{ input: VideoWorkbenchCardInput, summary?, result? }> }> }`。

**测试(先红):** 往返(build → JSON → parse 字段一致);待上传统计;解析不到素材时 build 拒绝;`__proto__` 键拒绝;高版本拒绝并给 code;format 不符拒绝;未知字段放行;超 50 MB 拒绝;同名加 (2)/(3);planImport 把 preparing/queued/running 变 draft、succeeded 保留 remoteUrl。

**Commit:** `feat(workbench): project file format, hardened parser and export/import planning (pure)`

---

## Task 2:主进程文件 IO + IPC + preload

**Files:**
- Create: `src/main/services/videoWorkbench/projectFileIpc.ts`
- Test: `src/main/services/videoWorkbench/__tests__/projectFileIpc.test.ts`
- Modify: `src/main/index.ts`(在 `registerFsIpc()` 旁 `registerProjectFileIpc(() => mainWindow)`)
- Modify: `src/preload/index.ts`(`videoWorkbench.projectFile.*` 类型 + 实现)

**纯函数:**
- `safeProjectFileName(name)`:去掉 `\ / : * ? " < > |` 与控制字符,空则 `工程`,截 80 字符,加 `.catwb.json`。
- `defaultProjectFilePath(documentsDir, name)` → `<documents>/CATIMATION 工程/<safe>`。
- `writeProjectFileAtomic(fullPath, json, deps?)`:`mkdir -p` → 写同目录 `.<name>.tmp-<random>` → `rename`;rename 失败删临时文件、目标不存在。
- `readProjectFileText(fullPath, maxBytes)`:`stat` 先看 size,超闸 `{ ok: false, code: 'too-large' }`;只接受 `.catwb.json` 后缀。

**IPC(全部 `ipcMain.handle`,先 `removeHandler`):**
- `video-workbench:project-default-path` `{ name }` → `{ path }`
- `video-workbench:project-pick-save-path` `{ defaultPath }` → `{ path: string | null }`(`dialog.showSaveDialog`,filters `[{ name: 'CATIMATION 工程', extensions: ['catwb.json'] }]`)
- `video-workbench:project-write` `{ path, json }` → `{ ok, path } | { ok: false, reason }`(json 体积闸 50 MB;路径必须以 `.catwb.json` 结尾)
- `video-workbench:project-pick-open` → `{ path: string | null }`(`showOpenDialog`,同 filter)
- `video-workbench:project-read` `{ path }` → `{ ok, text, path } | { ok: false, reason, code }`

**测试:** 文件名净化;默认路径;原子写成功 / rename 失败无半文件;读超闸拒绝;后缀拒绝。

**Commit:** `feat(workbench): main-process project file IO (atomic write, size-gated read, dialogs) + preload`

---

## Task 3:store `importProject`

**Files:**
- Modify: `src/renderer/src/features/video-workbench/projects.ts`(`ProjectsSlice.importProject(plan, name): string`)
- Test: `src/renderer/src/features/video-workbench/__tests__/storeProjects.test.ts`(新 describe)

**行为:** 新剧(全新 id、`order` 末位、`summary` 若有)+ 每个分段(`order` 按数组)+ 每张卡(`buildCard(input, order, boardId)` 后合并 `summary`/`summaryFor`、结果字段:`status`、`remoteUrl`、`error`、`versions`(每版 `spec` 取卡片规格 + 版本 prompt,`id` 新));切到新剧、视图 overview;`revision`/`structureRevision` +1;落库。零分段的文件 → 补一段「分段 1」(硬不变量)。

**测试:** 导入后分段/卡片顺序与内容一致、id 全新;结果保留;零分段补段;切到新剧总览;可撤销(undoStack +1)。

**Commit:** `feat(workbench): importProject store action`

---

## Task 4:导出编排 + 确认页

**Files:**
- Create: `src/renderer/src/features/video-workbench/exportProject.ts`(`runProjectExport({ projectId, path, api, onProgress })`:collect → 逐个 `resolveRefMedia` 上传(并发 3)→ `buildProjectFile` → `project-write`;任何一步失败返回 `{ ok: false, reason }`,不写文件)
- Create: `src/renderer/src/pages-react/video-workbench/ExportProjectDialog.tsx`
- Test: `src/renderer/src/features/video-workbench/__tests__/exportProject.test.ts`、`src/renderer/src/pages-react/video-workbench/__tests__/ExportProjectDialog.test.tsx`
- Modify: `ProjectRail.tsx`(启用「导出当前剧」)、`ProjectOverview.tsx`(右上「导出工程」)、`VideoWorkbenchPage.tsx`(挂对话框状态)、`workbench.css`

**确认页:** 标题「导出工程」;一行「剧名 · N 段 · M 镜 · K 个素材(其中 j 个待上传)」;「保存位置」默认路径 + 「更改…」;说明「素材和成片以云端地址保存;文件包含全部提示词。」;「取消」/「导出」。导出中:「正在上传 j 个素材…(a/j)」按钮禁用;失败:红字原因,可重试;成功态:「已导出到 <path>」+「在文件夹中显示」+「完成」。

**测试:** 编排:待上传素材被上传且地址写进文件、上传失败不写文件、写失败给原因;对话框:显示统计、默认路径、点导出调编排、成功态按钮调 `shell.showItemInFolder`。

**Commit:** `feat(workbench): export project to .catwb.json with confirm dialog`

---

## Task 5:导入编排 + 确认页

**Files:**
- Create: `src/renderer/src/features/video-workbench/importProject.ts`(`loadProjectFile(path, api)` → read + parse;`uniqueProjectName` 用 store.projects)
- Create: `src/renderer/src/pages-react/video-workbench/ImportProjectDialog.tsx`
- Test: `__tests__/importProject.test.ts`、`__tests__/ImportProjectDialog.test.tsx`
- Modify: `ProjectRail.tsx`(启用「导入工程」;`.catwb.json` 文件拖到剧栏 → 同流程)、`ProjectOverview.tsx`(右上「导入工程」)、`VideoWorkbenchPage.tsx`

**确认页:** 标题「导入工程」;剧名输入框(默认去重后的名);「N 段 · M 镜 · K 个素材」;「导出于 <时间> · 客户端 <版本>」;不兼容时红字原因且「导入」禁用;「取消」/「导入为新剧」。成功:关闭 + toast「已导入 N 段 M 镜」+ 切到新剧总览(store 动作已做)。

**测试:** 编排:读 → 解析 → 摘要;版本不兼容 → 原因;对话框:重名默认「(2)」、点导入调 `importProject`、不兼容禁用按钮;剧栏拖文件触发。

**Commit:** `feat(workbench): import .catwb.json as a new project with confirm dialog`

---

## Task 6:`data:` 残留回填(收窄版 §7)

**Files:**
- Modify: `src/renderer/src/features/video-workbench/store.ts`(`ensureHydrated` 末尾:空闲时扫全部卡片,`data:image/*` 素材逐条 `startMaterialTransfer`;幂等)
- Test: `__tests__/storeMaterialTransfer.test.ts` 新用例

**测试:** 库里一张带 `data:image/png` 素材的卡,水合后转存被发起一次;https 素材不发起;重复水合不重复发起(转存模块自身按 originalSrc 去重即可)。

**Commit:** `feat(workbench): re-run COS transfer for data: image materials left over in the store on hydrate`

---

## Task 7:文档 + 发布说明 + 全量验证

- spec §6.4 / §6.3 / §7 记偏离(见顶部三条)。
- `docs/releases/v4.8.1.md`:导入/导出、两个确认页、剧栏按钮启用、`data:` 回填。
- 验证:`pnpm exec vitest run src/renderer/src/features/video-workbench src/renderer/src/pages-react/video-workbench src/main/services/videoWorkbench src/renderer/src/features/agent-chat src/main/mcp && pnpm typecheck:ci && pnpm build:vite`;实机:导出一部剧 → 改名导入 → 分段/卡片/素材地址一致。

**Commit:** `docs(workbench): spec deviations for project files + v4.8.1 release notes`
