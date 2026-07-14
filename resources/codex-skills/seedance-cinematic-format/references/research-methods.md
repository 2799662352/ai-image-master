# 分类调查方法

本文件是**每次任务都要走的调查清单，永不降级**。写 `[导演与参考系]` 前，
凡人名、作品、职务归属没把握，上游就按下文全流程用当前可用的网页或检索
工具核实，不因任务简单缩水规格。**先复用后检索**：先查项目参考知识库与
本会话调查回执，命中直接引用；未命中再检索，新回执写回知识库（见文末
「调查回执与复用」）。本知识模块本身不调用工具。“电影 / 电影感 / 电影级”在这里
是寻找摄影、调度、声音、剪辑和叙事案例的**检索意图词**，不是硬分类。

## 通用流程

1. 先把用户意图改写成 3–6 个可观察目标，例如“长焦压缩、低机位跟拍、停顿后
   瞬时爆发”，不要先搜一个名人再反推需求。
2. 以官方片尾职员表、官方网站、制作方访谈或论文为第一证据；专业数据库和
   社区片段库用于发现线索。
3. 至少用第二来源核实人名、作品名、年份和**真实职务**。导演、摄影指导、
   分镜、演出、作画监督、原画、动画总监和 VFX supervisor 不能互换。
4. 把已核实参考拆成可执行技法：构图、焦段、调度、关键姿势、材质、灯光、
   节奏和声音；不要只留下“某某风格”。
5. 只采用与当前用户意图和素材兼容的部分。参考与身份锚点、明确构图或平台
   约束冲突时，以用户资产和硬约束为准。
6. 无法核实时删去人名归因，保留中性的可执行技法；禁止用搜索摘要猜结论。

证据优先级：

```text
官方片尾/制作方资料/本人访谈/论文
> 专业协会与行业媒体
> 结构化职员数据库
> 专业分析文章
> 社区标签、论坛、MAD/剪辑
```

## 2D 动画调查方法

### 来源分工

- **官方作品网站、片尾 credits、制作公司与创作者访谈**：确认作品与集数职员，
  是真实归属的首选证据。
- **Sakugabooru**（https://www.sakugabooru.com/）：按作品、集数、animator
  和 technique 找具体片段；标签和作画归因来自社区，只能作线索。
- **ANN Encyclopedia**（https://www.animenewsnetwork.com/encyclopedia/）：
  交叉检查 series/episode staff、公司和职务。
- **Sakuga Blog**（https://blog.sakugabooru.com/）：读取制作分析与访谈，
  用来理解 layout、animation、compositing 之间的关系。
- **AniDB**（https://anidb.net/）：辅助反查作品、集数和人员；内容由社区维护，
  最终仍回到官方 credits。来源清单中无法确认仍有效的网站不写入成品。
- YouTube/Bilibili 的作画 MAD 只用于定位候选片段，不作为人员归属证据。

### 查询与判读

1. 用作品日文名 + 集数 + `スタッフ` / `絵コンテ` / `演出` / `作画監督` /
   `原画` 查职务。
2. 在 Sakugabooru 找候选片段，再用片尾 credits、本人作品履历或至少一个
   专业数据库交叉确认。
3. 区分“监督的整体演出选择”和“某位原画师完成的具体 cuts”；不要把整集所有
   镜头都归给一个人。
4. 从证据提炼 `レイアウト / タメとツメ / キーポーズ / 中割り /
   フォロースルー / 撮影処理` 等可执行项；面向日本受众或用户要求时写入
   日语正文，其它情况按用户语言表达。台词保持用户或素材原有语言。

## 真人剧与电影调查方法

### 来源分工

- **official credits、EPK、制片厂/发行方资料和主创访谈**：确认导演、DP、
  production designer、editor 和 sound designer 的真实职责。
- **ASC / American Cinematographer**（https://theasc.com/）及 BSC
  （https://bscine.com/）：调查 cinematography、lens、lighting、exposure、
  camera movement 与现场决策。
- **ShotDeck**（https://shotdeck.com/）：按 shot size、composition、lighting、
  lens、color 和 emotion 寻找视觉参照；画面标签用于视觉分析，不代替片尾职员。
- 摄影机/镜头厂商的主创案例（ARRI、Cooke、Panavision 等）可补充器材与工作流。
- IMDb、Wikipedia、影评和社交媒体只能做入口线索，不能单独证明创作归属。

### 查询与判读

1. 先搜“作品 + cinematographer/director interview + scene/lighting/lens”，
   再核对官方 credits。
2. 把参考帧拆成 shot size、camera height、lens compression、blocking、
   key-to-fill、color contrast、focus transition 与 ambience。
3. 区分导演调度、摄影决策、美术设计、剪辑节奏和声音设计，不把所有效果归因
   给导演。
4. 成品提示词可用中文写叙事与表演、英语写精确摄影/灯光词；这只是建议。
   台词保持用户或素材原有语言，除非用户要求，否则不翻译。

## 3D 动画与电影调查方法

### 来源分工

- **制作公司官方 breakdown、片尾 credits 和主创访谈**：确认 animation、
  rigging、FX、lighting、look development、rendering 与 compositing 的职责。
- **SIGGRAPH Production Sessions / Technical Papers**（https://www.siggraph.org/）
  与 ACM Digital Library：调查真实 production pipeline、simulation、rendering
  和技术限制。
- **GDC Vault**（https://www.gdcvault.com/）与 FMX（https://fmx.de/）：
  查角色动画、实时渲染、虚拟制片和工作流演讲，并区分游戏与电影管线。
- 制作方发布的 ArtStation 项目、软件厂商 case study 和技术博客可作补充；
  先确认作者确实参与对应项目。

### 查询与判读

1. 用“作品 + studio + production breakdown / SIGGRAPH / making of”定位一手资料。
2. 记录参考属于 animation、rig、cloth/hair、FX、material、lighting 还是
   compositing，避免用一个笼统的“3D 质感”覆盖全管线。
3. 提炼 topology stability、weight shift、contact、secondary motion、
   roughness/metallic/transmission、light direction 和 texture stability。
4. 成品提示词可用中文写叙事、主体关系与约束、英语写稳定的 3D 技术词；
   这只是建议。台词保持用户或素材原有语言，除非用户要求，否则不翻译。

## 调查回执与复用

**每次核实都留回执，回执是可复用资产，不是一次性的。** 不要把长篇研究
原样塞进视频提示词，只保留简短回执：

```text
用户意图：
已核实参考：人员/作品/真实职务
证据：来源标题 + URL + 日期
可执行技法：3–6 条
置信度：高 / 中 / 低
未核实内容：删除归因后保留的中性技法
```

复用规则：

1. 检索前先查两处——项目参考知识库文件（约定为项目工作区或制品目录下的
   `reference-receipts.md`，没有就在首次核实时创建）与本会话已有回执。
2. 命中且置信度为高的条目直接引用进 `[导演与参考系]`，不重复检索同一归属。
3. 未命中或置信度低才上网核实；完成后把新回执**追加写回**知识库文件，
   供后续任务与后续会话复用。
4. 归属事实（人名/职务/作品）不过期；涉及“最新模型能力/行业惯例”这类
   时效信息的条目复用前检查日期，过旧则重新核实并更新回执。
