# 视频工作台「剧 / 分段」项目层 + 工程文件 设计稿

日期:2026-09-04 · 状态:待用户审阅 · 范围:`src/renderer/src/features/video-workbench`、`src/renderer/src/pages-react/video-workbench`、`src/main/mcp/tools/videoWorkbenchTools.ts`、少量主进程 IPC

设计稿画布(Superdesign):`https://superdesign.dev/teams/52f24046-ddee-494a-9240-03724e55afbd/projects/bec54c70-b833-4138-bb3a-73d603f1b9cd`
- 基线:`2778f50a`(现状像素复刻)
- 选定方向:**A · 左侧剧栏**(`aa35366c` 手写版 / `be667c4d` 模型版)+ **D · 剧总览**(`73609422`)+ **E · 首启迁移态**(`ec3c019f`)
- 未选:B 顶部下拉(`bc4ad3a9` / `a5fce414`)、C 剧网格首页(`446b058a` / `685a2cfb`)——保留在画布上供对比

---

## 1. 背景与目标

现状:工作台只有「页面(board)→ 卡片(card)」两层。用户把不同片子的分段全塞在一个空间里,14 个页签折成三行,找不到、看不清(见用户截图)。

目标:
1. 加一层**剧(project)**,不同片子彼此隔离;进入一部剧先看它所有**分段**的总览,再进分段编辑镜头。
2. 一部剧可以**导出为一个工程文件**,也可以从文件**导入为一部新剧**——用户级的「保存工程 / 备份 / 迁移」。
3. 顺手把粘贴进来的 `data:` 图片落成磁盘文件,IndexedDB 不再存大 blob。

**卡片(`WorkbenchCard`)的设计与行为一个像素不改。**

## 2. 非目标(明确不做)

- 不做四层(剧 → 分段 → 页面 → 卡片)。
- 不做 zip 完整包(把视频字节装进文件);格式上留位,见 §6.5。
- 不做人像库的账号/池隔离语义:工程文件里人像库素材只是一个普通的图片地址。
- 不做视频抽帧生成封面;封面只用已有字段(见 §5.4)。
- 不迁移到 SQLite / PGlite;继续 IndexedDB,理由见会话结论(数据量 3.5 MB、单窗口、无跨进程读需求)。
- 不改现有 12 个 MCP 工具的参数签名。

## 3. 术语与信息架构

| 层 | 代码名 | 界面文案 | 说明 |
|---|---|---|---|
| 剧 | `Project` | 剧 | 新增。一部片子/一个项目;彼此隔离 |
| 分段 | `Board`(不改名) | 分段(原「页面」) | 现有 board,归属某一部剧 |
| 镜头 | `Card` | 卡片 / 镜 | 现有卡片,不改 |
| 版本 | card version | 版本 | 现有,不改 |

对齐 AI 电影工作流的通行层级 Project → Scene → Shot → Take(Lotix、Rewake、ScreenWeaver 均如此)。

工作台任意时刻只有一个「当前剧」(`activeProjectId`);所有列表、统计、撤销可见范围、Agent 视图都按它过滤。

## 4. 界面与交互

### 4.1 三屏与下钻路径

**① 剧栏(左,220px,可折叠到 48px)**
- 顶部:搜索框(占位「搜索剧 / 分段」,快捷键 `Ctrl+P`)+ 黄色方块「+」新建剧。
- 每行:封面缩略图(56×32)、剧名、`N 段 · M 镜 · ¥x`、更新时间(相对)、底部 2px 三色条(完成 / 生成中 / 失败 比例);黄点+数字 = 有卡片生成中,红点+数字 = 有失败。当前剧:黄色左条 + `#18181b` 底。
- 底部两个幽灵按钮:「导入工程」「导出当前剧」。
- 行右键 / ⋯:重命名、复制、导出、移动分段到…、删除。行可拖拽排序。
- 折叠态只显示封面;折叠状态记忆。

**② 剧总览(进入一部剧默认落在这里)**
- 面包屑「剧 › 剧名 › 总览」。
- 头部:剧名(点击就地改名,Esc 取消)+ 汇总芯片「N 段 · 总时长 m:ss · M 镜 · 已完成 x% · [k 镜生成中] · [k 镜失败] · 已花费 ¥x · 更新于 …」+ 右侧「导出工程」「⋯」「+ 新建分段」(主按钮)。
- 主体:分段网格(3 列)。每张:封面(16:9)、左上序号、右下时长、左下状态角标(生成中 / 失败)、段名、`镜数 · 花费 · 更新时间`、底部 3px 三色条。拖拽排序即分段顺序。末尾虚线卡「+ 新建分段 / 或从其它剧『移动到…』」。
- 空态:「这部剧还没有分段」+ 新建 / 移动。
- 网格 / 列表视图切换(列表视图为同信息的紧凑行,后续迭代可做,首版只做网格)。

**③ 分段页 = 现有工作台**,只改三处:
- 标题上方加面包屑「‹ 剧名 › 分段名」,「‹」回总览。
- 页签行(`BoardTabs`)只显示本剧的分段、**单行**、超出横向滚动配 ‹ ›,不再换行。
- 统计行改为「本段 N 镜 · ¥x」。
- 摘要行、工具条(撤销/重做、站点、默认上传人像库、允许 AI 自动生成、全部生成、添加卡片)、卡片卷轴、拖拽、撤销栈全部不动。

### 4.2 行为规则

- **生成不被导航打断**:切剧、切分段、折叠剧栏都不影响后台任务;任务完成 toast 带「回到 剧名 › 分段名」。
- **新建零表单**:「+」立即创建「未命名剧 N」进入总览并聚焦剧名输入;新建分段同理。
- **删除可撤销**:删剧/删分段进现有撤销栈;确认文案写明「将删除 N 段 · M 镜」;有生成中卡片的剧不能删,提示先取消。
- **移动而不重做**:卡片可拖到页签行的另一分段;分段可右键「移动到…」换剧。
- **老数据一次归位**:升级首启把所有现有 board 归入「默认项目」(legacy 标记),剧栏默认选中它,总览顶部出可关闭提示条:「这是升级前的 N 个页面,已原样放进『默认项目』——可以重命名这部剧,或把分段拖到左侧新建一部剧并移入」。拖分段到剧栏顶部虚线投放框 = 新建剧并移入;拖到某剧行 = 移入该剧。
- **花费有出处**:分段花费 = 卡片累加,剧花费 = 分段累加,复用现有 cost 估算函数;口径与设置页「使用明细」一致。
- **视图记忆**:每部剧记住上次停在总览还是哪个分段(`viewByProject`)。

### 4.3 视觉约束

只用 `src/renderer/src/styles/index.css` 的 `@theme` 与 `workbench.css` 既有 token:黄 `#FCE300`、底 `#09090B / #111113 / #18181b / #27272a`、边 `#3F3F46`、灰字 `#71717a`、成功 `#22c55e`、失败 `#f87171`;圆角 0–2px;无投影(强调用黄 glow);Orbitron 做剧名与序号,Exo 2 / Noto Sans SC 正文。顶栏、跑马灯、导航 tab 不动。

## 5. 数据模型与迁移

### 5.1 类型(`src/types/videoWorkbench.ts`)

```ts
export interface VideoWorkbenchProject {
  id: string
  name: string
  order: number
  createdAt: number
  updatedAt: number
  /** 仅升级生成的「默认项目」带此标记,用于显示迁移提示条;用户关闭提示或改名后清除。 */
  legacy?: true
}

export interface VideoWorkbenchBoard {
  /* …原字段不变 */
  projectId: string   // 新增,必填
}
```

`Board` / `boardId` 等代码命名不改,只改界面文案与工具描述。

### 5.2 IndexedDB `catimation-video-workbench` v2 → v3

- 新增 object store `projects`(keyPath `id`)。
- `boards` 加索引 `by-project`(`projectId`);`cards` 加索引 `by-board`(`boardId`)。索引现在建好,为将来按剧懒加载留路,本期不用。
- `onupgradeneeded` 内:写入 `{ id: 'project-default', name: '默认项目', order: 0, legacy: true, createdAt: now, updatedAt: now }`;遍历 `boards`,缺 `projectId` 的全部置为 `project-default`。升级事务原子:中途失败整体回滚仍留 v2,不会出现半迁移。
- `hydrate` 再兜一次底:任何缺 `projectId` 的 board(老代码路径写入)同样归默认项目;若 `projects` 为空则补默认项目。迁移幂等。
- 单窗口应用无多 tab 抢 `versionchange` 锁;dev(`localhost:*`)与打包版(`file://`)origin 不同,各自独立升级。

### 5.3 内存模型

启动仍**全量**读入 projects / boards / cards(现状几百张卡、3.5 MB)。隔离是**选择器层面**的:`selectBoardsOfActiveProject`、`selectCardsOfActiveProject`、统计、撤销可见范围、Agent 视图全部按 `activeProjectId` 过滤。不做按需读写,避免后台任务进度回写、撤销栈、跨剧移动各多一套 DB 逻辑。卡片到万级再评估懒加载。

### 5.4 store 新增(新文件 `features/video-workbench/projects.ts`,不再往 2353 行的 `store.ts` 堆)

状态:`projects: VideoWorkbenchProject[]`、`activeProjectId: string`、`viewByProject: Record<string, { mode: 'overview' | 'board'; boardId?: string }>`、`railCollapsed: boolean`。

动作:`addProject(name?)`、`renameProject(id, name)`、`reorderProjects(ids)`、`switchProject(id)`、`openOverview()`、`openBoard(boardId)`、`moveBoardToProject(boardId, projectId)`、`duplicateProject(id)`(分段 + 卡片深拷贝、新 id、素材引用与已完成结果地址照抄,排队/生成中的卡片重置为待生成)、`removeProject(id)`(进撤销栈;存在 `isActiveStatus` 卡片则拒绝)、`dismissLegacyNotice(id)`。

统计为纯函数(`features/video-workbench/projectStats.ts`):
- 分段:镜数、按状态分桶(完成 / 生成中 / 失败 / 待生成)、已完成卡片时长之和、花费(复用现有卡片 cost 估算)。
- 剧:分段累加。
- 剧栏与总览都从这一处取数。

封面:剧/分段最近一张已完成卡片的成片 poster 字段 → 否则该卡第一张参考图 → 否则占位栅格。不做视频抽帧。

`addBoard` 改为在当前剧下创建(写 `projectId`);`removeBoard` 若删的是当前视图分段则回总览。

### 5.5 渲染层文件

新建:`pages-react/video-workbench/ProjectRail.tsx`、`ProjectOverview.tsx`、`SegmentCard.tsx`、`MigrationNotice.tsx`、`ProjectSearchPalette.tsx`(Ctrl+P)。
修改:`VideoWorkbenchPage.tsx`(两栏布局 + 按 `viewByProject` 切总览/分段页)、`BoardTabs.tsx`(本剧分段、单行横向滚动、面包屑)、`workbench.css`(新类)。
不动:`WorkbenchCard.tsx` 及其子组件。

## 6. 工程文件与导入/导出

### 6.1 原则

**素材一律以 https 地址保存**:图片、视频(参考素材与成片)、人像库素材都写成 COS 上的地址。文件里没有 base64、没有本地路径、没有 `asset://`。一部剧几十到几百 KB,跨机器、跨账号可直接导入。

**前提(待用户确认)**:COS 桶没有自动过期的生命周期规则。成片 `remoteUrl` 已长期依赖该桶,按永久处理。若桶有过期策略,本节需回退到内嵌图片字节的方案。

### 6.2 文件格式 `*.catwb.json`

```jsonc
{
  "format": "catimation-workbench-project",
  "formatVersion": 1,
  "app": { "name": "CATIMATION-Cyberpunk Master", "version": "4.7.8" },
  "exportedAt": "2026-09-04T10:32:00Z",
  "project": { "name": "追车戏 · 夜景", "createdAt": 1756900000000, "updatedAt": 1757000000000 },
  "boards": [
    {
      "name": "建立镜头 · 城市夜景",
      "summary": "…",
      "cards": [
        {
          /* WorkbenchIRCard 的全部规格字段(prompt / model / resolution / ratio / duration / …) */
          "referenceImages": [{ "name": "ref-01.png", "src": "https://…" }],
          "referenceVideos": [{ "name": "shot.mp4", "src": "https://…" }],
          "referenceAudios": [],
          "summary": "…",
          "result": {           /* WorkbenchIRCardResult:只读注解 */
            "status": "completed",
            "remoteUrl": "https://…",
            "versions": [{ "seq": 1, "remoteUrl": "https://…", "prompt": "…" }]
          }
        }
      ]
    }
  ]
}
```

- 不带任何内部 id。导入时全部生成新 id,**永远新建一部剧**;同一文件导两次是两部独立的剧。
- `formatVersion` 独立于内部 `WORKBENCH_IR_VERSION`,只在文件结构变化时递增。
- 读入校验:必填字段严格,**未知字段放行**(向前兼容);`formatVersion` 高于本机可读 → 拒绝并提示更新客户端;`format` 不匹配 → 拒绝。

### 6.3 导出流程

1. 剧栏底部 / 总览右上「导出工程」→ **确认页**(对话框):
   - 「剧名 · N 段 · M 镜 · K 个素材(其中 j 个待上传)」
   - 保存位置:默认「文档/CATIMATION 工程/剧名.catwb.json」,旁「更改…」打开系统保存对话框
   - 说明:「素材和成片以云端地址保存;文件包含全部提示词。」
   - 「取消」/「导出」
2. 点「导出」:对每个尚无 https 地址的本地素材,走现有「主进程从磁盘上传 COS」通道上传并取回地址(进度「正在上传 j 个素材…」);人像库 `asset://` 素材取其图片地址;成片取 `remoteUrl`(仅有 `localPath` 的成片同样上传)。
3. 组装 JSON → 主进程**原子写入**(先写临时文件再 rename)。
4. toast「已导出 · 在文件夹中显示」。
5. 失败:离线/上传失败 → 明确文案,不写半个文件。

### 6.4 导入流程

1. 剧栏底部 / 总览右上「导入工程」→ 系统打开对话框(过滤 `*.catwb.json`);或把文件拖到剧栏。
2. 主进程读文件 → 解析加固(拒绝 `__proto__` / `constructor` 键;字段校验;版本门)→ 返回摘要。
3. **确认页**:剧名(可改,默认原名,与现有重名自动加「(2)」)、`N 段 · M 镜 · K 个素材`、导出时间与客户端版本;版本不兼容在此页直接显示原因;「取消」/「导入为新剧」。
4. 新建剧、分段、卡片;素材为普通 https 素材(App 现有能力);处于排队/生成中的卡片重置为待生成,已完成/失败保留状态与结果地址。
5. 切到新剧总览;toast「已导入 N 段 M 镜」。

### 6.5 留位

`assets` 字段与 zip 容器不在本期实现;若将来做完整包,`src` 可改为 `sha256:…` 指向 `assets/` 内文件,读取逻辑只多一个分支。

## 7. `data:` 落盘与清理

- 现状:只有剪贴板粘贴、网页拖图两条路会产生 `data:` 素材(`WorkbenchCard.tsx` 的 `fileToMaterial`);系统文件拖入与文件选择器都是真实路径。
- 改动:渲染层把字节通过 IPC 交主进程,主进程按文件头嗅探类型、以内容哈希命名写到 `userData/workbench-assets/<sha256>.<ext>`,返回路径;素材从此是本地路径,走现有 `local-file://` 渲染与「提交时主进程上传」链路。64 MB 上限保留在 IPC 侧。
- 回填:`hydrate` 后在空闲时扫描库中残留的 `data:` 素材,逐条落盘并改写 `src`;幂等、可中断、下次启动继续。
- 清理:启动空闲时扫 `workbench-assets`,只删「无任何引用 **且** 7 天以上」的文件。引用扫描覆盖所有剧的所有卡片、撤销栈快照、进行中任务的素材;扫描失败则本轮不删任何文件。
- `workbenchIR.ts` 的 `wbref://` 占位机制不动(它服务的是「不把字节喂给 Agent」)。

## 8. Agent / MCP

- 现有 `video_workbench_*` 工具**隐式作用于当前剧**,参数签名不变。
- `video_workbench_status` 返回头部多「剧名 · N 段 · M 镜」;boards 描述改为 segment。
- `video_workbench_export` 的 IR 多带 `projectId`;`video_workbench_apply` 时与当前剧不符 → 整份拒绝(隔离的最后一道闸)。
- 新增:`video_workbench_list_projects`(id、名、统计)、`video_workbench_switch_project(projectId)`、`video_workbench_create_project(name)`。
- 批次完成推送「[视频工作台] 批次渲染完成」带「剧名 › 分段名」。
- `catimation-video-workbench` skill 文档与工具描述同步改文案(页面 → 分段,加剧的概念);经 `scripts/sync-top-level-skills.mjs` 等既有生成链同步,不手改镜像。

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| 工程文件依赖 COS 地址存活 | 前提确认(§6.1);地址失效表现与现有外链素材一致(预览裂图、提交报明确错误),不发明新状态 |
| 不可信 JSON:原型污染、畸形字段、超大文件 | 解析拒 `__proto__`/`constructor`;字段校验、未知字段放行、版本门;文件大小上限 50 MB(URL 方案下正常文件远小于此) |
| 写文件中途崩溃留下半个文件 | 临时文件 + rename |
| 内容寻址目录 GC 误删 | 引用扫描覆盖全部剧 + 撤销栈 + 进行中任务;扫描失败不删;7 天宽限 |
| IndexedDB 升级失败 | `versionchange` 事务原子回滚;`hydrate` 幂等兜底;`onblocked` 提示重启 |
| 删除误操作 | 撤销栈 + 明确数量文案 + 生成中拒删 |
| 隐私:文件含全部提示词与云端地址 | 确认页一句说明;不加密(备份格式而非分发格式) |
| `store.ts` 继续膨胀 | 项目层逻辑与统计放新文件;`store.ts` 只接线 |

## 10. 测试

- 迁移:v2 数据升到 v3 全部归默认项目;重复 `hydrate` 幂等;升级中途抛错仍为 v2。
- 隔离:切剧后列表 / 统计 / 撤销 / `status` 看不到别的剧;`apply` 带错 `projectId` 被拒。
- 剧动作:`removeProject` 可撤销、生成中拒删;`moveBoardToProject` 后两边统计同时正确;`duplicateProject` 状态重置且 id 全新。
- 统计纯函数:分桶、时长、花费口径用例。
- 工程文件:导出 → 导入往返后分段 / 卡片 / 素材地址一致(id 除外);未上传素材导出时被上传并写地址;生成中状态被重置;同名加「(2)」;高版本拒绝;`__proto__` 键拒绝;原子写(模拟 rename 前崩溃不留半文件)。
- `data:` 落盘:同字节只落一份;回填幂等;GC 保留被引用文件、扫描失败不删。
- 渲染:剧栏行状态点、总览三色条、页签单行滚动、面包屑回总览、迁移提示条关闭后不再出现、Ctrl+P 搜索。
- MCP:三个新工具 + `status` 头部 + `apply` 的 `projectId` 校验;`toolAnnotations.test.ts` 同步。

## 11. 实施拆分建议(供 writing-plans 细化)

1. 类型 + IndexedDB v3 迁移 + `projects.ts` / `projectStats.ts`(纯逻辑,先红后绿)。
2. 剧栏 + 总览 + 分段页三处改动 + 迁移提示条(渲染层,卡片不动)。
3. `data:` 落盘 IPC + 回填 + GC。
4. 工程文件导出 / 导入(主进程 IPC + 两个确认页)。
5. MCP 三工具 + `status` / `apply` 改动 + skill 文案同步。
6. 文档与发布说明。

## 12. 待用户确认

- COS 桶是否无自动过期策略(§6.1 前提)。
