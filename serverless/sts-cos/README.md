# sts-cos — Tencent SCF function for COS image-history STS tokens

Issues short-lived (30 min) STS credentials scoped to **PutObject only** under
`image-history/*` in bucket `image-master-1345773498` (ap-guangzhou).

The permanent sub-account key lives **only** in this function's environment
variables and is never shipped to the desktop client. Clients call the HTTP
endpoint, get a temporary token, and upload directly to COS.

## Files

- `index.js` — SCF handler (`main_handler`), uses `qcloud-cos-sts`.
- `package.json` — declares the `qcloud-cos-sts` dependency.
- `sts-cos.zip` — ready-to-upload bundle (`index.js` + `package.json` + `node_modules`).

## Deploy (SCF console)

1. Console → 云函数 SCF → 函数服务 → 新建。
   - 创建方式：**从头开始**
   - 运行环境：**Node.js 16.13**（或更高）
   - 函数名：`sts-cos`，地域：**广州 ap-guangzhou**
   - 提交方式：**本地上传 zip 包** → 选 `sts-cos.zip`
   - 执行入口/Handler：`index.main_handler`
2. 高级配置 → **环境变量**：
   - `TENCENT_SECRET_ID` = 子账号 SecretId
   - `TENCENT_SECRET_KEY` = 子账号 SecretKey
   - （可选）`APP_TOKEN` = 自定义随机串，开启后客户端必须带 `X-App-Token` 头
3. 触发管理 → 新建触发器：
   - 触发方式：**API 网关触发器**
   - 请求方法：`POST`（或 ANY）
   - 鉴权：免鉴权
   - 创建后复制生成的**访问路径 URL**（形如
     `https://service-xxxx-1345773498.gz.apigw.tencentcs.com/release/sts-cos`）。

## Optional env vars (have sane defaults)

| Var | Default |
| --- | --- |
| `COS_REGION` | `ap-guangzhou` |
| `COS_BUCKET` | `image-master-1345773498` |
| `COS_APPID` | numeric suffix of bucket name |
| `COS_ALLOW_PREFIX` | `image-history/*` |
| `DURATION_SECONDS` | `1800` |

## Response shape

```json
{
  "credentials": { "tmpSecretId": "...", "tmpSecretKey": "...", "sessionToken": "..." },
  "startTime": 1733300000,
  "expiredTime": 1733301800,
  "bucket": "image-master-1345773498",
  "region": "ap-guangzhou"
}
```

## Rebuild the zip

```powershell
cd serverless/sts-cos
npm install --omit=dev
Compress-Archive -Path index.js,package.json,node_modules -DestinationPath sts-cos.zip -Force
```
