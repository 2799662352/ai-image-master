# Sakuga-42M 纯云原生知识库设计

- 日期:2026-07-05
- 状态:设计已获用户批准(视频试水规模:3000 条)
- 前置:全量官方元数据已下载并校验(`videos/Sakuga-42M/metadata/`,6 个 parquet,共 715 MB,train_full = 1,117,898 行与官方发布数逐一吻合;已加 `.gitignore` 防误提交)

## 1. 背景与目标

Sakuga-42M 是最大规模的手绘动画(作画)数据集元数据:每行一个动画片段,含英文场景描述、danbooru 风格标签、sakugabooru 社区作画技法标签(`user_tags`:smears / impact_frames / character_acting / effects 等)、六维粗分类、美学分/动态分、以及回源 URL+时间码。

用户目标(按优先级):

1. **信息零丢失**——不接受"只保留蒸馏精华"的方案;
2. **纯云原生**——不依赖本地文件;app 分发给其他用户,所有用户的 agent 都要能查;
3. **视频本体可检索**——"1 TB 视频无所谓,方便就好",先以 3000 条精选片段试水;
4. 融入现有链路:`cinematography-kb-mcp`(DashScope 检索桥)+ 阿里百炼知识库(`search_cinematography_kb`)。

## 2. 架构总览(四层)

```text
① OSS 原始层      715MB parquet 原样上传 OSS → 字节级零丢失保险箱(约 ¥0.1/月)
② DashVector 全量层  1,117,898 行 → Serverless Collection(语义+条件过滤+关键词三合一检索)
③ 百炼 KB 精华层    按 user_tags 技法标签蒸馏 50-70 篇 markdown → 现有 cinematography KB
④ 百炼音视频层     3000 条精选 clip 回源下载 → OSS → 百炼「音视频搜索类知识库」
```

各层职责:

| 层 | 回答的问题 | 检索方式 |
|---|---|---|
| ① OSS | "原始数据在哪?"(灾备/重建) | 不检索,纯存储 |
| ② DashVector | "给我 aesthetic>0.7 且带 smears 标签的追逐戏描述" | 向量+fields 过滤+sparse 关键词 |
| ③ 百炼 KB | "什么是 impact frames?怎么写这类提示词?" | 语义 RAG(现有 `search_cinematography_kb`) |
| ④ 百炼音视频库 | "找几段真实的烟雾效果作画片段看看" | 音视频语义检索(带时间戳) |

## 3. 组件设计

### 3.1 ① OSS 原始层

- Bucket 内路径:`datasets/sakuga-42m/metadata/*.parquet`(6 个文件原样)。
- 版本:文件名已含 split 语义,不启用多版本。
- 复用现有 COS/OSS 凭证管理模式(项目已有 Tencent COS 发布链路;OSS 凭证同样走 `.env`,不入库)。

### 3.2 ② DashVector 全量层(核心)

- 实例:**Serverless 型**(官方定位 QPS<2、延迟不敏感——正是 agent 查询画像)。
- Collection:`sakuga42m`,dense 向量 512 维(text-embedding-v4)。
- 每 Doc 字段(25 列全量进 fields,零丢失):
  - 向量:`text_description` 的 dense embedding;可选 DashText sparse 向量(关键词两路召回);
  - fields:`identifier`(主键)、`url_link`、`scene_start_time/end_time`、`anime_tags`、`user_tags`、`text_description` 原文、`aesthetic_score`、`dynamic_score`、`rating`、`text_prob`、`width/height/fps/file_ext`、六个 `Taxonomy_*`、`frame_number/key_frame_number` 等。
- 数据源:**仅 `train_full`(1,117,898 行)**。val/test 是官方评测切分(与 train 无重叠、用途相同),留在 OSS 原始层,如有需要可随时补灌。
- 写入管线:Python 脚本批跑(DashScope embedding batch API + DashVector batch insert,断点续跑,记录已写 identifier)。

### 3.3 ③ 百炼 KB 精华层(蒸馏文档)

- 分组轴:**`user_tags` 作画技法标签**(高频 ~50-60 个:smears、impact_frames、effects 细类、character_acting、walk_cycle、morphing、background_animation 等)。
  - 注:原方案的六维 Taxonomy 已被数据剖析否决——Filming 全库仅 3 类、一半行是 Others(-1),不能做分组轴,仅作文档内统计附注。
- 每篇文档:技法定义 + 高分池(aes>0.7 & dyn>0.6 & text_prob<0.1,共 243,806 行)中该标签 top 10-20 条描述范例 + 常见搭配标签 + 代表性 `identifier` 回源索引。
- 总纲一篇:标签体系全景 + 与 CHAI 五维(camera/motion/scene/spatial/subject)中 motion 维的映射。
- 产物规范对齐 `D:\tecx\text\videos\CHAI-text\build_bailian_corpus.ps1` 流水线,上传到**现有** cinematography KB(不新建库、不改 MCP 描述)。

### 3.4 ④ 百炼音视频层(3000 条试水)

- 选片策略:从高质量池分层抽样——按 top ~50 技法标签每标签 ~60 条,保证技法覆盖;同标签内按 `aesthetic_score` 降序取。
- 获取:按 `url_link` 回源下载 sakugabooru(限速、重试;失效条目跳过并从候补补齐)。预估单条 2-5 MB,3000 条 ≈ 6-15 GB,远低于标准版 100 GB 免费平台存储。
- 上传:本地 → OSS → 百炼音视频搜索类知识库(云端导入),开启视频帧提取;**剧情解析首批默认关闭**(显著加时加费),若帧提取的召回效果不足,再对 200 条小样本开启对比。
- 已知限制:音视频库切片只能删不能增改;工作流应用不支持关联音视频库(旧版智能体应用最多 5 个)。

### 3.5 MCP 接入(`cinematography-kb-mcp`)

- 新工具 `query_sakuga_dataset`:参数 `query_text`(语义)、`filter`(DashVector 过滤表达式,如 `aesthetic_score>0.7 and user_tags like '%smears%'`)、`topk`。
- 实现:DashScope embedding(query)→ DashVector HTTP query → 返回行(含描述、标签、分数、url+时间码)。
- 凭证:`DASHVECTOR_API_KEY` + endpoint,注入方式与现有 `DASHSCOPE_API_KEY` 相同(launch 时 `-c` 注入),app 用户开箱可用。
- 工具描述中说明与 `search_cinematography_kb` 的分工:前者查"真实数据集范例(可过滤)",后者查"知识/规范/技法讲解"。

## 4. 成本(官方价目,已核实)

| 项目 | 单价 | 用量 | 费用 |
|---|---|---|---|
| DashVector 写入 | ¥3.6/百万写单元 | 111.8 万条一次 | ~¥10-30 一次性 |
| Embedding | text-embedding-v4 按 token | ~7000 万 token | ~¥50 一次性 |
| DashVector 存储 | ¥1.5/GB/月 | 3-5 GB | ~¥5-8/月 |
| DashVector 读取 | ¥8/百万读单元 | agent 低频 | 忽略 |
| OSS 原始层 | 标准存储 | 715 MB + 15 GB 视频 | ~¥2-3/月 |
| 百炼 KB | 标准版 720h 免费额度 + 按量 | 蒸馏文档量极小 | 近零 |
| 百炼音视频解析 | 按量(视频帧提取/ASR) | 3000 条短片 | 一次性,试水后按账单评估 |

## 5. 许可与合规

- Sakuga-42M 原版许可 CC-BY-NC-SA(非商用、相同方式共享):**仅内部检索/考据用,不打包进商城分发,不用于商业训练**。
- 蒸馏文档进百炼 KB 属内部检索用途;视频片段仅存于自有 OSS/百炼业务空间(百炼承诺不用于商业用途或对外公开)。
- MCP 工具返回内容带来源标注(identifier + sakugabooru URL)。

## 6. 错误处理

- 写入管线:断点续跑(本地 checkpoint 记录已写 identifier);embedding 限流退避;单条失败不阻塞批次,失败清单落盘可重跑。
- 回源下载:404/反爬失败 → 跳过并从候补名单补齐至 3000;下载限速防封。
- MCP 工具:DashVector 超时/鉴权失败 → 返回结构化错误提示(与现有 `search_cinematography_kb` 错误处理风格一致)。

## 7. 验收标准

1. DashVector Collection 行数 = 1,117,898;抽样 20 条 fields 与 parquet 原值逐字段一致(零丢失验证)。
2. `query_sakuga_dataset("fast smear animation during chase", filter="aesthetic_score>0.7")` 返回相关行且含回源 URL。
3. 百炼 KB 命中测试:查询"impact frames 怎么写提示词"能召回对应蒸馏文档。
4. 音视频库命中测试:查询"烟雾爆炸效果作画"能召回相关片段及时间戳。
5. 成本核对:首月账单与本文估算同数量级。

## 8. 非目标(本期不做)

- val/test 两份 split 灌入 DashVector(留 OSS,可随时补);
- 1 TB 全量视频入云(试水 3000 条后再评估扩量);
- skill 文案更新引用新工具(用户此前明确"skill 先不改";MCP 工具描述自身已含使用指引);
- Meta Agent / ADB-PG / MaxCompute 等重型数据设施(记入"数据资产多了再说"清单)。

## 9. 实施阶段划分(概要)

1. **P0 OSS 原始层**:上传 6 个 parquet(10 分钟);
2. **P1 DashVector**:开通试用 → 建 Collection → embedding+写入批跑(几小时)→ 零丢失抽验;
3. **P2 MCP 工具**:`query_sakuga_dataset`(TDD,含 mock 测试)→ 打包验证;
4. **P3 蒸馏文档**:脚本产出 50-70 篇 → 上传百炼 → 命中测试;
5. **P4 音视频试水**:选片 3000 → 回源下载 → OSS → 音视频库 → 命中测试 → 出试水报告(效果+账单)。

P0-P1 无代码风险可先行;P2 涉及 app 代码走 TDD;P3/P4 为数据管线,产物可重复生成。
