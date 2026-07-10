# Sakuga-42M 全量云化部署与运维

**状态**：已完成元数据全量云化；源媒体 OSS 同步已暂停，可断点续传  
**日期**：2026-07-10

## 1. 最终架构

Sakuga 检索采用“云端元数据 + 本地/OSS 双回源”：

1. `query_sakuga_dataset` 将查询文本编码为 512 维向量。
2. DashVector 在 `sakuga42m` 中检索真实动画片段元数据。
3. MCP 返回描述、技法词条、作画人员、作品、分类、时间码和原始来源。
4. 本机存在原片时返回本地路径。
5. 全量同步校验完成并启用镜像后，配置 OSS 凭证可同时返回约 60 分钟有效的私有签名 URL。
6. MCP 不预切片；agent 按时间码使用 ffmpeg 截取所需片段。

这样避免了全量预切片和云端视频理解费用，同时保留远程访问能力。

## 2. 数据状态

### DashVector

- Cluster：`catimation-sakuga-prod`
- 类型：付费 Serverless
- 地域：华北 2（北京）
- Collection：`sakuga42m`
- 向量维度：512
- 距离度量：Cosine
- 文档数：**1,117,898**
- 索引完整度：**1.0**
- 元数据字段：24 个
- 零丢失抽验：随机 60 条 × 24 字段，0 个不一致

旧免费试用 Cluster `catimation-sakuga` 已释放。

### 本地源媒体

- 目录：`D:\tecx\text\videos\sakuga-full\sources`
- 媒体规模：约 1.2 TiB
- Sakuga-42M 帖子覆盖：**141,749 / 142,089（99.76%）**
- 切片覆盖：**1,114,597 / 1,117,898（99.70%）**
- 剩余 340 个帖子在 sakugabooru 源站返回 404，无法继续补抓

### OSS

- Bucket：`catimation-sakuga-videos`
- 地域：华北 2（北京）
- 存储类型：标准存储
- 冗余：本地冗余（LRS）
- ACL：私有
- 对象前缀：`sources/`
- 当前状态：**同步已暂停**
- 暂停时已上传：315 个对象

OSS 同步使用 `--update`，恢复后会跳过已存在且不旧于本地的对象，不会从头重传。

## 3. MCP 工具行为

### `query_sakuga_dataset`

返回内容包括：

- 语义相似度
- 英文画面描述
- 技法词条
- 作画人员 / key animator
- 来源作品
- 六维分类
- sakugabooru 原始链接
- 场景起止时间码
- 本地原片路径（存在时）
- 私有 OSS 签名 URL（镜像就绪且配置凭证时）

### `get_sakuga_clip`

输入：

```text
102939:9
```

或：

```text
102939_9
```

输出原片访问方式与时间码。MCP 不执行切片；消费端可运行：

```powershell
ffmpeg -i "<本地路径或签名URL>" -ss "<开始时间>" -to "<结束时间>" -c copy clip.mp4
```

## 4. 配置

非密钥配置已经内置：

```text
DASHVECTOR_ENDPOINT=vrs-cn-1zz4v38oq0001l.dashvector.cn-beijing.aliyuncs.com
SAKUGA_OSS_BUCKET=catimation-sakuga-videos
SAKUGA_OSS_ENDPOINT=oss-cn-beijing.aliyuncs.com
SAKUGA_OSS_PREFIX=sources
SAKUGA_OSS_MIRROR_READY=0
```

上传完成并核对对象数量/容量前保持 `SAKUGA_OSS_MIRROR_READY=0`。完整镜像验证通过后才改为 `1`，避免检索结果返回尚未上传的死链接。

运行时需要的密钥：

```text
DASHSCOPE_API_KEY
DASHVECTOR_API_KEY
SAKUGA_OSS_ACCESS_KEY_ID
SAKUGA_OSS_ACCESS_KEY_SECRET
```

密钥只存放在用户级配置中，不写入 git：

- Codex MCP：`%USERPROFILE%\.codex\config.toml`
- ossutil：`%USERPROFILE%\.ossutilconfig`

当前按用户要求使用主账号 AccessKey。主账号 Key 权限过大，后续建议迁移为仅授权此 Bucket 的 RAM 用户或 STS 临时凭证。

## 5. OSS 同步运维

### 恢复上传

```powershell
powershell -ExecutionPolicy Bypass -File `
  D:\tecx\text\temp-ai-image-master-source\scripts\sakuga\sync_oss.ps1
```

脚本自动：

- 扫描 `sources/`
- 排除 `.json` 和 `.part`
- 并发上传
- 跳过已同步对象
- 网络失败后重试
- 写日志到 `D:\tecx\text\videos\sakuga-full\oss_sync.log`

### 暂停上传

先停止 `ossutil`，再停止运行 `sync_oss.ps1` 的 PowerShell 守护进程，避免一分钟后自动重试。暂停不会删除云端对象。

### 查看进度

```powershell
Get-Content D:\tecx\text\videos\sakuga-full\oss_sync.log -Wait
```

或查看云端对象：

```powershell
D:\tecx\text\videos\sakuga-full\tools\ossutil-2.3.0-windows-amd64\ossutil.exe `
  ls oss://catimation-sakuga-videos/sources/ `
  -c "$env:USERPROFILE\.ossutilconfig"
```

## 6. 验证记录

已完成：

- DashVector 总数与 parquet 精确一致
- DashVector 索引完整度 1.0
- 60 条全字段零丢失抽验
- `query_sakuga_dataset` 端到端查询
- 本地路径解析
- OSS 冒烟上传
- 私有 OSS 签名 GET（Range 请求返回 206）
- MCP 单元测试 6/6
- 修改文件零 lint

## 7. 成本说明

标准存储费用按实际容量计费；约 1.2 TiB 的月存储费需以阿里云账单和当前地域单价为准。此前约 ¥145/月仅为估算，外网下行流量、请求次数和临时签名 URL 访问产生的费用另计。
