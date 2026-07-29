# 视频工作台：重生不覆盖旧视频 + 版本切换

- 日期：2026-07-29
- 状态：已定稿，待实施
- 范围：四刀重构中的**第 3 刀**
- 前置：贯穿约定见 `2026-07-29-workbench-insert-card-design.md`「贯穿约定」一节

## 问题

点「↻ 重新生成」后，上一轮的视频从卡片上彻底消失，无法回看、无法对比。

根因在 `store.ts:1076-1103`：`startCards` 提交前会把 `taskId` / `videoUrl` / `localPath` /
`remoteUrl` / `actualSeed` / `completionTokens` / `historyRecorded` 全部置 `undefined` 并**立即落库**。
那段清空是**故意的**，且带注释保护——残留 `localPath` 会让播放器继续显示旧视频，残留
`historyRecorded` 会把第二轮及以后的结果永久挡在历史页之外。所以清空不能删，只能让结果在被清空
**之前**就已经存到别处。

好消息是**字节还在**：落盘文件名是 `seedance-<model>-<taskId 后 8 位>.mp4`，每轮 `taskId` 不同，
各轮互不覆盖；COS 的 `remoteUrl` 亦逐轮独立。丢的只是卡片上指回去的那根指针。

## 关键设计决定：在「成功那一刻」归档，而不是在「重生那一刻」

直觉做法是在 `startCards` 清空前把旧结果收进版本数组。**这是错的**：用户重生的典型动机就是改了提示词，
那一刻卡片上的规格已经是新的了，把它和旧视频存在一起会张冠李戴。

正确做法是在 `applyTaskUpdate` 判定成功的那一刻归档。此时卡片上的规格**必然**就是产出该视频的规格，
因为渲染中的卡片改不了——`store.ts:870` 对 `preparing` / `queued` / `running` 三态直接返回原卡，
注释写明「进行中的任务参数已定格提交」；IR apply 对在飞卡片的规格修改同样拒绝。

这么做还有两个附带好处：`startCards` 那段带注释的清空逻辑一行都不用动；即使用户从不重生，
版本记录也照样建立。

## 数据模型

`VideoWorkbenchCard` 新增 `versions?: VideoWorkbenchVersion[]`（追加序，末项 = 当前结果）。

```ts
interface VideoWorkbenchVersion {
  id: string            // 稳定 id，UI key 与 agent 引用用
  seq: number           // 卡内序号，从 1 起，只增不回收
  createdAt: number
  taskId?: string
  localPath?: string    // 快；但 7 天清理可能扫掉（见下）
  remoteUrl?: string    // 耐久源
  videoUrl?: string     // 上游临时地址，兜底
  actualSeed?: number
  completionTokens?: number
  spec: VideoWorkbenchVersionSpec  // 产出这一版时的意图
}

interface VideoWorkbenchVersionSpec {
  prompt: string
  model, resolution, ratio, duration, generateAudio, mode, seed?, webSearch
  /** 素材只记名字，不复制字节 */
  referenceBrief: { images: string[]; videos: string[]; audios: string[] }
}
```

**素材只存名字不存字节**是硬要求。`referenceImages` 等字段里是 `VideoWorkbenchMaterial`，可能携带
`data:` URL；逐版复制会迅速撑爆 IndexedDB——`WORKBENCH_MAX_CARDS = 200` 这个上限存在的唯一原因
就是防素材 `data:` URL 膨胀。只存名字后每条版本记录仅几百字节，因此**版本数不设上限**。

## 存活性

7 天清理（`AttachmentService.cleanup`）会扫掉工作台的 mp4：它判断「是否仍被引用」时只扫聊天记录
（`AgentMessage.items`），工作台卡片对它隐形。这不是本刀引入的问题，今天的卡片就已如此，而卡片
今天的应对是 `ResultVideoPlayer` 自动降级到 `remoteUrl`。

版本记录照抄该模式：**`localPath` 是快的，`remoteUrl` 是耐久的**，播放时按 localPath → remoteUrl →
videoUrl 逐级降级。COS 上传失败且本地被扫的版本会失去播放源，此时该版本置灰并注明原因，不静默消失。

## UI

**结果区的显示门要放宽。** 现在是 `card.status === 'succeeded' && hasResultVideo`，导致重生的那一两分钟
里结果区整个消失——这正是「重新生成不该隐藏之前的视频」所抱怨的。改为：只要
`hasResultVideo || versions.length > 0` 就渲染结果区，渲染中展示历史版本并标注「新版本生成中」。

**版本切换器**挂在播放器下方那条元信息 flex-wrap 行里（那里已经是一排 `text-[10px]` 小控件，
天然容得下）。形如 `◀ v2 / 3 ▶`。

**记法必须避开 `11-2`。** 美标剧本里 `47A` 已表示「第 47 场的 A 机位」，所以插入的场次要写 `A47`；
同理 `11-2` 会在「11 号卡的第 2 版」和「11 号后插入的第 2 张」之间二义。**版本一律记作 `v1`/`v2`**，
不与任何位置号拼接。

**切换只是预览。** 卡片的当前结果永远是最新那一版，切换不改变导出、复用、agent 看到的内容。
预览下标是组件本地 state，**不持久化**——它是易变 UI 状态，按贯穿约定不该落库。新版本到达时
自动跳到新版（那正是用户在等的东西）。

`ResultVideoPlayer` 的入参从 `card` 放宽为 `{ localPath?, remoteUrl?, videoUrl? }` 三元组；
其内部 helper 本来就是 `Pick<>` 形状，改动很小。

## MCP

`snapshotCard` 增加版本信息（版本数 + 精简列表）。`cardSnapshotSchema` 是 `z.looseObject`，
增字段不破坏输出校验。

**版本是结果，不是意图**，因此按 IR 既有教条：
- 只出现在 `WorkbenchIRCardResult`（导出侧只读注解），`apply` 一律忽略，绝不回灌。
- 必须排除在 `specEquals` / `pickSpec` 之外，否则「新视频到了」会被 IR diff 当成规格变更。
- 撤销/重做只还原意图与位置，**不得删除版本记录**。注意 `workbenchHistory.captureIntent` 是浅拷贝且
  与 store **共享卡片对象**，所以版本数组只能整体替换，不能原地 push，否则会污染历史快照。

## 明确不做

- 不动 `startCards` 的清空逻辑（有注释保护，且归档已提前到成功时刻）。
- 不设版本数上限（记录仅几百字节）。
- 不做「把旧版设为当前」——切换只预览。
- 不把版本写进全局历史页的分组（历史条目今天不带 `cardId`，改动面远超本刀）。

## 测试

- 成功一次 → 产生 v1，且其 spec 快照与产出时的卡片规格一致。
- 改提示词 → 重生 → 成功：v1 保留旧提示词，v2 记新提示词（**防张冠李戴的核心守卫**）。
- 重生进行中：结果区仍渲染，旧版本可播放。
- 版本记录不含素材字节，只含名字。
- 失败 / 取消的一轮不产生版本记录。
- localPath 缺失时降级到 remoteUrl；两者皆无时该版本置灰且不崩。
- 撤销不删除版本记录；`captureIntent` 快照不被后续版本追加污染。
- `specEquals` 忽略版本变化；IR apply 不回灌版本。
- 版本记法为 `v1`/`v2`，不与位置号拼接。

## 触及文件

- `src/types/videoWorkbench.ts`（版本类型 + IR 结果注解）
- `src/renderer/src/features/video-workbench/store.ts`（`applyTaskUpdate` 归档）
- `src/renderer/src/features/video-workbench/cardSpec.ts`（`specEquals`/`pickSpec` 排除）
- `src/renderer/src/features/video-workbench/workbenchIR.ts`（导出侧注解）
- `src/renderer/src/pages-react/video-workbench/WorkbenchCard.tsx`（结果区显示门）
- `src/renderer/src/pages-react/video-workbench/ResultVideoPlayer.tsx`（入参放宽）
- 新增版本切换器组件
- `src/main/mcp/tools/videoWorkbenchTools.ts`（快照 schema）
- 对应测试
