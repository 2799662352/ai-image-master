// 端到端冒烟:免密钥(scope=media STS)票据下,真提交一个智能去字幕任务。
// 验证链:STS 票据 → COS 上传真视频 → ProcessMedia SmartEraseTask(模板 303,
// 系统预设·去字幕-至尊版)→ 轮询 DescribeTaskDetail 到终态 → 清理 COS。
//
// 回答的问题:「SCF 子账号(sts-image-history)+ media 票据到底能不能用
// 去字幕模板」。模板/编排是**主账号级资源**,子账号临时密钥跑在同一主账号
// (appid 1345773498)下,系统预设模板 303 理论可见 —— 这里实测拍死。
//
// 运行: pnpm exec tsx scripts/smoke-sts-erase-e2e.ts <本地小视频.mp4>
import fs from 'node:fs'
import COS from 'cos-nodejs-sdk-v5'
import { mps } from 'tencentcloud-sdk-nodejs-mps'

const ENDPOINT = process.env.COS_STS_ENDPOINT || 'https://1345773498-bfu1wpfnrt.ap-guangzhou.tencentscf.com'
const DEFINITION = 303 // 与 DEFAULT_ERASE_CONFIG.definitionId 一致
const POLL_BUDGET_MS = 6 * 60 * 1000

async function main(): Promise<void> {
  const videoPath = process.argv[2]
  if (!videoPath || !fs.existsSync(videoPath)) {
    throw new Error(`用法: tsx scripts/smoke-sts-erase-e2e.ts <本地小视频.mp4>(给的路径不存在: ${videoPath})`)
  }

  // 1. media 票据
  const res = await fetch(`${ENDPOINT}?scope=media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: 'media' }),
  })
  if (!res.ok) throw new Error(`STS endpoint HTTP ${res.status}`)
  const data = (await res.json()) as any
  const c = data.credentials
  if (!c?.tmpSecretId) throw new Error(`no credentials: ${JSON.stringify(data)}`)
  console.log(`[1/5] STS OK  bucket=${data.bucket} region=${data.region}`)

  const cos = new (COS as any)({
    SecretId: c.tmpSecretId,
    SecretKey: c.tmpSecretKey,
    SecurityToken: c.sessionToken,
    Protocol: 'https:',
  })
  const taskTag = `smoke-e2e-${Date.now()}`
  const inputKey = `smart-erase/${taskTag}/input/tiny.mp4`

  // 2. 上传真视频
  await new Promise<void>((resolve, reject) => {
    cos.putObject(
      { Bucket: data.bucket, Region: data.region, Key: inputKey, Body: fs.readFileSync(videoPath), ContentType: 'video/mp4' },
      (err: any) => (err ? reject(new Error(`COS PUT FAILED: ${err.code || err.message}`)) : resolve()),
    )
  })
  console.log(`[2/5] COS 上传 OK  ${inputKey}`)

  // 3. 真提交去字幕任务(模板 303)
  const MpsClient = (mps as any).v20190612.Client
  const mpsClient = new MpsClient({
    credential: { secretId: c.tmpSecretId, secretKey: c.tmpSecretKey, token: c.sessionToken },
    region: data.region,
    profile: { signMethod: 'TC3-HMAC-SHA256', httpProfile: { reqMethod: 'POST', reqTimeout: 30 } },
  })
  let mpsTaskId: string
  try {
    const resp = await mpsClient.ProcessMedia({
      InputInfo: { Type: 'COS', CosInputInfo: { Bucket: data.bucket, Region: data.region, Object: '/' + inputKey } },
      OutputStorage: { Type: 'COS', CosOutputStorage: { Bucket: data.bucket, Region: data.region } },
      OutputDir: `/smart-erase/${taskTag}/output/`,
      SmartEraseTask: { Definition: DEFINITION },
    })
    mpsTaskId = resp.TaskId
  } catch (err: any) {
    const code = String(err?.code || err?.message || err)
    if (/AuthFailure|Unauthorized/i.test(code)) {
      throw new Error(`提交被鉴权拒绝(子账号缺权限): ${code}`)
    }
    if (/Definition|Template/i.test(code)) {
      throw new Error(`模板 ${DEFINITION} 对该账号不可用: ${code}`)
    }
    throw new Error(`提交失败: ${code}`)
  }
  console.log(`[3/5] 提交 OK  TaskId=${mpsTaskId}(鉴权+模板 ${DEFINITION} 都收下了)`)

  // 4. 轮询到终态
  const deadline = Date.now() + POLL_BUDGET_MS
  let outputPath = ''
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000))
    const t = await mpsClient.DescribeTaskDetail({ TaskId: mpsTaskId })
    const eraseResult = t?.WorkflowTask?.SmartEraseTaskResult
    const progress = eraseResult?.Progress ?? '-'
    console.log(`      poll: Status=${t?.Status} erase=${eraseResult?.Status ?? '-'} progress=${progress}`)
    if (t?.Status !== 'FINISH') continue
    if (typeof t?.WorkflowTask?.ErrCode === 'number' && t.WorkflowTask.ErrCode !== 0) {
      throw new Error(`任务失败: ${t.WorkflowTask.ErrCode} ${t.WorkflowTask.Message ?? ''}`)
    }
    if (eraseResult?.Status === 'PROCESSING') continue
    if (eraseResult?.Status === 'FAIL') {
      throw new Error(`去字幕失败: ${eraseResult.ErrCodeExt ?? ''} ${eraseResult.Message ?? ''}`)
    }
    if (eraseResult?.Status === 'SUCCESS') {
      outputPath = String(eraseResult.Output?.Path ?? '')
      break
    }
  }
  if (!outputPath) {
    console.log(`[4/5] 超时未到终态 —— 但提交已成功,鉴权/模板结论不受影响。输入对象保留: ${inputKey}`)
    console.log('SMOKE_SUBMIT_PASS')
    return
  }
  console.log(`[4/5] 去字幕 SUCCESS  output=${outputPath}`)

  // 5. 清理输入+输出
  const outKey = outputPath.replace(/^\/+/, '')
  await new Promise<void>((resolve, reject) => {
    cos.deleteMultipleObject(
      { Bucket: data.bucket, Region: data.region, Objects: [{ Key: inputKey }, { Key: outKey }], Quiet: true },
      (err: any) => (err ? reject(new Error(`COS DELETE FAILED: ${err.code || err.message}`)) : resolve()),
    )
  })
  console.log(`[5/5] 清理 OK`)
  console.log('SMOKE_E2E_ALL_PASS')
}

main().catch((err) => {
  console.error('SMOKE_FAIL:', err?.message || err)
  process.exit(1)
})
