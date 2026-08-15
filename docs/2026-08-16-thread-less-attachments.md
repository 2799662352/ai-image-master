# 无会话附件：假 threadId 与外键冲突

调查日期：2026-08-16。**本文只描述现状，未改动任何代码。**

## 一句话

工作台生成的视频、以及 `download_portrait_asset` 存下的素材，不属于任何聊天会话，但数据库要求每条附件记录必须挂在一个会话上。代码用一个写死的假会话 id `'seedance'` 去满足这个约束，而那行会话记录从来没有被创建过 —— 于是每次插入都撞外键，**文件正常落盘，元数据行一条都没有**。

## 触发链

`AgentAttachment.threadId` 是 `NOT NULL` 且带外键到 `AgentThread`：

```76:85:prisma/schema.prisma
model AgentAttachment {
  id           String      @id @default(cuid())
  threadId     String
  originalName String
  localPath    String
  mime         String
  size         Int
  uploadedAt   DateTime    @default(now())
  thread       AgentThread @relation(fields: [threadId], references: [id], onDelete: Cascade)
}
```

而无会话的调用方传的是这个常量：

```73:74:src/main/services/seedance/runtime.ts
/** 无 threadId 的任务(手动 MCP 调用等)落到这个伪线程目录。 */
const FALLBACK_THREAD_ID = 'seedance'
```

两条路会用到它。一条是工作台视频：`persistVideo` 落盘时取 `task.threadId ?? deps.fallbackThreadId`，而工作台提交时压根不传 threadId（`runtime.ts:612-617` 的 `taskManager.submit` 参数里没有这个字段）。另一条是 `download_portrait_asset`，直接写死：

```772:775:src/main/services/seedance/runtime.ts
      try {
        const [saved] = await attachments.ingest(FALLBACK_THREAD_ID, [
          { name, mime, size: written, path: tmpPath },
        ])
```

插入必然失败，报 `Foreign key constraint violated on the constraint: AgentAttachment_threadId_fkey`。`AttachmentService` 对这种失败是**刻意宽容**的 —— 字节已经按内容哈希落在盘上了，为一条元数据丢掉用户的文件是更坏的选择：

```189:203:src/main/agent/AttachmentService.ts
    } catch (dbErr) {
      const message = dbErr instanceof Error ? dbErr.message : String(dbErr)
      console.warn(
        `[AttachmentService] metadata insert failed for ${attachment.name}; returning on-disk path without a DB row (file is safe at ${finalPath}): ${message}`,
      )
      return {
        id: `nodb_${sha}`,
        threadId,
        originalName: attachment.name,
        localPath: finalPath,
        mime: attachment.mime,
        size: declaredSize,
        uploadedAt: new Date(),
      }
    }
```

所以调用方拿到的 `localPath` 是真的，播放、转存、ffmpeg 全都正常。**这个缺陷不涉及数据丢失。**

## 影响范围

不是 WAN3 引入的。`FALLBACK_THREAD_ID` 进来于 `e4c1b142`（2026-06-13），比万相接入早两个月，Seedance 2.0 / 2.5 / WAN3 走的是同一条工作台路径，行为完全一致。WAN3 只是在测试期间让人注意到了日志里的这行 warning。

从**聊天**里发起的 `generate_video` 不受影响 —— 那条路有真实 threadId：

```508:524:src/main/services/seedance/runtime.ts
  router.registerMain('generate_video', async (params, threadId) => {
```

## 可观察到的两个症状

**一、附件面板显示成哈希文件名。** 面板是「扫盘 + 用数据库行做左连接」，配不上行的文件退化成裸文件名，没有体积和类型，并且排在所有有行的文件之后：

```48:56:src/main/file-explorer/AttachmentTreeProvider.ts
    } else {
      result.push({
        path: full,
        name: filename,
        kind: 'file',
        source: 'attachments',
        childrenLoaded: false,
      })
    }
```

于是一段成片在面板里长这样：`628785d5…ea853.mp4`。

**二、每次生成一行 warning。** 就是上面那条 `metadata insert failed`。除了噪音没有别的后果。

## 一个反直觉的后果：这些文件因此永远不会被清扫

`cleanup()` 是「照着数据库行走」的 —— 先查出过期的行，再删对应文件（`AttachmentService.ts:206-239`）。没有行的文件它根本看不见，从落盘第一天起就脱离了 7 天清扫。

本机实测（2026-08-16，`%APPDATA%\catimation-cyberpunk-master\agent\uploads`）：

| 类型 | 文件数 | 体积 |
|---|---:|---:|
| .mp4 | 181 | 695.2 MB |
| .png | 186 | 450.5 MB |
| .jpg | 21 | 46.6 MB |
| 其余（wav/webp/gif/md/jpeg） | 32 | 9.3 MB |
| **合计** | **420** | **1.17 GB** |

这里面混着两类：聊天里发出去的图和视频有行、走正常清扫；工作台产出和人像素材没有行、永久留存。后者是用户的成品，**永久留存是期望行为，不是泄漏**。

## 为什么「补上外键」的修法有风险

直觉修法是把 `threadId` 改成可空、给这些附件补上行。但补上行的同时就把它们**交给了清扫**，而清扫判断「还有人引用吗」只扫聊天消息：

```258:261:src/main/agent/AttachmentService.ts
  private async loadMessageReferenceHaystack(): Promise<string | null> {
    try {
      const messages = await this.prisma.agentMessage.findMany({ select: { items: true } })
      return normalizePathForMatch(messages.map((m) => JSON.stringify(m.items)).join('\n'))
```

工作台卡片不是聊天消息。它们连同 `localPath` 存在渲染进程的 IndexedDB 里，主进程这段扫描看不见。因此补行之后，7 天一到，清扫会判定这些视频「过期且无人引用」并删除文件，而卡片还指着那个路径。COS 远程副本能兜一部分（上传允许失败），上游任务号重下也有有效期。

**结论：现在这个坏掉的外键，恰好是这些成片还活着的原因。任何修法的第一条约束是不能打开清扫。**

## 备选方案（未实施）

**A. 最小改动** —— 无会话时不再编造假 id，直接跳过写行。消除日志噪音，代码语义变诚实，面板显示不变（仍是哈希名），文件行为不变。

**B. 可空 + 补行 + 清扫豁免** —— `threadId` 允许为空，补上行让面板显示正确的文件名与体积；同时在 `cleanup()` 里过滤掉无会话的行，并注明原因（主进程没有工作台引用信息，判定不了"没人用"，所以不判定）。文件一个不动。需要动 `schema.prisma`、`ensureSchema` 的建表 SQL 与老库迁移（老库是带 `NOT NULL` 建出来的，热更新那一次开机必须卸掉约束）、`cleanup()` 一条过滤，以及删掉 `FALLBACK_THREAD_ID`。

**C. 完整版** —— 在 B 之上让工作台把它引用的路径上报给主进程，恢复真正的垃圾回收。需要新增一条引用来源，改动最大。

## 当前决定

不改。现状不丢数据，两个症状都是外观层面的；而最容易想到的修法会把一个无害的堆积变成七天后的静默删除。若日后要做，B 是风险最低的一版。

## 相关位置

- `src/main/agent/AttachmentService.ts` —— `ingestOne` 的插入与降级、`cleanup` 的清扫与引用扫描
- `src/main/file-explorer/AttachmentTreeProvider.ts` —— 面板的扫盘 + 左连接
- `src/main/services/seedance/runtime.ts` —— `FALLBACK_THREAD_ID` 定义与两处用法
- `src/main/services/seedance/persistVideo.ts` —— 工作台视频落盘时的 `task.threadId ?? fallbackThreadId`
- `prisma/schema.prisma` / `src/main/agent/ensureSchema.ts` —— 约束定义与建表 SQL
