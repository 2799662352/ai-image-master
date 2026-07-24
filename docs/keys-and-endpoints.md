# 密钥与接口配置指南(分镜切图 / 智能去字幕 / AI 生成通道)

> 结论先行:**所有密钥都没有写死在代码里**。腾讯云 SecretId/SecretKey 走
> 「设置页 → 环境变量 → (可选)本地凭证文件」三级解析;AI 生成通道的
> base URL + API Key 全部在设置页可配,任何 OpenAI 兼容网关(包括
> **newapi**)都能直接接。

## 一、分镜切图(宫格拆图)与智能去字幕 —— 腾讯云 COS + MPS

两个功能共用同一套腾讯云凭证(`src/main/services/tencent/credentials.ts`):

| 功能 | 链路 |
|------|------|
| 分镜切图(`storyboardSplit`) | 图片上传 COS → 提交 MPS 图片处理任务 → 轮询取回 |
| 智能去字幕(`smartErase`) | 视频上传 COS → 提交 MPS `ProcessMedia` 去字幕任务 → 轮询取回 |

### 凭证解析链(逐字段独立回退,谁有值用谁)

1. **设置页**(最高优先):设置 → 「腾讯云 COS / MPS」卡片,填 SecretId /
   SecretKey / Bucket / Region。经 Electron `safeStorage` **加密落盘**
   (`userData/tencent-credentials.bin`),渲染进程只见掩码。
2. **环境变量**(`.env` 或系统环境):
   `COS_SECRET_ID` / `COS_SECRET_KEY` / `COS_BUCKET`(或 `COS_BUCKET_NAME`)/
   `COS_REGION`。设置页留空时生效——即设置卡上那句「留空则使用 .env 环境变量」。
3. **可选本地凭证文件** `cos-credentials.json`(仓库根 / 打包后
   `resources/` 下):`.gitignore` 已排除、`electron-builder.yml` 的
   `extraResources` **不打包它**——安装包里不存在任何密钥,只是给部署方
   一个「手动放文件」的口子。
4. 都没有 → 功能不可用,设置页显示未配置。

### 需要的云资源

- 一个 **COS 存储桶**(如 `xxx-125xxxxxxx`,region 如 `ap-guangzhou`),
  用作任务的输入/输出中转;任务完成后临时对象会清理。
- 开通 **MPS(媒体处理)** 服务;SecretId 对应的 CAM 账号需有 COS 读写 +
  MPS 提交/查询任务权限。

### 换成自己的账号

设置页四个框填完点保存即可,无需重启、无需改代码;或者在 `.env` 写四个
环境变量后重启应用。

## 二、newapi 能接什么、怎么接

**能接**:应用的 AI 生成通道(生图 / 对话理解等 OpenAI 兼容 HTTP 通道)。
这些通道的站点(base URL)与 API Key 都在设置页「站点管理 / API 设置」里
自由增改——把站点地址填成你的 newapi 实例、Key 填 newapi 发的令牌即可:

```text
API 地址:https://your-newapi-host/v1   (newapi 的 OpenAI 兼容端点)
API Key:sk-xxxx                        (newapi 后台生成的令牌)
```

newapi 侧按其正常用法建渠道(上游模型供应商)+ 令牌即可,应用侧不感知
差别。Seedance 视频生成走专用站点配置(设置页 Seedance 卡,海外/国内
双站点),同样是可配的 host + key,不写死。

**不能接**:腾讯云 COS/MPS(上面第一节)。它们是腾讯云 TC3 签名的云 API,
不是 OpenAI 兼容协议,newapi 转发不了——这两个功能必须用腾讯云自己的
SecretId/SecretKey。

## 三、安全事实清单

- 代码中无任何硬编码 SecretId/SecretKey(`credentials.ts` 默认值全为空串)。
- 设置页保存的凭证经 `safeStorage`(系统级 DPAPI/Keychain)加密,旧版
  electron-store 明文加密存量会自动迁移到 safeStorage 并清除。
- `cos-credentials.json` 被 `.gitignore` 排除,且不进安装包。
- 渲染进程拿不到明文 key,只能拿到掩码(`abcd****`)与配置状态。
