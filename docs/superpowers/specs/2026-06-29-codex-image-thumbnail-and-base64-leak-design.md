# Codex 生成图:缩略图 + base64 内存泄漏修复 — 设计

- **Date**: 2026-06-29
- **Status**: Approved
- **Scope（用户收敛)**:只做两件事 ——(1)完善缩略图,(2)解决 base64 内存泄漏。**不做**:崩溃遥测、并发闸门、`content-visibility`、GPU 看门狗(均记为后续)。

## 问题(已坐实)

`AgentToolExecutor.toArtifacts()` 给每个聊天气泡 artifact 写 `uri = data:<全尺寸 base64>` 且 **不写 `thumbnailUri`**:

1. **缩略图**:`ArtifactCard` 渲染 `MediaThumbnail src={ref.thumbnailUri ?? ref.uri}` → 回落到全尺寸 base64 → 在 80×80 框里解码 4000×3000≈48MB RGBA。
2. **内存泄漏(活会话)**:`persistArtifacts` 落盘 + 入 history/COS 后,气泡 artifact 的 `uri` **从不换源** —— `annotateImageGeneration` 只更新 save 横幅。多 MB base64 整会话常驻 store(并序列化进线程状态)。

收尾证据:**重载后自愈** —— `codexArtifactPersistence.mergeCodexArtifacts`/`resolveAnchorUrls` 重建气泡用的是 history 的 COS/R2 URL(过滤 `pending:*`)、兜底本地 `paths` 的 `file://`,**从不碰 base64**。所以修法 = 让活会话在保存落定后收敛到重载已经在用的轻量表示。

## 设计(一个核心动作 + 一处集中缩略图)

### 1. 保存落定后换源、丢 base64(治泄漏 + 本地缩略图)

- 新增 store action `replaceImageArtifacts(itemId, artifacts, threadId)`(仿 `resolveImageGeneration`,保留 `status:'done'` 与 `save`)。
- `AgentToolExecutor.generateImage`:在 persistence 落定的两个分支(预算内 `settled` / 后台迟到 `late`)后,用本地 `paths` 构建轻量 `AttachmentRef[]`(`uri = 原始本地路径`,非 `data:`)→ `replaceImageArtifacts` → base64 出局可被 GC。
- 显示链:`uri = 本地路径` 经 `toRenderableUri` → `local-file://` → `useResolvedMediaSrc` 自动走 `media:thumb`(512px)给气泡;灯箱传 `fullFidelity` 读原图原始字节 → **不压缩**。

### 2. 数据万象缩略图(集中在显示层,覆盖 COS 气泡)

- 新增 `utils/cosThumb.ts`:`appendCosThumb(url, size=512)` —— 仅当 url 是 COS(`.cos.` && `.myqcloud.com`,与 `useHistoryData.isCosUrl` 同口径)时拼 `?imageMogr2/thumbnail/<size>x<size>>/format/webp/quality/85/ignore-error/1`;非 COS / data: / 本地路径原样返回。
- `ArtifactCard`:气泡 src = `toRenderableUri(ref.thumbnailUri ?? appendCosThumb(ref.uri))`,poster 同理。
- 效果:**重载后**(history 解析到 COS URL)气泡自动吃数据万象几 KB 缩略图;**活会话**用本地 `media:thumb`(也是真缩略图);灯箱始终用原图 URL(不压缩)。

## 不做(后续)

并发闸门 / 崩溃遥测 / `content-visibility` / GPU 看门狗 / 活会话内 COS 升级(靠重载升级)。本次「丢 base64 + 气泡不再解码全尺寸」已根除稳态泄漏并大幅削峰;若极端并发爆发仍 OOM 再加闸门。

## 改动文件

- `src/renderer/src/utils/cosThumb.ts`(新) + `cosThumb.test.ts`
- `src/renderer/src/features/agent-chat/store.ts`(`replaceImageArtifacts`)
- `src/renderer/src/features/agent-chat/AgentToolExecutor.ts`(落定后换源 + `buildLightArtifacts` 纯函数)
- `src/renderer/src/features/agent-chat/cards/ArtifactCard.tsx`(数据万象缩略图)
- 测试:`cosThumb`、`replaceImageArtifacts`、`buildLightArtifacts`

## 验证

- `vitest run` 命中上述新增/改动测试全绿。
- `tsc --noEmit` 无新增错误。
- 手验:Codex 出图 → 气泡显示缩略图;保存横幅变「已保存」后 artifact `uri` 不再是 `data:`;点击灯箱看原图不压缩;重载后气泡走 COS 数据万象 URL。
