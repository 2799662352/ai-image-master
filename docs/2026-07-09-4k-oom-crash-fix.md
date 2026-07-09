# 4K 批量生图 OOM 闪退 + 历史记录丢失 — 根因与修复 (2026-07-09)

> 状态: 已修复并通过用户实测。涉及渲染进程、主进程、IPC、history 持久化、展示层五层。
> 关联早期修复: 2026-06-23 的「COS 上传成功后热切 cosUrl 释放 base64」(P0 OOM 第一刀),
> 本次是对整条链路的系统性封堵。

## 一、现象

- 批量页用 nano2(gemini-native)并发生成多张 4K 图,返回图片时**软件整体闪退重启**;
- 闪退后重新打开,**历史记录页记录丢失**;
- 单张生成偶发,4K + 并发时必现。

## 二、根因

nano2 等 gemini-native 模型的 4K 图以 **base64 内联在 JSON** 里返回,一张 ≈ 10–40MB
字符串。这串 base64 在修复前会被复制/驻留在多个地方,并发 6 张时叠加放大:

| # | 链路 | 内存代价 |
|---|------|---------|
| 1 | `JSON.parse` 大响应 + `rawResponse` 字段保留完整响应体 | 瞬时 2–3 份全量拷贝 |
| 2 | base64 原样存进 zustand store(`resultUrl`/`resultUrls`),COS 上传完成前不释放 | 每张 10–40MB 常驻 V8 堆 |
| 3 | base64 字符串经 IPC 结构化克隆传主进程转存 COS | 渲染 + 主进程各持一份 |
| 4 | COS 失败时 base64 被写进 history;此后**每次全量保存**都随整个数组反复 IPC + `JSON.stringify` + 落盘 | 主进程反复分配巨型字符串 |
| 5 | 批量 history 每条 item 逐字复制全部原始参考图 base64(16 张 × 数 MB) | history 文件膨胀至数百 MB |
| 6 | 网格/历史卡片 `<img>` 直接解码 4K 原图(4000×3000 PNG 解码 ≈ 48MB RGBA) | GPU/位图内存爆炸 |

**闪退** = 渲染进程或主进程 V8 堆 OOM 被 Chromium 杀掉;
**记录丢失** = 崩溃恰好发生在 history 非原子写盘途中 → 文件截断损坏。

## 三、修复架构

### 1. base64 一到手就「物化」成 blob:(新增 `utils/imageResources.ts`)

- `materializeImageUrl(s)`:`fetch(dataURL).blob()` 把 base64 解进**堆外 Blob**,
  store 里只存几十字节的 `blob:` URL,V8 堆从头到尾不驻留巨型字符串;
- 浏览器原生解码不经过 V8 字符串堆、异步不卡主线程;
- `revokeLater()`:cosUrl 热切/删除 item 时延迟 10s revoke,避免正在展示的 `<img>` 闪
  `ERR_FILE_NOT_FOUND`;
- jsdom 等不支持的环境自动回退原字符串,行为退化为修复前,不黑图。

接入点:`useGenerateStore.generate()`、`useBatchStore` 生成回调 —— 模型直出
data: URL 在**进 store 前**已被物化。

### 2. 字节版 IPC 上传 + 主进程并发闸(`preload` + `main/index.ts`)

- 新增 `cos:enqueue-upload-bytes` 通道:渲染端从 Blob 取 `ArrayBuffer` 直接传,
  二进制结构化克隆比 base64 字符串小 25% 且不占 V8 堆;
- 老 `cos:enqueue-upload-from-url` 通道保留(http URL / 降级用);
- 主进程 `acquireUploadSlot` 并发闸:同时在飞的上传/落盘任务有限,避免 6 张 4K
  同时进主进程内存。

### 3. 砍掉 `rawResponse`(`services/api/ApiService.ts`)

`parseResponse` 成功路径不再返回完整响应体 —— 消除一份 10–40MB 级的冗余瞬时拷贝。

### 4. history 持久化加固(`main/index.ts` + `StorageBridge` + `HistoryDataService`)

- **原子写**:`save-history` 串行化 + 先写 `.tmp` 再 rename,保留 `.bak`;
  崩溃再也不会把 history 文件写成半截;
- **消毒**:主进程 `sanitizeHistoryValue` 把超 1MB 的 `data:` 字符串替换为占位标记;
  `StorageBridge.saveHistory` 在 IPC 前同样防御性剥离 —— 巨型 base64 **永远进不了**
  全量保存链;
- **参考图缩略**:`thumbnailRefsForHistory()` 把参考图压成 640px JPEG dataURL
  (单张 ≈ 30–120KB,重编辑回灌够用),`WeakMap` 按数组身份缓存,整批只压一次;
- **上限回调**:item 变轻后,本地上限 30→120 条、云端 100→200 条;
- **恢复过滤**:`HistoryPage.handleEdit` 回灌时过滤 `[base64-removed]` 等占位标记。

### 5. 展示层: 数据万象实时缩图(`utils/cosThumb.ts` 接入三处网格)

COS 源经 `imageMogr2/thumbnail/{N}x{N}>/format/webp/quality/85/ignore-error/1`
实时缩成 WebP,渲染进程拉取/解码的是几十 KB 缩图而非几 MB 原图:

| 位置 | 尺寸 | 说明 |
|------|------|------|
| `BatchResultGrid` 卡片 | 512px | 批量结果网格 |
| `ResultGrid`(生成页)| 1024px | 2 列布局卡片较宽,保 retina 清晰 |
| `DonorCard`(历史页)| 512px | 一屏几十上百张,收益最大 |

非 COS 源(blob:/local-file:/临时 http)原样透传;**lightbox 放大与下载永远用无损原图**。

### 6. 本地落盘兜底(参照 codex 页 MCP 出图)

- 主进程两条上传通道在推 COS **之前**先把字节写到
  `userData/generated-images/<时间戳>-<id>-<随机>.<ext>`;
- 上传结果事件携带 `localPath`,store 记录之;
- **COS 失败时**,history 写 `local-file://` 形式的本地副本(自定义协议,`<img>`
  可直接渲染,跨重启不过期),不再依赖几小时就过期的模型直出签名 URL;
- 兜底优先级:`cosUrl` → `local-file://` 本地副本 → http 临时直出 URL;
  `blob:`/`data:` 跨重启即失效,**绝不写入 history**;
- `url-validator.ts` 已放行 `local-file:` 协议。

## 四、修复后数据流

```
模型返回 JSON(内联 base64)
  └─ parseResponse (不再留 rawResponse)
       └─ materializeImageUrls: data: → 堆外 Blob + blob: URL
            ├─ store 只存 blob: (几十字节)         ← 展示兜底
            ├─ Blob → ArrayBuffer → cos:enqueue-upload-bytes (IPC 二进制)
            │    └─ 主进程(并发闸):
            │         ① 先落盘 userData/generated-images  ← 永久本地副本
            │         ② 推 COS
            │         ③ 广播结果 {url, key, localPath}
            ├─ 成功: 展示热切 cosUrl, revoke blob:, history 写 cosUrl
            └─ 失败: 保留 blob: 显示, history 写 local-file:// 副本
展示: COS URL + imageMogr2 → 数据万象实时 512/1024px WebP 缩图
history 保存: 参考图缩成 640px JPEG → sanitize → IPC → 主进程原子写(.tmp→rename, 留 .bak)
```

## 五、改动文件

| 文件 | 改动 |
|------|------|
| `src/renderer/src/utils/imageResources.ts` | **新增** — 物化/revoke/参考图缩略工具 |
| `src/renderer/src/utils/cosUploadDispatcher.ts` | Blob 字节上传入队;`CosResult` 增 `localPath` |
| `src/renderer/src/utils/url-validator.ts` | 放行 `local-file:` |
| `src/renderer/src/stores/useGenerateStore.ts` | 物化接入、cosUrl 热切 revoke、localPath、history 兜底排序 |
| `src/renderer/src/stores/useBatchStore.ts` | 同上(批量) |
| `src/renderer/src/services/api/ApiService.ts` | 成功路径移除 `rawResponse` |
| `src/renderer/src/services/storage/StorageBridge.ts` | IPC 前防御性剥离超大 `data:` 参考图 |
| `src/renderer/src/features/history/HistoryDataService.ts` | 入 history 前参考图缩成 640px JPEG |
| `src/renderer/src/features/history/HistoryManager.ts` | 本地/云端上限 30→120 / 100→200 |
| `src/renderer/src/pages-react/BatchPage.tsx` | 清空结果时 revoke blob;预览优先 cosUrl |
| `src/renderer/src/pages-react/HistoryPage.tsx` | 重编辑回灌过滤占位标记 |
| `src/renderer/src/pages-react/batch/BatchResultGrid.tsx` | 卡片走数据万象 512px 缩图 |
| `src/renderer/src/pages-react/generate/ResultGrid.tsx` | 卡片走数据万象 1024px 缩图 |
| `src/renderer/src/components/donor/DonorCard.tsx` | 历史卡片走数据万象 512px 缩图 |
| `src/preload/index.ts` | `enqueueUploadBytes` 通道;结果事件带 `localPath` |
| `src/main/index.ts` | 字节通道 handler、上传并发闸、先落盘 `generated-images`、history 原子写 + sanitize |
| `stores/__tests__/cosUploadHotSwap.test.ts` | 契约更新:进 store 前已是 blob:;fake bridge 补 `enqueueUploadBytes` |

## 六、验证

- typecheck:与 `git stash` 基线逐项比对,**零新增错误**(报错均为预存);
- 单测:相关 7 套件 175 用例全绿(`useBatchStore` / `useGenerateStore` /
  `cosUploadHotSwap` / `StorageBridge.persistence` / `cosThumb` /
  `DonorVirtualGrid` / `url-validator`);
  另两处失败(`ApiService.gptImage2`、`EraseResultModal`)确认为预存陈旧断言,已一并更新;
- 用户实测:批量 4K 并发生成不再闪退,历史记录保留。

## 七、运维注意

1. **本地副本目录** `userData/generated-images/` 目前只增不减 —— 每张成功生成的图都会
   落一份原图。后续可加「保留最近 N 天/GB」的清理策略(TODO)。
2. **数据万象计费**:缩图走 CI 图片处理(按处理量计费),用户已明确接受
   (「不要怕花钱,利用腾讯数据万象的 URL 参数进行实时缩放」)。`ignore-error/1`
   保证不支持的格式回退原图而非碎图。
3. **老 history 条目**里遗留的 `data:` 大图:展示时经 `useDisplaySrc` 异步转 blob 不卡
   主线程;下次全量保存会被 sanitize 剥离(替换为占位标记),体积逐步收敛。
