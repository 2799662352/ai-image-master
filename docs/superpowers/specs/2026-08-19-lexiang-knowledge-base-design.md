# 腾讯乐享知识库:给 agent 的项目知识层

> 状态:设计已确认,待写实施计划
> 日期:2026-08-19

## 要解决什么

短片创作里有五类东西需要跨镜头、跨会话保持一致:**剧本、提示词、人物小传、人物形象、
人物关系**。它们全部由 agent 在流水线里自动分析产出,而现在**没有任何一层留得住它们**。

盘点现状:

| 对象 | 现在在哪 | 持久化 |
|---|---|---|
| 剧本 / 分镜 | `storyboard-pipeline/schemas.ts` 的 zod(`SceneAnalysis` / `ShotSchema` / `ConsistencyReport`) | 流水线中间产物,落在工作区文件夹里 |
| 提示词 | `react-app/constants/templates.ts` + `public/data/prompts/*.md` | 静态文件,只读 |
| 人物形象 | 人像库(Seedance 上游素材 + 主进程叠加层) | 有,但权威在上游 |
| 人物小传 | 只以 `CharacterAnchorSchema.f` / `.motive` 字段散落 | **无独立实体** |
| 人物关系 | — | **完全不存在** |

Prisma 库里只有 `AgentThread` / `AgentMessage` / `AgentToolCall` / `AgentArtifact` /
`AgentAttachment` 五张会话表,**没有任何业务表**。

所以这件事的本质**不是「把已有数据同步到乐享」**——人物小传和人物关系压根还不存在。
是要给这五类对象第一次找一个家。

消费方是内嵌 Codex 的 agent,不是人在 UI 上点。所以交付物是**一组 MCP 工具**,不是同步面板。

## 为什么让乐享当权威存储

另一条路是「本地建 5 张 Prisma 业务表 + 同步到乐享」。否掉,理由是要为一个还不存在的
东西造两遍轮子:先从零设计本地表,再设计双向同步与冲突解决。

而乐享的 `Team → Space → Entry` 模型天然对得上需求形状:结构化文档 + 树形层级 + 自定义
属性 + 权限 + 全文检索 + 内建 AI 问答。用户要的「一个短片项目一个知识库,多个短片之上有
公司级项目知识库」正好落成「一个 Space 一个短片,同 Team 下另一个 Space 做公司级」。

代价是本地失去离线可用性,以及所有读写都要过网络。接受:这批数据是**低频写、跨会话读**
的设定类内容,不在出图/出片的热路径上。

## 乐享侧的事实

来源:官方接口文档(`lexiang.tencent.com/wiki/api/`)与官方 skill 仓库
(`github.com/tencent-lexiang/lexiang-openapi-skill`)。

### 基础

```
层级      Team → Space(知识库) → Entry(page / folder / file,树形,parent_id,root_entry_id)
鉴权      POST https://lxapi.lexiangla.com/cgi-bin/token
          body {grant_type:"client_credentials", app_key, app_secret}
          → {token_type:"Bearer", expires_in:7200, access_token}
          有效期 2 小时,**取 token 限流 20 次/10 分钟**,必须缓存
请求头    Authorization: Bearer <token>
          Content-Type: application/json; charset=utf-8
          x-staff-id: <staff_id>   ← 所有写操作 + AI 搜索/问答都要
限流      业务接口普遍 3000 次/分钟
```

凭证是**三件套**:`AppKey` + `AppSecret` + `StaffId`。少一个写不了。

### 三条会咬人的硬约束

**一、`POST blocks/descendant` 是追加语义,不是覆盖。**

官方 skill 仓库记录了自己踩的坑:更新已有文档没先清空,内容累积到 4 倍(580 个块,正常
约 147 个)。他们总结的教训原话:

> 对远程 API 的操作必须是幂等的。写入内容前,如果不是追加模式,必须先确认目标是否为空
> ——不能假设 API 会自动覆盖。

我们的 `upsert_character` 会被 agent 反复调用,这是必然踩的坑。清空的正确做法:
`GET blocks/children` → 注意返回结构是 `data.blocks` 而非 `data`、块 ID 字段是
`block_id` 而非 `id` → 并行 DELETE。

**二、`descendant` 的 payload 顶层不能传 `children`。**

顶层 `children` 的真实语义是「指定页面根节点的第一级子块」,会把声明的块提升到页面开头,
打乱 `descendant` 数组顺序。嵌套关系只在块自身用 `block_id` + `children` 声明。

**三、`block_type` 不含 `quote`。**

Markdown 引用块要转成 `callout` 模拟。

### 一处必须纠正的二手信息

官方 skill 仓库的 `SKILL.md` 写着「**image 块不支持通过 API 创建**」。**这是错的。**

误读来源是接口文档里一份「以下块类型**不支持设置 `children` 字段**」的清单,里面列了
`h1`-`h5`、`code`、`image`/`attachment`/`video`、`divider`/`mermaid`/`plantuml`。那是
「不能有子块」,不是「不能创建」。

官方文档明确给出图片写入的三步流程:

```
1. POST /cgi-bin/v1/kb/page/entries/{entry_id}/blocks/files/apply-upload
   header 需 x-staff-id;body {name, size, mime_type}
   → {session_id, upload_url}
2. PUT {upload_url} --data-binary @file
   预签名地址已含鉴权,不需要我们签 COS。200 + ETag 即成功
3. POST .../blocks/descendant
   {"index":-1,"descendant":[{"block_type":"image","image":{"session_id":"..."}}]}
```

注意上传凭证是**按条目申请**的(路径里带 `entry_id`),所以顺序必须是先建 page 条目、
再往里传图。

**纪律**:本文档中凡涉及乐享行为的结论,以官方接口文档为准;社区 skill 只用作踩坑线索,
不作为接口事实来源。

### 乐享不是向量库

对照本仓库已有的运镜知识库(`resources/cinematography-kb-mcp/index.js`),两者性质完全不同:

| | 运镜知识库 | 乐享 |
|---|---|---|
| 性质 | 向量 RAG | 文档型知识库 |
| 检索 | DashScope `text-embedding-v4` 编码 512 维 → DashVector `POST /api/v1/indices/knowledge/search` | 关键词 + 自定义属性筛选 |
| 语义相似 | 有 | **无**(够不到它的向量层) |
| 内建问答 | 无 | 有(`/v1/ai/search`、`/v1/ai/qa`,后者支持 `research:true`) |

结论:**别指望乐享做语义相似检索**。「找个气质像这角色的」这类查询关键词检索打不中。
但它自带 RAG,通过 `ask_knowledge` 借用即可,不用自己搭 embedding 管线。这也决定了
`search_knowledge`(精确/结构化/快)与 `ask_knowledge`(模糊/语义/慢)是**互补的两个
工具**,工具描述里必须把分工写清,否则 agent 会无脑只用其中一个。

## 接入方式选型

### 走 REST OpenAPI,不走官方 MCP

乐享官方推荐 MCP 接入,但那条路的会话密钥**最长 14 天过期**(`lexiangla.com/mcp` 创建会话
生成密钥对)。桌面端每两周要求用户回后台重新生成一次,不可接受。AppKey/AppSecret 是长期
凭证,access_token 两小时我们在主进程缓存续期即可。

第二个理由是语义:官方 MCP 提供的是通用知识库读写工具,不懂「人物小传」「人物关系」。
我们要把领域概念直接做成工具名,让 agent 一眼知道调哪个。

### 并进 catimation 桥,不做独立 MCP server

本仓库两种模式都有成例:

- **独立 server**:`apiyi-mcp`、`cinematography-kb-mcp`。codex spawn 一个 vendored
  `index.js`,密钥在 spawn 时用 `-c mcp_servers.<name>.env.KEY=...` 覆盖注入。
- **进桥**:`src/main/mcp/tools/*.ts`,进程内,经 `ToolRouter` 派发。

选进桥。决定性理由是**我们的工具需要 app 内部状态**:`attach_character_image` 要解析
`asset://assetId`(人像库的东西)、所有工具都要读工作区的 `projectId` 绑定、取图片字节要
复用现成的 COS/STS 层。独立 server 是外部进程,这些全拿不到,只能退化成「让用户手动传
文件路径」。运镜知识库能走独立 server,是因为它是纯外部检索、不碰 app 状态。

### 调用链

```
codex 子进程
  ↑ -c mcp_servers.catimation      (spawn 时注入,端口/token 随会话动态生成)
  ├─ stdio(首选): codex spawn resources/catimation-bridge/index.js
  │                → bridge 把字节经 loopback TCP 转给 Electron 主进程
  └─ HTTP(回退) : url + x-catimation-token → 进程内 Express listener
       ↓
  server.registerTool 的 handler
       ↓
  router.call(name, params, codexThreadId)
       ├─ registerMain 注册 → 主进程直接执行        ← 知识库工具全走这条
       └─ 否则派发 renderer(IPC,2000s 超时)
```

知识库工具都是「主进程发 HTTPS 给乐享」,不需要渲染层,所以一律 `router.registerMain`。
不走 IPC,不受那个 2000s 超时和窗口关闭影响。

HTTP 客户端用主进程全局 `fetch`(Electron 28+ 有)。**不**照抄 `cinematography-kb-mcp`
的原生 `node:https`——那是因为 vendored server 要求零依赖,进程内没这个约束,两种风格
混用只会让人困惑。

## 数据模型映射

### 目录树 + 自定义属性,两者都要

三个候选:

- **纯目录树**:人看着清楚,但 agent 每次定位要走 parent 链,多几次请求。
- **纯扁平 + 属性筛选**:agent 检索快,但乐享网页端打开是一堆平铺文档,人没法用。
- **两者都要**(采纳):目录树给人,属性给 agent。

采纳第三个,因为这个知识库的读者本来就是两类:agent 要精确检索,人要在乐享网页上审剧本、
看人设。只做扁平的话,「多个短片组成公司项目知识库」这个诉求对人就废了。代价是每个条目
多一次属性写入。

### Space 结构

```
Space = 一个短片项目
├── _项目元数据          (page,存 projectId / 项目名 / 创建时间 / 租约)
├── 剧本/               (folder)
│   └── 剧本            (page,整篇一份,整体重写)
├── 人物/               (folder)
│   ├── 张三            (page:正文区=小传+关系表;形象区=image 块)
│   └── 李四            (page)
├── 分镜/               (folder)
│   └── 分镜总表        (page,一份,**不逐镜建条目**)
└── 提示词/             (folder)
    └── <模板名>        (page)

公司级 Space = 同 Team 下另一个 Space,结构同上,只收「已采用」的内容
```

创建条目走 JSON:API 规范,用 `relationships` 指定 Space 与父节点:

```json
{"data":{"type":"kb_entry",
  "attributes":{"entry_type":"page","name":"张三"},
  "relationships":{
    "space":{"data":{"type":"kb_space","id":"SPACE_ID"}},
    "parent_entry":{"data":{"type":"kb_entry","id":"PARENT_ID"}}}}}
```

注意:`entry_type` 的文件夹值是 `folder`(不是 `directory`);`file` 类型的 `name` 必须
带后缀,且创建后无法通过 API 重命名。

### 人物关系存在人物页里,不单独建条目

关系写成人物小传正文里的一个小节(`对方 | 关系类型 | 一句话`)。理由:agent 取人物时一次
拿全,不用二次查询;关系是双向的,拆成独立条目就要维护两边一致性,而这批数据由 agent
自动分析、本来就会整体重写。

### 自定义属性

| 属性 | 取值 | 用途 |
|---|---|---|
| 类型 | 人物 / 剧本 / 分镜 / 提示词 / 元数据 | agent 按类型筛选检索 |
| 状态 | 草稿 / 已采用 / 已废弃 | 见下节状态机 |

**前置条件**:属性和选项必须先在乐享后台建好。属性设置接口只认选项的**显示文本**——传
选项 key 会静默返回 200 但值为空(官方踩过)。请求体必须是 JSON:API 格式:
`{"data":{"type":"kb_entry","attributes":{"<属性ID>":{"value":["<选项显示文本>"]}}}}`。
初始化流程要包含「检查/引导创建这两个属性」。

## 项目身份与绑定

### projectId 是身份,路径不是

绝不能拿路径当身份。项目会移动到别的文件夹、换盘符;局域网下同一份文件通过 UNC
(`\\nas\share\proj`)和映射盘(`Z:\proj`)访问路径字符串不同,不同机器映射的盘符还不一样。
路径变了不代表项目变了,路径一样也不代表是同一份。

所以:**`projectId`(建库时生成的 UUID)是身份,路径降级为「上次见到的位置」,只用于显示,
不参与任何判断。**

### 三层绑定,互为备份

| 层 | 位置 | 内容 | 救什么 |
|---|---|---|---|
| 1 | electron-store | `绝对路径 → {projectId, spaceId, teamId}` | 用户删了 `.catimation/` 但文件夹还在 |
| 2 | `<工作区>/.catimation/knowledge.json` | 同上 + 绑定时的原始路径 | 换机器、换人接手、整个文件夹拷走 |
| 3 | 乐享 `_项目元数据` 条目 | `projectId` / 项目名 / 创建时间 | 前两层全丢,人工认领 |

**关键前提:绑定丢了,数据不丢。** 内容全在乐享 Space 里,工作区文件夹只有工程文件和绑定
文件。删文件夹丢的是「这个目录对应哪个知识库」这条线索,不是内容。所以绑定是可重建的
快捷方式,不是单点。

失效场景与表现:

| 发生了什么 | 结果 |
|---|---|
| 删 `.catimation/`,文件夹还在 | 层 1 自动恢复,用户无感 |
| 整个文件夹删了,之后新建同名项目 | 提示「乐享里有同名知识库,关联还是新建」 |
| 换机器 / 拷项目给同事 | 层 2 续上,直接可用 |
| 三层全丢 | `list spaces` 人工认领,数据完好 |
| 乐享后台删了 Space | 工具返回 404 → 降级为明确提示「知识库已不存在,需重建或关联」,不是一堆 500 |

### 局域网共享是正常场景,不是冲突

两个人打开同一个网络工作区,读到同一份 `knowledge.json`、同一个 `projectId`、同一个
Space——**这是对的**。同一个项目本来就该共用一个知识库,这正是「一短片一库」的意义。
这里不拦。

真正要防的是**两个 agent 同时往同一个知识库写**。见下节。

## 并发与幂等

### 活跃租约

每次写入在 `_项目元数据` 条目里记 `instanceId`(每台 app 安装一个 UUID)+ 时间戳。写之前
看一眼,**5 分钟**内有别的 `instanceId` 动过这个 Space,就提示「另一台机器正在使用」。

5 分钟是权衡:这批数据是低频写,同一个人连续两次写入通常在几十秒内,而两个人真的在协作时
间隔也远小于 5 分钟。取太短会漏报,取太长会在同事下班后仍然误报。租约只提示、不阻断——
误报一次拦住正常工作,比偶尔撞一次车更烦。

这个机制同时覆盖两种情况——局域网多人、文件夹被复制成两份——因为它测的是**并发**,而不是
猜位置。复制出来的副本带同一个 `projectId`,不同时用就无害;同时用了租约会报出来。想彻底
分家就显式「新建知识库」,重新分配 `projectId`。

### 图文分区:形象区永不被清空

前面定的「幂等 = 清空重写」会把图片一起清掉。人物形象已内嵌为 image 块,每次改一句小传就
要重传一遍图,既浪费又会在乐享侧堆孤儿上传。

三个解法:

- **按块类型跳过 image/attachment/video**:实现简单,但重写后图文相对顺序会乱。
- **内容哈希短路**:省掉无谓写入,但真要改时图片还是会被清掉。
- **图文分区**(采纳):人物页固定两段——正文区(小传 + 关系表,全量清空重写)+ 形象区
  (image 块,只增不删,由 `attach_character_image` 单独管理)。`upsert_character` 只碰
  正文区,永不动图片。**再叠加哈希短路做二次保险。**

采纳第三个,理由是它在存储层就把「频繁变的文本」和「几乎不变的二进制」分开了:agent 每轮
分析都可能重写小传,人物形象定妆后基本不动,两者混在一个清空周期里本身就是错配。代价是
多一个工具,且页面结构靠约定维持——工具必须能容错重建(有人在网页上手动打乱了结构时)。

### 丢更新

乐享块接口**没有版本号或 ETag 这类乐观锁字段**(已核对官方文档)。所以租约只能减少撞车,
不能从协议层杜绝丢更新。缓解:`upsert_character` 写前取正文哈希、写后回读校验,不一致则
报冲突让 agent 重试。这条作为已知限制记录在案,撞车频繁再上更重的方案。

## 状态机与作废

用户对结果不满意会删掉本地工程重做。如果乐享里那版被否掉的人设、剧本还在,agent 下一轮
`search_knowledge` 又会把它捞出来当既有设定复用——**被枪毙的东西阴魂不散,而且越检索越
像是团队沉淀**。这比没有知识库更糟。

两条边界:

1. **本地删工程绝不连带删乐享知识库。** 本地目录是随手清理的东西,知识库是团队资产。
2. **但被否掉的内容必须能作废**,否则第一条会反噬。

状态机:`草稿 → 已采用 | 已废弃`。

- agent 自主写入,**一律先落 `草稿`**(代码层保证,不依赖 agent 自觉)。
- `已采用` 由用户显式认可,一次性批量,不逐条点。
- `search_knowledge` **默认只返回未废弃的**,要看历史得显式要求。
- **写入默认只落本项目库**(`scope:'project'`)。公司库是跨项目复用层,让 agent 随手往里
  写会很快污染掉;**且只收 `已采用` 的**,提升到公司库必须是显式动作。

重做分两种形态:

- **局部重做**(这版人设不行):旧条目标 `已废弃`,写新的。历史留痕。这是常态。
- **整体推倒**(方向全错):整个 Space 归档(改名加 `[已归档]` 前缀 + 标废),新建 Space
  并分配新 `projectId`。**是归档不是删。** 真要删走乐享后台人工删,app 不提供——这类
  不可逆操作交给 agent 或一个按钮太危险。

衍生问题要在工具描述里写明:**用户删了本地剧本文件,agent 仍能从乐享捞回来。** 逻辑上对
(乐享是权威,本地只是副本),但违反用户直觉。工具描述要让 agent 能讲清楚:要真的让它消失
得走作废,不是删本地文件。

## 入库策略:什么上,什么不上

这是决定成败的一条。写多了知识库变流水账、检索质量崩;写少了就是空壳。它主要不是代码
问题,是策略写在哪、怎么让 agent 照做。

### 判据是「会被复用吗」,不是「重要吗」

重要性是陷阱:分镜对这个片子极重要,对下一个片子毫无价值。

| 对象 | 上不上 | 理由 |
|---|---|---|
| 人物(小传/形象/关系) | **上** | 跨镜头保持一致正是它存在的理由。只上确认要用的角色,brainstorm 阶段的候选不上 |
| 剧本 | **上,整篇一份** | 一个项目一份,整体重写 |
| 分镜 | **不逐镜上,只上总表一份** | 一个短片几十上百镜,逐镜入库就是流水账,会把真正有复用价值的人物设定淹掉 |
| 提示词 | **只上验证有效、明确想复用的** | 每轮生成的即时提示词不上 |
| 生成的图/视频 | **不上** | 它们在人像库和本地。只有被选为定妆图的形象才进人物页 |

分镜那条最容易做错,也最需要拦:量最大、复用价值最低,一放开检索质量立刻崩。

### 强制先读后写

比任何清单都收敛得快的一条:`upsert_character` 之前必须先 `search_knowledge`,已有该角色
就更新、不新建。泛滥主要不来自「写了不该写的」,而来自「同一个角色被反复新建成七八份」。

### 策略写在三处

- **`serverInstructions.ts`**:跨工具的全局约束——写前先搜、什么进库什么不进的分类表。
  这正是该文件的职责(它的注释:「只装工具描述装不下的东西:跨工具的选择关系、并发安全
  边界、全局约束」)。**注意前 512 字符必须自包含**,codex 可能只看得到开头。
- **各工具 `description`**:自己的门槛。MCP 官方把「重复 tool description」列为头号反
  模式,所以不要在 serverInstructions 里重复单工具细节。
- **代码层**:状态默认 `草稿`,兜底,不依赖 agent 自觉。

值得写的证据:`serverInstructions.ts` 注释记录了官方 40 会话对照实验——GPT-5-Mini 走对
多步工作流的比例 20% → 80%,Claude Sonnet-4 本来就 90–100%。**codex 走的正是差的那一档**
(还有自建网关挂 Qwen/Grok),所以这段指令的收益远大于「我们自己试着还行」的直觉。

## 工具面

十个工具,`src/main/mcp/tools/knowledgeTools.ts`,骨架照 `portraitTools.ts`。

| 工具 | annotations | 职责 |
|---|---|---|
| `search_knowledge` | `READ_ONLY_REMOTE` | 关键词 + 类型/状态属性筛选。**读默认 `scope:'both'`**(本项目库 + 公司库),默认排除已废弃 |
| `ask_knowledge` | `READ_ONLY_REMOTE` | 走乐享 `/v1/ai/qa`,模糊/语义问题。慢,支持 research 模式 |
| `get_character` | `READ_ONLY_REMOTE` | 小传 + 形象引用 + 关系,一次拿全 |
| `upsert_character` | `WRITE_ADDITIVE_REMOTE` | 只重写正文区。幂等(哈希短路 + 清空重写),永不动形象区 |
| `attach_character_image` | `WRITE_ADDITIVE_REMOTE` | 形象区加图:apply-upload → PUT → image 块 |
| `get_script` | `READ_ONLY_REMOTE` | 取剧本 |
| `upsert_script` | `WRITE_ADDITIVE_REMOTE` | 整篇重写,不追加 |
| `list_prompts` | `READ_ONLY_REMOTE` | 取沉淀的提示词模板 |
| `link_project_knowledge` | `WRITE_ADDITIVE_REMOTE` | 把当前工作区关联到一个 Space:新建、或认领已有(三层绑定全丢时的恢复入口) |
| `deprecate_knowledge` | `DESTRUCTIVE` | 标废(人物/剧本/整库) |
| `archive_project_knowledge` | `DESTRUCTIVE` | 整体推倒:归档旧 Space + 新建 |

`link_project_knowledge` 是**所有写工具的前置**:没有绑定时其余工具一律返回
`{ok:false, error:'NOT_LINKED'}` 并在人类摘要行提示先调它,而不是静默新建一个 Space
——自动建库会在绑定丢失时悄悄产生重复知识库,那正是我们要防的。它有三种模式:

- `mode:'create'` — 新建 Space,生成新 `projectId`,写入三层绑定
- `mode:'claim'` — 认领已有 Space(传 `spaceId` 或 `projectId`),重建三层绑定
- `mode:'auto'`(默认)— 先按 `projectId` 精确匹配,再按项目名模糊匹配;命中就返回候选
  让 agent 或用户确认,**不自动认领**;无命中才提示可以 `create`

`attach_character_image` 的 `source` 沿用人像库工具的约定:**本地路径 / `data:` URL /
https URL / `asset://assetId`**。agent 可以直接把人像库已有的 `asset://` 丢进来,不用先
下载到本地。我们 COS 是源,乐享是团队可见的归档副本,职责清楚。

**注意两个 COS 别混**:乐享 `apply-upload` 返回的 `upload_url` 是**乐享自己桶的预签名
地址**,已含签名,不需要我们提供任何 COS 凭证。跟 `src/main/services/tencent/` 那套
(SCF 换 30 分钟 STS 短期票 → `image-history/*`)完全无关。

### 返回格式

MCP 协议层是 `{ content: [{ type: 'text', text }] }`。本仓库在 `text` 里有固定约定:
**第一行人类摘要,最后一行 machine-readable JSON**。

```ts
router.registerMain('search_knowledge', async (params) => { /* 调乐享 */ })

server.registerTool('search_knowledge', {
  description: '...(写清何时该用、返回什么、怎么翻页、与 ask_knowledge 的分工)',
  annotations: READ_ONLY_REMOTE,
  inputSchema: z.object({
    query: z.string().optional(),
    type: z.enum(['character', 'script', 'shotlist', 'prompt', 'all']).optional(),
    scope: z.enum(['project', 'company', 'both']).optional(),
    page: z.number().int().min(1).optional(),
  }),
}, async (params) => {
  const res = await router.call('search_knowledge', params) as SearchResult
  return textResult([
    `📚 命中 ${res.items.length}/${res.total} 条(第 ${res.page}/${res.totalPages} 页)`
      + `${res.hasMore ? `,翻页用 page:${res.page + 1}` : ''}`,
    JSON.stringify({ ok: true, total: res.total, page: res.page,
                     hasMore: res.hasMore, items: res.items.map(lean) }),
  ].join('\n'))
})
```

失败**不抛异常**,走同一通道返回 `❌ ...` + `{ ok: false, error }`,让模型能读懂并自己
决定重试还是改参数。凭证缺失要给出可操作提示(指向设置页),照 `portraitTools.errorBanner`
对 `SEEDANCE_KEY_MISSING` 的处理。

### 两条必须遵守的既有纪律

**~10k token 静默截断。** `search_knowledge` 只回精简字段(id / 名字 / 类型 / 状态 /
一句话摘要),全文再按 id 取 `get_character`。`portraitTools.leanItem` 的注释说得直白:
冗余字段会把真正的结果挤出去。分页要在摘要行里给出下一页页码。

**上线后核对工具名。** `ToolRouter.call` 里那行
`console.log('[ToolRouter] incoming tool call: ...')` 记录 codex 实际派发的原始名。历史上
`ask_user` 被改写过(`askuser` / `catimationaskuser` 等别名),新工具上线要看一眼日志确认
名字没被改写。

## 凭证与安全

三件套(`AppKey` / `AppSecret` / `StaffId`)存 provider store,spawn 时注入,**不进 git、
不写 `~/.codex/config.toml`**——照 apiyi-mcp 与运镜知识库的现成模型。设置页新增「乐享
知识库」一节填写。

直接适用的教训来自 `cinematographyKbMcpLauncher.ts` 的注释:`DASHSCOPE_API_KEY` 曾硬编码
进 app 和 git,后来撤掉,理由是**该 key 不限定于某一个知识库,能调那个账号下任意 DashScope
API,进源码就是泄漏风险**。

乐享这边情况稍好:AppKey 的能力由后台配置的**接口权限**与**知识授权范围**两道闸限住,
天然收窄。但 AppSecret 同样不能落 git。

Base URL 做成可配,默认 `https://lxapi.lexiangla.com`,私有化部署改配置即可。

access_token 在主进程内存缓存 + 提前刷新(留足余量,别踩 20 次/10 分钟的取 token 限流)。
并发取 token 要做 in-flight 合流,避免一次冷启动打出多发请求——`stsCredentials.ts` 里已有
同形状的实现可参照。

### 初始化流程要引导的后台配置

1. 管理后台【开发】→【接口凭证管理】添加凭证,拿 AppKey / AppSecret
2. 给 AppKey 勾接口权限:至少「知识节点」「在线文档块」「AI」三类
3. 设 AppKey 的知识授权范围(绑定团队)
4. 在乐享后台创建「类型」「状态」两个自定义属性及其选项

## 已知限制

1. **无乐观锁**:乐享块接口没有版本号/ETag,租约 + 回读校验只能减少撞车,不能杜绝丢更新。
2. **无语义检索**:乐享不是向量库。模糊查询只能退到 `ask_knowledge`(慢)。
3. **无原生 move/copy**:跨库迁移要手动遍历 + 重建 + 逐个下载上传。本期不做迁移功能。
4. **离线不可用**:全部读写过网络。
5. **`file` 条目创建后无法改名**:PATCH 重命名对 file 类型返回 404,上传时就要用对文件名。
6. **属性依赖后台预建**:属性和选项不能通过 API 凭空创建,初始化要引导。

## 测试策略

照 `src/main/mcp/tools/__tests__/` 的现成写法,vitest。

- **乐享 HTTP 层**:mock `fetch`,覆盖 token 缓存/过期/限流退避、401 重取、404 降级。
- **幂等**:`upsert_character` 连调两次,断言乐享侧块数不翻倍(这是官方踩过的坑,必须有
  回归测试钉住)。
- **图文分区**:`upsert_character` 后断言 image 块仍在、`block_id` 未变。
- **状态过滤**:`search_knowledge` 默认不返回 `已废弃`。
- **绑定恢复**:三层各自失效的恢复路径,含路径变化不触发误判。
- **租约**:另一个 `instanceId` 活跃时给出提示。
- **返回格式**:末行是合法 JSON 且含 `ok` 字段;失败路径不抛异常。

## 不做的事(YAGNI)

- 不建本地业务表,不做双向同步。
- 不做知识库迁移/跨库复制。
- 不做删除 Space 的能力(只归档,真删走乐享后台)。
- 不自建 embedding / 向量检索(乐享自带 AI 问答够用)。
- 不做同步状态 UI 面板(消费方是 agent,不是人)。
- 不逐镜入库分镜。
