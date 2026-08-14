// 「生成视频」工作台（卷轴式并发视频任务卡片）—— main / preload / renderer 三端共享类型。
//
// 架构约定（对齐音频页「共享核心」模式 + Seedance 现有链路）：
// - 卡片状态的单一真相源在渲染端 zustand store（useVideoWorkbenchStore），
//   IndexedDB 持久化草稿与结果元数据；
// - 生成走主进程既有 SeedanceTaskManager（video-workbench:submit IPC 复用
//   generate_video 的 buildContent / 人像库导入 / 提交 / 轮询 / 落盘链路），
//   进度经既有 `seedance:task-update` 广播回渲染端（source: 'workbench'）；
// - MCP 工具（video_workbench_*）经 agent:tool-request 路由到渲染端
//   AgentToolExecutor，直接操作同一个 zustand store —— 人与 AI 操作同一页面。

import type {
  SeedanceModelAlias,
  SeedancePersistence,
  SeedanceTaskMode,
  SeedanceTaskStatus,
} from './seedance'
import type { VideoWorkbenchMode } from './videoModes'

/**
 * 生成模式。定义搬到了 `./videoModes` —— 能力表要按模型声明可用模式，而本文件
 * 与 `seedance.ts` 都有运行时导出，互相 import 会成真环。这里 re-export，现有
 * 引用不受影响。
 */
export type { VideoWorkbenchMode } from './videoModes'

/** 工作台卡片可编辑的视频规格（Seedance 支持的参数面）。 */
export interface VideoWorkbenchSpec {
  prompt: string
  model: SeedanceModelAlias
  resolution: '480p' | '720p' | '1080p'
  ratio: '16:9' | '9:16' | '4:3' | '3:4' | '1:1' | '21:9'
  /** 视频时长（秒，4–15;-1 = 智能时长,模型自动决定,文档 8.1）。 */
  duration: number
  generateAudio: boolean
  /** 生成模式（缺省 multimodal_ref 全能参考,与旧卡片行为一致）。 */
  mode: VideoWorkbenchMode
  /** 随机种子（0–4294967295;undefined=随机）。仅 Seedance 2.0。 */
  seed?: number
  /** 联网搜索增强（上游 tools: [{type:'web_search'}]）。仅 Seedance 2.0。 */
  webSearch: boolean
  /** 参考图（≤9）：data: URL / 本地路径 / https / asset://。 */
  referenceImages: VideoWorkbenchMaterial[]
  /** 参考视频（≤3，总时长 ≤15s）。 */
  referenceVideos: VideoWorkbenchMaterial[]
  /** 参考音频（≤3，总时长 ≤15s）。 */
  referenceAudios: VideoWorkbenchMaterial[]
}

// ---------------------------------------------------------------------------
// MCP 渐进式披露的三个数(主进程的工具 schema 与渲染端的执行器共用,所以放这里)
//
// codex 把**每次工具调用**的输出截到 10_000 token,而且是**静默**截断。那个上限
// 是我们自己在 codexLaunch 用 `-c tool_output_token_limit=10000` 钉死的,不能靠
// 调大它绕过 —— 钉死的理由是防止用户级 config.toml 把它放大到 64K 撑爆网关字节
// 上限。所以体积得由工具自己守。家规见 docs/2026-06-12-mcp-stdio-bridge-pitfalls.md
// 「工具返回列表？→ 必须分页 + hasMore」,参考实现是 portraitTools 的
// list_portrait_library。
// ---------------------------------------------------------------------------

/**
 * 一次 `video_workbench_add_tasks` 最多写几张卡。
 *
 * 卡这个数不是为了体积,是为了**别让用户干等**:一张卡的 JSON 约 500 token,模型
 * 逐 token 生成,二十张就是几分钟的静默输出 —— 而工具调用在飞的时候模型不推理、
 * 用户排队的 turn/steer 也进不来(同 batchCompletion 里那句「启动后卡住,没法
 * 说话」)。切小之后卡片逐批出现,配 autoStart 还能让上一批开始渲染时 agent 在写
 * 下一批。
 */
export const WORKBENCH_MAX_TASKS_PER_CALL = 5

/**
 * `video_workbench_status` 每页卡数。
 *
 * 取 3 不是抠体积,是让 agent 能**边读边动手**:一张卡的 JSON 约 500 token,
 * 12 张就是六千 token 一次灌进来,而它九成时候只关心其中一两张。3 张读完就够
 * 决定「是不是这几张」,不是就跳下一页 —— 配 pageIndex 目录通常一跳到位。
 *
 * 别调回大值来「少翻几页」:翻页的成本已经被目录摊掉了,而灌进来的卡片是实打实
 * 占着上下文直到会话结束。要一次看很多张,应当用 cardIds 点名。
 */
export const WORKBENCH_STATUS_PAGE_SIZE = 3
export const WORKBENCH_STATUS_MAX_PAGE_SIZE = 50
/**
 * `pageIndex` 目录最多几条。目录本身也会膨胀:200 张卡按 3 张一页就是 67 条,
 * 那又变成一次性倒出去了。超出就截断,agent 仍可用 page 参数直接翻到后面。
 */
export const WORKBENCH_STATUS_MAX_INDEX_ENTRIES = 30

/**
 * 页面摘要字数上限。
 *
 * 60 不是随手定的:摘要要跟着 boards 目录在**每一次**工作台工具调用里回传,
 * 十页就是十条。写成句子的话十条能顶掉一整屏上下文,而它本来是用来省上下文的。
 * 60 字够写「追车 · 夜外 · 主角车vs追兵」这种电报体,不够写一段话 —— 这个约束
 * 本身就是在逼出正确的格式。
 *
 * 超限在工具层**报错**而不是静默截断:截断会在半个词上切断,agent 还以为写进去了。
 */
export const WORKBENCH_BOARD_SUMMARY_MAX = 60

/**
 * 卡片摘要上限。比页摘要更短 —— 页摘要一页一条,卡片摘要是**一页里每张卡一条**,
 * 二十张卡就是二十条,长度直接乘以卡数。40 字够写「主角跳车 · 夜外 · 追兵逼近」
 * 这种电报体,而这正是它该有的样子:它是索引,不是简介。
 *
 * 同页摘要:超限在工具层**报错**而不是静默截断。
 */
export const WORKBENCH_CARD_SUMMARY_MAX = 40

/**
 * 一次 `video_workbench_apply` 里最多允许几张卡**携带内容**。
 *
 * 数的是内容卡，不是卡片总数 —— 只给 id 的「占位」条目不计入，所以重排一个
 * 二十张卡的页照样一次做完。按总数拦会弄坏重排：IR 的数组顺序就是页内顺序，
 * 合并模式下没列出的卡会被追加到列出的卡后面，少列几张就等于把它们全挤下去。
 *
 * 为什么要拦而不只是在描述里劝：描述是建议，模型可以不听，而这一趟的代价全落在
 * 用户身上 —— 十七张卡的完整提示词要被模型读完、改完、再吐回来，实测卡到 JSON
 * 解析失败重来，用户只能盯着 RUNNING 干等。5 与 `WORKBENCH_MAX_TASKS_PER_CALL`
 * 对齐:同样是「一批能让人看到进展」的量。
 *
 * 超限**整份拒绝、零写入**，并告诉调用方该换哪个工具（规格扫全板 → set_spec，
 * 逐卡改内容 → update_task）。截半份写进去比拒绝糟得多。
 */
export const WORKBENCH_APPLY_MAX_CONTENT_CARDS = 5

/** 参考素材条目（展示名 + 可提交源）。 */
export interface VideoWorkbenchMaterial {
  /** 展示名（文件名 / 素材名）。 */
  name: string
  /** 可提交上游的源：data: URL / 本地绝对路径 / https URL / asset://assetId。 */
  src: string
  /**
   * 展示用预览地址（asset:// 源无法直接渲染,人像库回填时带上游 previewUrl;
   * 其余源缺省用 src 本身展示）。
   */
  previewUrl?: string
  /**
   * 本地图「拖入即传」拿到的 COS 地址。**是缓存,不是真相源** —— `src` 始终是
   * 那条本地路径,提交时优先用这里的 URL,没有就退回 src 让主进程照旧上传。
   *
   * 刻意**不持久化**（`WorkbenchDb.put` 会剥掉）。仓库里没有任何地方声明或配置
   * 过 COS 桶的生命周期规则,所以一个几周前 mint 的地址是死是活无从判断;而卡片
   * 会在 IndexedDB 里一直躺到用户自己删（卡片总量无上限）。存下来的收益（隔天
   * 生成省一次上传）远小于代价（拿一个死链去提交,而且重试还是同一个死链）。
   * 丢掉它,重启后就是今天的行为:提交时主进程从磁盘流式上传。
   *
   * 同一个文件出现在两个槽位时会各传各的、拿到两个不同地址 —— 上游按下标解析
   * `@参考N`（Seedance OpenAPI §2.3）,共用一个地址有可能被折叠成一个参考,
   * 后面的编号全体前移且不报错。
   */
  uploadedUrl?: string
  /**
   * 预传的进行态,**只为界面存在**(转圈 / 打勾 / 传失败)。与 `uploadedUrl` 同样
   * 是会话内缓存,不落库。
   *
   * 为什么不能只看 `uploadedUrl` 有没有:那样「没有」同时意味着**在传**、
   * **传失败**、**根本不用传**(https / data: / asset:// 源本来就没有本地文件要传)
   * 三种情况。照那个画转圈,传失败的会永远转下去 —— 比不画还糟。
   */
  uploadState?: 'uploading' | 'uploaded' | 'failed'
}

/**
 * 卡片状态机：
 *   draft（可编辑）→ preparing（素材上送/创建任务中）→ queued/running（上游渲染）
 *   → succeeded / failed / cancelled（终态；failed 与 cancelled 都可重试回 preparing）。
 */
export type VideoWorkbenchCardStatus =
  | 'draft'
  | 'preparing'
  | SeedanceTaskStatus

/**
 * 工作台「页」(board / 工作区):每页一套独立的卡片集合,页签在顶部工具栏切换。
 * IndexedDB `boards` object store 持久化;老数据(无 boards)迁移进第一页。
 */
export interface VideoWorkbenchBoard {
  id: string
  name: string
  /**
   * 一句话说明这一页装的是什么（「追车戏 8 镜，全部夜景」）。
   *
   * 这是渐进披露缺的那一层索引。status 默认只回当前页的卡片，别页只给
   * id / name / cardCount —— 光看「第 3 页，20 张卡」判断不了要不要去拉它，
   * 而页名常常只是「页面 3」。有了摘要，agent 能在**不拉卡片**的前提下决定
   * 该翻哪一页，这正是分批读取想省下的那部分。
   *
   * 由 agent 写（video_workbench_set_board_summary），不参与生成、不影响出片；
   * 纯粹是给「下一次回来的人」留的路标，所以也不进撤销栈的编排意图。
   */
  summary?: string
  /** 页签排序(小在左)。 */
  order: number
  createdAt: number
}

/** 一张工作台任务卡片（渲染端真相源 + IndexedDB 持久化形状）。 */
export interface VideoWorkbenchCard extends VideoWorkbenchSpec {
  id: string
  /** 所属「页」id;老数据缺省,hydrate 时迁入第一页。 */
  boardId?: string
  /** 页内卷轴排序（小在上,按页独立计数）。 */
  order: number
  status: VideoWorkbenchCardStatus
  createdAt: number
  updatedAt: number
  /**
   * agent 写的一行摘要（`video_workbench_set_card_summary`），给「不拉全文就能
   * 认出这是哪一镜」用。不参与生成、不影响出片。
   *
   * 与 `summaryFor` 成对存在:后者是写摘要时那份提示词的指纹,提示词一变就对不上,
   * 摘要随即被判为过期、不再展示。**别把它绑到 `rev`** —— rev 在素材上传完成
   * 这类后台事件里也会涨,内容一个字没变,绑 rev 会让摘要集体假过期。
   */
  summary?: string
  /** 写 `summary` 时提示词的指纹（见 cardSummary.promptFingerprint）。 */
  summaryFor?: string
  /** 提交时渲染端生成，贯穿 seedance:task-update 广播做卡片对齐。 */
  clientId?: string
  /**
   * 本轮提交的开始时间。UI 的「已耗时」必须用它 —— 早先用 updatedAt 做起点，
   * 而每条进度广播都会 bump updatedAt，秒表因此每次广播归零。重新生成时重置。
   */
  startedAt?: number
  /**
   * 用户请求了取消，但 taskId 还没回来（preparing 阶段）。submit 一 resolve 就
   * 立刻对拿到的 taskId 发取消 —— 那一刻任务几乎必然还在 queued，属于能真省钱
   * 的窗口，所以这个意图值得记住而不是让用户白点一次。
   */
  cancelRequested?: boolean
  /** createTask 成功后的上游任务 id（可用 check_video_task 续轮询）。 */
  taskId?: string
  /** succeeded 时上游临时结果地址（有效期未知，兜底播放源）。 */
  videoUrl?: string
  /** 落盘后的本地 mp4 绝对路径（权威结果）。 */
  localPath?: string
  /** COS 永久 https URL（跨设备/清理后仍可播）。 */
  remoteUrl?: string
  persistence?: SeedancePersistence
  error?: string
  /** succeeded 时上游回传的实际种子（含随机 seed 的最终值,填回可复现）。 */
  actualSeed?: number
  /** succeeded 时上游回传的 usage.completion_tokens（计费口径）。 */
  completionTokens?: number
  /** 该任务的成功结果已写入「历史记录」(防重:重载/重复广播不再入库)。 */
  historyRecorded?: boolean
  /**
   * 历次成功产物,追加序,末项 = 当前结果。重新生成不再让上一版消失。
   *
   * **是结果不是意图**:不进 apply(只作 IR 导出侧只读注解)、不进撤销栈、
   * 不参与 specEquals —— 它挂在 Card 上而非 Spec 上,天然被排除。
   */
  versions?: VideoWorkbenchVersion[]
  /**
   * 这张卡**规格**的版本号,看板 IR 的按卡并发令牌(老数据缺省 = 0)。
   *
   * 只跟 spec 走(prompt/model/素材…),**不**跟位置走 —— 位置与卡片集合的变动
   * 由 store 的 structureRevision 统管。这样「用户在 A 卡打字」不会让 agent 对
   * B..Z 的回写失效,只会跳过 A;而「用户删了一张卡」会整份拒绝,因为 agent 的
   * 位置计划已经失效。
   */
  rev?: number
}

/** MCP / IPC 写入卡片时的字段集（全部可选，缺省用默认值）。 */
export interface VideoWorkbenchCardInput {
  prompt?: string
  model?: SeedanceModelAlias
  resolution?: '480p' | '720p' | '1080p'
  ratio?: '16:9' | '9:16' | '4:3' | '3:4' | '1:1' | '21:9'
  duration?: number
  generateAudio?: boolean
  mode?: VideoWorkbenchMode
  /** 随机种子;传 null 表示清除（恢复随机）。 */
  seed?: number | null
  webSearch?: boolean
  /**
   * 字符串源（本地路径 / https / asset:// / data:，会包成 Material），
   * 或已解析好的 Material 对象（MCP 写入侧给 asset:// 引用带 previewUrl）。
   */
  referenceImages?: Array<string | VideoWorkbenchMaterial>
  referenceVideos?: Array<string | VideoWorkbenchMaterial>
  referenceAudios?: Array<string | VideoWorkbenchMaterial>
}

/**
 * 插卡锚点。位置用**稳定 cardId** 表达而不是下标 —— 下标是易变状态，调用方手里的
 * 下标可能已经不指向它以为的那张卡；id 不会漂。二选一；两者都不传 = 追加到当前页末尾。
 */
export type VideoWorkbenchInsertAnchor =
  | { afterCardId: string; beforeCardId?: undefined }
  | { beforeCardId: string; afterCardId?: undefined }

/**
 * 产出某一版时的意图快照。**素材只记名字不记字节** —— referenceImages 里可能是
 * data: URL，逐版复制会迅速撑爆 IndexedDB。卡片总量已无上限（见 WorkbenchDb.ts
 * 顶部），所以这条纪律现在是防膨胀的唯一防线，别为了「版本里也能看到图」破例。
 */
export interface VideoWorkbenchVersionSpec {
  prompt: string
  model: SeedanceModelAlias
  resolution: '480p' | '720p' | '1080p'
  ratio: '16:9' | '9:16' | '4:3' | '3:4' | '1:1' | '21:9'
  duration: number
  generateAudio: boolean
  mode: VideoWorkbenchMode
  seed?: number
  webSearch: boolean
  referenceBrief: { images: string[]; videos: string[]; audios: string[] }
}

/**
 * 一次成功渲染的产物存档。追加序，末项即卡片当前结果。
 *
 * 存在的意义：重新生成不该让上一版消失。磁盘上的 mp4 本来就不互相覆盖（文件名嵌
 * taskId），丢的只是卡片上指回去的那根指针 —— 这个数组就是那根指针。
 *
 * 存活性：`localPath` 快但会被 7 天清理扫掉（AttachmentService.cleanup 判断「仍被
 * 引用」时只扫聊天记录，工作台卡片对它隐形），`remoteUrl` 才是耐久源。播放按
 * localPath → remoteUrl → videoUrl 逐级降级。
 */
export interface VideoWorkbenchVersion {
  id: string
  /** 卡内序号，从 1 起，只增不回收。UI 显示为 v1/v2，绝不与位置号拼接。 */
  seq: number
  createdAt: number
  taskId?: string
  localPath?: string
  remoteUrl?: string
  videoUrl?: string
  actualSeed?: number
  completionTokens?: number
  spec: VideoWorkbenchVersionSpec
}

// ---------------------------------------------------------------------------
// 看板 JSON IR（声明式整体读写）
//
// 存在的理由:store 有 13 个用户可做的改动,细粒度 MCP 工具只接得出一部分,
// 而「把这三页重新编排一遍」这类请求逐卡调用既费轮次又没有可审阅的中间态。
// IR 让 agent 一次导出、离线想清楚、一次写回。
//
// 三条硬纪律,决定了下面每个字段的取舍:
//
// 1. **IR 只装意图,不装结果。** status/taskId/localPath/remoteUrl/actualSeed
//    这些是生成的产物,不是用户的编排意图。它们只作 `result` 只读注解随导出
//    带出(给 agent 看),apply 一律忽略 —— 否则 agent 一次回写就能把真实
//    任务状态改成幻觉值。
//
// 2. **乐观并发令牌分两级。** 这个工作台的卖点是人与 AI 改同一份 store,所以
//    「agent 三十秒前读的看板」必然会过期。但单一全局令牌太悲观到不可用:
//    提示词输入框逐字符改卡,用户一边打字 agent 就永远撞冲突。所以拆成:
//    - `structureRevision`(整份):卡片集合 / 页内位置 / 页本身变了才 bump。
//      对不上 → 整份拒绝,因为 IR 的位置计划已经失效。
//    - 每张卡的 `rev`(按卡):该卡规格变了才 bump。对不上且 IR 要改这张卡
//      → **只跳过这一张**并报原因,其余照常写入。
//    两级都刻意不跟生成进度回流(applyTaskUpdate)走 —— 否则一个跑着的任务
//    会让每次 apply 都撞冲突,这个功能就废了。
//
// 3. **数组下标就是 order。** 卡片 order 在库里是按页稠密的(reorderBoard
//    每次重排都压实成 0..n-1),所以 IR 里不需要 order 字段,`cards` 的数组
//    顺序即是页内卷轴顺序,`boards` 的数组顺序即是页签顺序。
// ---------------------------------------------------------------------------

/**
 * 当前 IR 格式版本(不认识的版本 apply 直接拒绝,不做尽力而为的猜测)。
 *
 * v2:单一 `revision` 令牌换成 `structureRevision` + 每张卡的 `rev`。v1 的 IR
 * 只带全局 revision,无法判断「哪张卡被改过」,按 v2 语义处理会把用户的改动
 * 静默盖掉,所以只能拒绝并要求重新 export。
 */
export const WORKBENCH_IR_VERSION = 2

/**
 * IR 里的参考素材。只有 name + src —— `previewUrl` 是 asset:// 素材的展示
 * 派生物,apply 时由人像库重新解析,不该让 agent 手搓也不该占导出体积。
 */
export interface WorkbenchIRMaterial {
  name: string
  /** data: URL / 本地绝对路径 / https URL / asset://assetId。 */
  src: string
}

/**
 * 卡片的生成结果,只读注解。导出时带上让 agent 知道哪张卡已经出片、哪张失败了;
 * apply 时整块忽略。
 */
export interface WorkbenchIRCardResult {
  status: VideoWorkbenchCardStatus
  taskId?: string
  error?: string
  localPath?: string
  remoteUrl?: string
  /** 历次成功产物（只读注解，apply 一律忽略）。 */
  versions?: Array<{ seq: number; localPath?: string; remoteUrl?: string; prompt: string }>
}

/**
 * IR 里的一张卡:意图字段 + 身份。
 *
 * **规格字段全部可选,但语义是「声明」而不是「patch」** —— 省略某字段等于
 * 「该字段用默认值」,不是「沿用卡片原值」。所以改一张已有卡的正确做法是
 * export 拿到完整卡片、改想改的字段、原样带回其余字段;手搓一个只有
 * `{ id, prompt }` 的卡片会把它的分辨率/时长/参考图一起清成默认。
 *
 * 导出永远填满每个字段,round-trip 因此是安全的。
 */
export interface WorkbenchIRCard {
  /** 已有卡的 id。省略 = 新建一张。给了但库里没有 = 报错(而不是静默新建)。 */
  id?: string
  /**
   * 导出时这张卡的规格版本。apply 时原样带回:对不上说明用户在这期间改过这张卡,
   * 该卡的规格改动会被跳过(位置改动仍生效),其余卡不受影响。
   *
   * 省略 = 放弃这张卡的并发保护(新建卡本来就没有)。
   */
  rev?: number
  prompt?: string
  model?: SeedanceModelAlias
  resolution?: '480p' | '720p' | '1080p'
  ratio?: '16:9' | '9:16' | '4:3' | '3:4' | '1:1' | '21:9'
  duration?: number
  generateAudio?: boolean
  mode?: VideoWorkbenchMode
  seed?: number
  webSearch?: boolean
  referenceImages?: WorkbenchIRMaterial[]
  referenceVideos?: WorkbenchIRMaterial[]
  referenceAudios?: WorkbenchIRMaterial[]
  /** 只读:导出时的生成结果,apply 忽略。 */
  result?: WorkbenchIRCardResult
}

/** IR 里的一页。数组顺序即页签顺序,`cards` 数组顺序即页内卷轴顺序。 */
export interface WorkbenchIRBoard {
  /** 已有页的 id。省略 = 新建一页。给了但库里没有 = 报错。 */
  id?: string
  name: string
  cards: WorkbenchIRCard[]
}

/** 整个工作台的声明式快照。 */
export interface WorkbenchIR {
  irVersion: number
  /**
   * 导出时的**结构**版本号(卡片集合 / 页内位置 / 页本身)。apply 必须回带;
   * 对不上则整份拒绝 —— 卡片被增删或挪过位之后,IR 里按数组下标表达的位置
   * 计划已经不是 agent 当初看到的那个了。
   *
   * 单张卡的规格冲突不看这个,看 `WorkbenchIRCard.rev`。
   */
  structureRevision: number
  /** 当前激活页(apply 时若能解析就切过去)。 */
  activeBoardId?: string
  boards: WorkbenchIRBoard[]
}

export interface WorkbenchApplyOptions {
  /**
   * `merge`(缺省):IR 里没提到的页和卡原样保留 —— 安全默认,agent 只改它
   * 关心的部分。`replace`:IR 未列出的页/卡删掉 —— 真正的「整体重排」,
   * 但会删用户的东西,所以要显式要。
   */
  mode?: 'merge' | 'replace'
  /** 跳过两级并发校验。明知会盖掉用户改动时的逃生门,默认不给。 */
  force?: boolean
}

/** 单项被跳过的原因(渲染中不可改规格、id 不存在等)。 */
export interface WorkbenchApplySkip {
  cardId?: string
  boardId?: string
  reason: string
  /**
   * 并发跳过时把这张卡**现在的样子**一并带回来，让调用方不必为了「看看用户改了什么」
   * 再跑一趟 export。
   *
   * 为什么是「写入时补救」而不是「变更时推送」（2026-08-09 查证，别再重新推演）：
   * MCP 的正解本该是把看板做成可订阅资源 —— 用户一改，agent 收到
   * `notifications/resources/updated`，压根不会拿着过期的 IR 去写。协议这边是齐的
   * （2026-07-28 起 `subscriptions/listen` + SubscriptionFilter 取代了
   * `resources/subscribe`），但**客户端不认**：codex 只实现了 resources 的
   * list / read / templates，subscribe 与 unsubscribe 都是 ❌，收到 updated 通知
   * 也只写一行日志不往上派发（`rmcp-client/src/logging_client_handler.rs` 的
   * `on_resource_updated` 整个函数体就一句 info!）。追踪 issue：openai/codex#16159。
   *
   * 也就是说现在做订阅只会得到一个没人订阅的服务端。等 #16159 落地，再把看板做成
   * 资源、把这里降级成兜底。在那之前，写入是人和 agent **唯一必然交汇**的时刻，
   * 所以把现场交还给它。
   *
   * 为什么值得多带这几个字段：人和 agent 同改一块看板时，「你写的被跳过了」只说明
   * 发生了冲突，说不清该怎么办。拿到现场值，agent 就能自己判断——用户只是改了时长，
   * 那就把自己那份提示词按新时长重写再发一次；用户把提示词整个换了，那就该停下来问，
   * 而不是把人家刚写的覆盖掉。
   *
   * 只在按卡 rev 冲突时出现，且只带规格字段（不含素材数组和产出），保持回包紧凑。
   */
  current?: {
    prompt: string
    model: string
    resolution: string
    ratio: string
    duration: number
    /** 现在的规格版本号；照抄进下一次 apply 的 `rev` 即可覆盖。 */
    rev: number
  }
}

export interface WorkbenchApplyResult {
  ok: boolean
  /**
   * 结构冲突:卡片集合/位置在导出之后变过,整份被拒,什么都没写。agent 该重新
   * export 再改。单张卡的规格冲突不在这里 —— 那是逐项 `skipped`,其余改动已生效。
   */
  conflict?: { expected: number; actual: number }
  boards: { created: string[]; renamed: string[]; removed: string[] }
  cards: {
    created: string[]
    updated: string[]
    /** 换了页或换了页内位置。 */
    moved: string[]
    removed: string[]
  }
  skipped: WorkbenchApplySkip[]
  /** apply 之后的新结构版本号(下一次 apply 该带这个)。 */
  structureRevision: number
}

/** `video-workbench:submit` IPC 载荷（渲染端 → 主进程）。 */
export interface VideoWorkbenchSubmitPayload {
  /** 渲染端生成的 clientId，贯穿广播做卡片对齐。 */
  clientId: string
  prompt: string
  model: SeedanceModelAlias
  resolution: '480p' | '720p' | '1080p'
  ratio: string
  duration: number
  generateAudio: boolean
  /** 首帧图（图生视频/首尾帧模式,渲染端按 mode 从参考图拆出）。 */
  firstFrame?: string
  /** 尾帧图（首尾帧模式）。 */
  lastFrame?: string
  /** 随机种子（缺省=上游随机）。 */
  seed?: number
  /** 联网搜索增强。 */
  webSearch?: boolean
  /**
   * 编辑 / 延长已有视频（仅 Seedance 2.5）。**由卡片的 `mode` 派生，不是新字段**：
   * `edit_video`/`extend_video` 这两个模式早就在工作台上了，只是从来没往上游发过
   * 这个参数 —— 也就是说 2.5 之前选「编辑视频」发出去的其实是一次普通生成。
   */
  taskMode?: SeedanceTaskMode
  referenceImages: string[]
  referenceVideos: string[]
  referenceAudios: string[]
  /**
   * 「默认上传人像库」开关的当前值（工具栏那个药丸）。只管**生成时兜底登记**
   * 参考图进人像库;上传素材本身不再顺带入库。关着时这次提交用到的参考图
   * 不会被登记。
   *
   * 随每次提交带过来而不是让主进程去查,是因为提交路径不该依赖「渲染端有没有
   * 推送过偏好」这个前置条件 —— 推送是给 agent 那条路(generate_video)用的镜像,
   * 见 runtime.ts 的 setAutoImportPortraitEnabled。缺省按开处理(与 UI 默认一致)。
   */
  autoImportPortrait?: boolean
}

/** `video-workbench:submit` 返回（成功 = 已创建上游任务，轮询在主进程后台跑）。 */
export type VideoWorkbenchSubmitResult =
  | { success: true; taskId: string }
  | { success: false; error: string }

/**
 * `video-workbench:reconcile` 单项载荷。重启后主进程任务表是空的，卡片把自己
 * 记住的 taskId 与重建任务状态所需的元数据送回去重新接管。
 */
export interface VideoWorkbenchReconcileItem {
  taskId: string
  clientId?: string
  prompt: string
  model: SeedanceModelAlias
  resolution: string
  ratio: string
  duration: number
  createdAt?: number
}

/**
 * 对账结果。`tracked` = 主进程仍在跟踪（没重启过，无需处理）；`adopted` = 已
 * 重新接管并恢复轮询；`unknown` = 上游查不到（过期/已删），卡片应落 failed。
 */
export interface VideoWorkbenchReconcileResult {
  taskId: string
  outcome: 'adopted' | 'tracked' | 'unknown'
  reason?: string
}
