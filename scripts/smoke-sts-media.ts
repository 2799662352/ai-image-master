// 冒烟:验证 scope=media STS 票据在真实 MPS / COS 上的有效权限。
// 运行: pnpm exec tsx scripts/smoke-sts-media.ts
// 通过标准:
//   1. STS 端点发 media 票据(bucket=map-tiles-*)
//   2. MPS DescribeTaskDetail 用临时密钥+token 调用 → 返回业务错误
//      (InvalidParameterValue/ResourceNotFound 均可)而非鉴权错误
//   3. COS putObject → 删除 在 smart-erase/ 前缀成功
import COS from 'cos-nodejs-sdk-v5'
import { mps } from 'tencentcloud-sdk-nodejs-mps'

const ENDPOINT = process.env.COS_STS_ENDPOINT || 'https://1345773498-bfu1wpfnrt.ap-guangzhou.tencentscf.com'

async function main(): Promise<void> {
  // 1. 取 media 票据
  const res = await fetch(`${ENDPOINT}?scope=media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: 'media' }),
  })
  if (!res.ok) throw new Error(`STS endpoint HTTP ${res.status}`)
  const data = (await res.json()) as any
  const c = data.credentials
  if (!c?.tmpSecretId) throw new Error(`no credentials: ${JSON.stringify(data)}`)
  console.log(`[1/3] STS OK  scope=${data.scope} bucket=${data.bucket} region=${data.region}`)

  // 2. MPS 权限探测(bogus TaskId:权限过 → 业务错;权限缺 → 鉴权错)
  const MpsClient = (mps as any).v20190612.Client
  const mpsClient = new MpsClient({
    credential: { secretId: c.tmpSecretId, secretKey: c.tmpSecretKey, token: c.sessionToken },
    region: data.region,
    profile: { signMethod: 'TC3-HMAC-SHA256', httpProfile: { reqMethod: 'POST', reqTimeout: 30 } },
  })
  try {
    await mpsClient.DescribeTaskDetail({ TaskId: 'smoke-bogus-task-id' })
    console.log('[2/3] MPS OK  (unexpected success on bogus id, but auth passed)')
  } catch (err: any) {
    const code = String(err?.code || err?.message || err)
    if (/AuthFailure|UnauthorizedOperation|Unauthorized/i.test(code)) {
      throw new Error(`MPS AUTH FAILED: ${code} — SCF 子账号缺 MPS 权限,去 CAM 加`)
    }
    console.log(`[2/3] MPS OK  (business error as expected: ${code})`)
  }

  // 3. COS 写+删 探测
  const cos = new (COS as any)({
    SecretId: c.tmpSecretId,
    SecretKey: c.tmpSecretKey,
    SecurityToken: c.sessionToken,
    Protocol: 'https:',
  })
  const Key = `smart-erase/smoke-${Date.now()}/probe.txt`
  await new Promise<void>((resolve, reject) => {
    cos.putObject(
      { Bucket: data.bucket, Region: data.region, Key, Body: Buffer.from('sts-media-smoke') },
      (err: any) => (err ? reject(new Error(`COS PUT FAILED: ${err.code || err.message}`)) : resolve()),
    )
  })
  await new Promise<void>((resolve, reject) => {
    cos.deleteMultipleObject(
      { Bucket: data.bucket, Region: data.region, Objects: [{ Key }], Quiet: true },
      (err: any) => (err ? reject(new Error(`COS DELETE FAILED: ${err.code || err.message}`)) : resolve()),
    )
  })
  console.log(`[3/3] COS OK  put+delete ${Key}`)
  console.log('SMOKE_ALL_PASS')
}

main().catch((err) => {
  console.error('SMOKE_FAIL:', err?.message || err)
  process.exit(1)
})
