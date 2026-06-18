# 导演台 3D 资源包(可直接传桶)

从 RunningHub 海外站(`rhtv.runninghub.ai`)导演台「选择模型」库完整扒取,共 **99 个模型 + 99 张缩略图 + 1 个 Mixamo 假人 rig**,约 **1.07 GB**。所有 GLTF 均**自包含**(buffer / 贴图内嵌 base64,无外链 `.bin`),单文件即完整,可直接加载或上传对象存储。

## 目录结构
```
director-assets/
├─ models/        # 99 个 <id>.gltf(自包含,GLTFLoader 直接加载)
├─ thumbnails/    # 99 个 <id>.png(原图;前端可加 imageMogr2 压缩参数)
├─ rig/
│  └─ x_bot.fbx   # Mixamo「X Bot」标准人形骨架(高级假人/姿势系统的 rig)
├─ manifest.csv   # 映射:category / categoryKey / id / name / modelFile / thumbFile / sizeMB / sourceUrl / sourceThumb
├─ manifest.json  # 同上(JSON)
└─ download.ps1   # 下载脚本(断点续传,读取 ../docs/director-model-catalog.json)
```
> 文件名用模型 `id`(UUID)命名,与 `docs/director-model-catalog.json` 的 `id` 一一对应。

## 分类(5 类 / 99 个)
| key | 分类 | 数量 |
|---|---|---|
| JC | 基础模型 | 12(女/男 假人 + 10 图元) |
| RW | 人物 | 32(工人/警察/消防/医生/宇航员/职场/各朝代盔甲) |
| DJ | 道具 | 19 |
| CJ | 场景 | 12 |
| JT | 交通工具 | 24 |

## 原始来源
- 模型 / 缩略图 CDN:`https://rh-canvas-files.xiaoyaoyou.com/default/director/<uuid>.(gltf|png)`
- 假人 rig:`https://rhtv.runninghub.ai/dummy/x_bot.fbx`(Mixamo X Bot)
- 目录 API:`POST https://rhtv.runninghub.ai/canvas/director/model/list`(`Authorization: Bearer <token>`)

## 上传到自有桶 + 改写目录(复刻用)
1. 上传 `models/` 与 `thumbnails/`(及 `rig/x_bot.fbx`)到你的 COS/OSS/S3,保持文件名。
2. 用下面模板把 `docs/director-model-catalog.json` 里的 `url`/`previewImage` 改写成你的桶地址,生成自有 `model/list` 数据:

```powershell
$BUCKET = "https://<your-bucket>/director"   # 你的桶基址
$cat = [IO.File]::ReadAllText("..\docs\director-model-catalog.json",[Text.Encoding]::UTF8) | ConvertFrom-Json
foreach($c in $cat){ foreach($m in $c.models){
  $m.url          = "$BUCKET/models/$($m.id).gltf"
  $m.previewImage = "$BUCKET/thumbnails/$($m.id).png"
}}
[IO.File]::WriteAllText(".\model-catalog.bucket.json", ($cat | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding $false))
```
3. 前端 `GLTFLoader` 加载 `models/<id>.gltf`;假人摆姿用 `FBXLoader` 载入 `x_bot.fbx` + `SkeletonHelper`/`TransformControls`。
