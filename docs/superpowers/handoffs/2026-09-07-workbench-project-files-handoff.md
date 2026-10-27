# 交接:视频工作台 工程文件导入/导出(计划 2+3 / 3)

> 给接手的 AI 会话。读完这份 + 计划文档就能继续,不需要翻旧对话。
> 本文档路径:`docs/superpowers/handoffs/2026-09-07-workbench-project-files-handoff.md`

## 0. 一句话现状

在 worktree **`D:\tecx\text\wt-workbench-projects`**、分支 **`feat/workbench-project-files`**(基于 `origin/main` = `854c92df`,即 v4.8.0 发布提交)上,按 `docs/superpowers/plans/2026-09-06-video-workbench-project-files.md` 做到 **Task 5 的一半**:导出已完整落地(有测试),导入的编排 / 确认页 / 剧栏拖文件 / 页面接线已写好并提交为 WIP(`afe0013c`),**还缺导入的两个测试文件**;Task 6、Task 7 未开始。

## 1. 必读文档(按顺序)

1. `docs/superpowers/plans/2026-09-06-video-workbench-project-files.md` — 7 个任务的计划,每个任务有文件清单 / 行为 / 测试 / commit message。**顶部「与设计稿的偏离」三条已定,照做即可。**
2. `docs/superpowers/specs/2026-09-04-video-workbench-projects-design.md` §6(工程文件)、§7(`data:` 落盘)、§9(风险)、§10(测试)。
3. `docs/releases/v4.8.0.md` — 发布说明的口吻与格式(Task 7 要写 `v4.8.1.md`)。

## 2. 已完成(每个都有提交,测试全绿)

| Task | 提交 | 内容 | 测试 |
|---|---|---|---|
| 1 | `d20ba3d8` | `features/video-workbench/projectFile.ts`:格式常量、`collectExportTargets`、`buildProjectFile`、`parseProjectFile`(reviver 拒 `__proto__/constructor/prototype`,format/version/invalid/too-large 四种 code)、`uniqueProjectName`、`planImport`、`summarize` | `__tests__/projectFile.test.ts` 8 条 |
| 2 | `b2384507` | `src/main/services/videoWorkbench/projectFileIpc.ts`:`safeProjectFileName`、`defaultProjectFilePath`(文档/CATIMATION 工程/)、`writeProjectFileAtomic`(tmp+rename)、`readProjectFileText`(stat 先看体积);5 个 IPC:`video-workbench:project-{default-path,pick-save-path,write,pick-open,read}`;`src/main/index.ts` 里 `registerProjectFileIpc(() => mainWindow)`;preload `electronAPI.videoWorkbench.projectFile.{defaultPath,pickSavePath,write,pickOpen,read}` | `__tests__/projectFileIpc.test.ts` 6 条 |
| 3 | `85cc2a69` | `projects.ts` 新动作 `importProject(plan, name, summary?) → id`:全新 id、`summary` 带过去、已完成/失败保留 `status/remoteUrl/error/versions`(版本 `spec` 用卡片规格 + 版本 prompt)、其余草稿、零分段补「分段 1」、切到新剧总览、`revision`/`structureRevision` +1、落库 | `storeProjects.test.ts` 新 describe 2 条 |
| 4 | `edf15cbd` | `features/video-workbench/exportProject.ts`:`runProjectExport({project,boards,cards,app,path,api,onProgress})`,并发 3 上传待上传项(本地路径 → `attachments.resolveRefMedia`;`data:image/*` → `cos.uploadImageHistory`),任何失败不写文件;`pages-react/video-workbench/ExportProjectDialog.tsx`(统计行 / 保存位置+更改… / 说明 / 进度 / 失败重试 / 成功态「在文件夹中显示」);`VideoWorkbenchPage.tsx` 挂 `exportOpen`;`ProjectRail` 的 `onRequestExport` 与 `ProjectOverview` 右上「导出工程」接通;`workbench.css` 加 `.vw-dialog*` | `exportProject.test.ts` 4 条 + `ExportProjectDialog.test.tsx` 3 条 |
| 5(半) | `afe0013c` WIP | `features/video-workbench/importProject.ts`(`loadProjectFile(path, api)` = read + parse → summary;`isProjectFileName`);`pages-react/video-workbench/ImportProjectDialog.tsx`(props `{ path: string \| null, onClose }`,path 非空即打开:读 → 剧名输入框默认去重名 → 「N 段 · M 镜 · K 个素材」→ 「导出于 … · 客户端 …」→ version/invalid 红字且按钮禁用 → 「导入为新剧」调 `importProject(planImport(file), uniqueProjectName(...), file.project.summary)` + toast);`VideoWorkbenchPage.tsx` 挂 `importPath` 状态 + `requestImport()`(`projectFile.pickOpen()`)+ `<ImportProjectDialog>`;`ProjectRail` 新 prop `onDropProjectFile`,aside 级 dragenter/over/leave/drop 接系统文件(`electronAPI.getFilePath(file)` 取真实路径,只认 `.catwb.json`),`.vw-rail-fileover` 高亮;`ProjectOverview` 右上「导入工程」;两个按钮 title 改成真实文案 | **缺**(见 §3) |

既有相关测试跑过仍全绿:`ProjectRail.test.tsx`、`ProjectOverview.test.tsx`、`VideoWorkbenchPage.cost.test.tsx`。四个新改文件零 lint。

## 3. 下一步(接手从这里开始)

### 3.1 补 Task 5 的测试,然后把 WIP 改成正式提交

**`src/renderer/src/features/video-workbench/__tests__/importProject.test.ts`**(纯函数,mock `api.read`):
- read ok + 合法文件 → `{ ok: true, file, summary }`
- read 失败(`code: 'not-found'`)→ 透传 code/reason
- 文件 `formatVersion` 高于本机 → `code: 'version'`,reason 含「更新」
- `isProjectFileName('a.catwb.json') === true`、`'a.json' === false`、大小写不敏感

**`src/renderer/src/pages-react/video-workbench/__tests__/ImportProjectDialog.test.tsx`**(照 `ExportProjectDialog.test.tsx` 的 mock 形状,把 `window.electronAPI.videoWorkbench.projectFile.read` mock 掉):
- 打开后显示文件名、读完显示「N 段 · M 镜 · K 个素材」与导出时间/版本;剧名输入框默认值 = 文件里的名;库里已有同名时默认值是「名 (2)」
- 点「导入为新剧」→ `S().projects` 多一部、`activeProjectId` 切过去、`viewByProject[id].mode === 'overview'`、toast 被加(`useToastStore.getState().toasts`)、`onClose` 被调
- read 返回不合法 / 高版本 → `role="alert"` 有原因,「导入为新剧」`disabled`
- `path={null}` 不渲染
- 剧栏拖文件:在 `ProjectRail.test.tsx` 加一条 —— 构造带 `Files` 类型和一个 `name: 'x.catwb.json'` 的 `dataTransfer`,mock `electronAPI.getFilePath` 返回路径,`fireEvent.drop(aside)` 后 `onDropProjectFile` 被调且参数是该路径;拖非工程文件不调

工具提示:jsdom 没有 jest-dom,用 `toBeTruthy()/toBeNull()/hasAttribute('disabled')`;`__tests__/` 里 types 的相对路径是 `'../../../../../types/videoWorkbench'`;`fireEvent.drop` 的 dataTransfer 要自己造 `{ types: ['Files'], files: [file], getData: () => '' }`。

测试绿后:`git commit --amend` **不要用**(WIP 已提交,直接再提一个 `test(workbench): import project dialog + orchestration tests`,或者 `git reset --soft HEAD~1` 后一起提为计划里的 commit message `feat(workbench): import .catwb.json as a new project with confirm dialog`——后者更干净,分支未推送,安全)。

### 3.2 Task 6:`data:` 残留回填(收窄版)

见计划文档 Task 6。要点:`store.ts` 的 `ensureHydrated` 末尾,`requestIdleCallback`(测试里回退 `setTimeout 0`)扫全部卡片三类素材,`src` 以 `data:image/` 开头的逐条 `startMaterialTransfer({ cardId, kind, originalSrc }, name)`(已 import 自 `./materialTransfer`,`startTransfersFor` 在 store.ts ~L867 就是现成的按卡片调法);测试放 `storeMaterialTransfer.test.ts`。**不要**新建 `workbench-assets` 目录或 GC —— 计划里已决定收窄,理由写在计划顶部偏离第 3 条。

### 3.3 Task 7:文档 + 发布说明 + 全量验证 + PR

- spec §6.3 / §6.4 / §7 加「实施时的偏离」三条(计划顶部原文照抄即可)。
- `docs/releases/v4.8.1.md`(格式照 `v4.7.8.md`/`v4.8.0.md`):导入/导出 + 两个确认页 + 剧栏两个按钮启用 + 拖文件导入 + `data:` 回填。
- 验证命令:
  ```
  pnpm exec vitest run src/renderer/src/features/video-workbench src/renderer/src/pages-react/video-workbench src/main/services/videoWorkbench src/renderer/src/features/agent-chat src/main/mcp
  pnpm typecheck:ci      # 基线门:7 existing / 0 new 才算过
  pnpm build:vite
  ```
- 实机:`pnpm exec electron-vite dev -- --remote-debugging-port=9222`(先确认没有别的实例占单实例锁:`Get-Process electron`);用 `node scripts/dev/cdp-shot.mjs <out.png> @<expr.js>` 截图/探 DOM(agent-browser 对这个 Electron 的 devtools:// target 会卡,直连 CDP 更稳)。走一遍:导出一部剧 → 确认页显示统计与路径 → 成功态「在文件夹中显示」→ 改名导入 → 新剧的分段/卡片/素材地址与原剧一致、id 全新。
- 推送 + 开 PR(`gh pr create --base main`),PR 正文照 #300 的结构;CI 七项(Quality Gate)全绿后合并;发版流程见 §5。

## 4. 关键约定与坑(别再踩)

- **每部剧至少一个分段**是硬不变量(`activeBoardId: string`),导入零分段的文件要补「分段 1」——已在 `importProject` 里做了。
- **工程文件里只有 https**:`buildProjectFile` 对拿不到 https 的素材整份拒绝;`asset://` 取 `previewUrl`;成片取 `remoteUrl`,只有 `localPath` 的成片要先传。这是设计稿 §6.1 的前提(COS 桶无过期,用户 2026-09-04 确认)。
- **解析在渲染端**(不是设计稿写的主进程),主进程只守 50 MB 闸 + 后缀——不要再写第二份校验。
- 转存字节通道 `cos:enqueue-upload-bytes` **只认 image/**(非图 mime 会被改写成 png 存成坏文件),所以内联视频/音频不在导出时上传——`uploadOne` 对 `data:video/*` 直接报错让导出失败并说明。
- `git commit` 用 `-F .git-commit-msg.txt`(PowerShell 不吃 heredoc);pwsh 7 输出中文会乱码,看结果用 `Select-String` 过滤关键行。
- vitest 偶发「Failed to start forks worker / Timeout waiting for worker」是环境抖动,重跑即可。
- `main` 是 strict 保护分支:只能走 PR;合一个 PR 其余 PR 立刻落后需 `update-branch`。
- 别手改 `src/main/agent/generated/firstPartySkills.generated.ts` / 顶层 `skills/` 镜像——本分支没碰 skill,不需要重生成。
- 未跟踪的 `scripts/dev/approve-release-gates.ps1`(发版批阀助手)和 `.git-commit-msg.txt` 是工作区杂物,不要提交进功能 PR。

## 5. 发版(合并后,如需发 4.8.1)

与 4.8.0 完全相同的流程,全程约 30 分钟:
1. 从 `origin/main` 开分支只改 `package.json` 的 `version` → PR `chore(release): 4.8.1` → CI 绿 → squash 合并。
2. `gh workflow run release.yml --ref main -f version=4.8.1 -f dry_run=false`。
3. 三道 `production` 环境审批阀(COS 预检 → Windows 构建 → 发布)用 `pwsh scripts/dev/approve-release-gates.ps1 -RunId <run> -EnvironmentId 18089468368` 自动批(审批人 = 仓库 owner 自己,允许自审)。
4. 校验:`gh release view v4.8.1`;`https://map-tiles-bucket-1345773498.cos.ap-guangzhou.myqcloud.com/releases/latest.yml` 的 `version` 已切换。
5. 发布说明文件 `docs/releases/v4.8.1.md` 必须已在 main 上,否则 `resolve-release-sha.mjs` 会拒。

## 6. 文件索引(本分支新增/改动)

```
docs/superpowers/plans/2026-09-06-video-workbench-project-files.md      计划
src/renderer/src/features/video-workbench/projectFile.ts                格式/解析/规划(纯)
src/renderer/src/features/video-workbench/exportProject.ts              导出编排
src/renderer/src/features/video-workbench/importProject.ts              导入编排(读+解析)
src/renderer/src/features/video-workbench/projects.ts                   + importProject 动作、importedCard
src/main/services/videoWorkbench/projectFileIpc.ts                      主进程文件 IO + 5 个 IPC
src/main/index.ts                                                       registerProjectFileIpc
src/preload/index.ts                                                    videoWorkbench.projectFile.*
src/renderer/src/pages-react/video-workbench/ExportProjectDialog.tsx
src/renderer/src/pages-react/video-workbench/ImportProjectDialog.tsx
src/renderer/src/pages-react/video-workbench/ProjectRail.tsx            onDropProjectFile + 文件拖放 + 按钮启用
src/renderer/src/pages-react/video-workbench/ProjectOverview.tsx        右上 导入/导出 按钮
src/renderer/src/pages-react/VideoWorkbenchPage.tsx                     exportOpen / importPath / requestImport
src/renderer/src/pages-react/video-workbench/workbench.css              .vw-dialog* / .vw-rail-fileover
__tests__: projectFile / projectFileIpc / storeProjects(+2) / exportProject / ExportProjectDialog
```
