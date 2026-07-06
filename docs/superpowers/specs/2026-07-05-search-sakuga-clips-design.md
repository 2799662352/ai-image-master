# search_sakuga_clips:三层联查 MCP 工具设计

**日期**: 2026-07-05
**状态**: 已实现并验收通过
**文件**: `resources/cinematography-kb-mcp/index.js`

## 背景与问题

用户诉求:检索作画片段时,**纯文本(画面解析)和对应可播放的 mp4 必须一起返回**,且必须带上专业词条(技法)、作画人员、工作室、作品等专业元数据。

此前的两个工具各有盲区:

| 工具 | 数据源 | 有画面解析文本 | 有可播放视频 | 有专业元数据 |
|---|---|---|---|---|
| `query_sakuga_dataset` | DashVector(30 万条元数据) | ✗(只有英文描述) | ✗(只有 sakugabooru 原始链接) | ✓ |
| 百炼音视频库(控制台/Retrieve API) | Bailian AV KB(试点视频) | ✓(逐帧解析) | ✓(签名 mp4 URL) | 仅文件名里压缩的部分 |

关键事实(已实测验证):百炼音视频库 Retrieve API 的每个命中节点 `metadata` 中带有
`video_url` —— 指向该片段切片的**签名 OSS 直链**(可下载/可播放,有有效期)。

## 方案:三层联查(零重建)

```
用户 query
   │
   ▼ ①视觉召回
Bailian AV KB (agent_id: aid-f46c435c5877424ca9d8e7bdebd42a2f)
   → 每命中: 逐帧解析文本 + doc_name + video_url(签名 mp4)
   │
   ▼ ②标识符解析
doc_name 形如 "102939_9__artist+tags….mp4" → 提取 "102939_9"
   │
   ▼ ③元数据富集(best-effort)
DashVector sakuga42m fetch-by-id
   → text_description / user_tags / 六维分类 / 分数 / 原始出处+时间码
   → user_tags 经 sakuga-tag-types.json 分类为 技法词条/作画人员/工作室/作品/角色
```

- 第③层不可用时**优雅降级**:仍返回解析文本 + video_url,tag 从文件名兜底解析。
- 与 `query_sakuga_dataset` 互补:后者覆盖全量 30 万元数据(无视频),本工具覆盖已入库试点视频(有视频)。

## 实现要点

- `searchKb()` 增加 `agentId`(默认原文本库)与 `raw`(返回原始 payload)参数,复用同一 endpoint host 与 `DASHSCOPE_API_KEY`。
- 新增 `getJson()`(DashVector `GET /v1/collections/sakuga42m/docs?ids=…`,header `dashvector-auth-token`)。
- 纯函数 `parseAvNode()`(剥离【文档名】/【标题】样板,只留【正文】)与 `formatClipHit()`(渲染单条命中),已导出供单测。
- 环境变量:`DASHSCOPE_API_KEY`(必需)、`DASHVECTOR_API_KEY`+`DASHVECTOR_ENDPOINT`(可选,富集层)。

## 输出格式(每条命中)

```
[1] 102939_9 (aes 0.98 / dyn 1.00) ###0秒-1秒
画面: <百炼逐帧解析,截 500 字>
视频 (signed URL, expires): http://…oss….mp4?Expires=…
英文描述: <text_description>
技法词条: cgi, effects, impact_frames, smears…
作画人员: megumi_kouno
工作室 / 作品 / 角色: …
六维分类: 运镜=… · 构图=… · 时间=… · 场地=… · 媒介=… · 人物=…
原始出处: https://www.sakugabooru.com/data/….mp4 (00:00:12.349–00:00:13.102)
```

## 验收(2026-07-05)

stdio 端到端:`tools/call search_sakuga_clips {"query":"激烈的打斗 冲击帧"}` →
5 条命中全部同时携带:解析文本 + 签名 video_url + 作画人员(megumi_kouno,
takahito_sakazume, kazuhiro_miwa…) + 技法词条(impact_frames, smears…) + 六维分类 + 原始出处。

## 配套:2913 条命名片段批量上传

`scripts/sakuga/upload_batches.ps1`:agent-browser 驱动百炼控制台,58 批 × 50 条/批。
踩坑与对策(均已写入脚本):

1. **控制台限 50 文件/次导入**,超长文件名(>~110 字符)会被静默丢弃 → 命名生成时已截到 ≤100 字符。
2. **hash 路由同 URL 不刷新** → 每批先开 detail 页再开 `/import`,强制路由切换。
3. **类目必须显式选中**(antd tree-select),否则「完成」报「请选择类目或者文件」但按钮点击本身"成功" → 选后校验 `.efm_ant-select-selection-item` 文本 = 默认类目,3 次重试。
4. **成功判据不能是按钮点击**,必须等 URL 离开 `/import`(回到 `detail…?fromCreate=true`)才把该批 50 个文件计入 `upload_batches_done.txt`(幂等续跑用)。
5. **PS 5.1 控制台默认 GBK 解码** agent-browser 的 UTF-8 输出,中文比对全部失败 → 脚本头部设 `[Console]::OutputEncoding = UTF8`;脚本本体存 UTF-8 with BOM。
