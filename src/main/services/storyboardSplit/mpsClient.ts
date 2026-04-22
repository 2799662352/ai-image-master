import { getCredentials, onCredentialsInvalidated } from './config'
import type { SplitConfig, SplitResult } from '../../../types/storyboardSplit'
import { getPresignedUrl } from './cosClient'

let MpsClientClass: any = null
let mpsInstance: any = null

onCredentialsInvalidated(() => { mpsInstance = null })

function getMpsClient() {
  if (!mpsInstance) {
    const creds = getCredentials()
    if (!MpsClientClass) {
      const sdk = require('tencentcloud-sdk-nodejs-mps')
      MpsClientClass = sdk.mps.v20190612.Client
    }
    mpsInstance = new MpsClientClass({
      credential: {
        secretId: creds.secretId,
        secretKey: creds.secretKey,
      },
      region: creds.region,
      profile: {
        signMethod: 'TC3-HMAC-SHA256',
        httpProfile: { reqMethod: 'POST', reqTimeout: 30 },
      },
    })
  }
  return mpsInstance
}

export async function submitProcessImage(
  presignedUrl: string,
  config: SplitConfig,
  outputDir: string
): Promise<string> {
  const creds = getCredentials()
  const client = getMpsClient()

  const stdExtInfo: Record<string, any> = {
    StoryboardConfig: {
      ModelSamplingAuraFlow: config.modelSamplingAuraFlow,
    },
  }
  if (config.processIndex !== undefined) {
    stdExtInfo.StoryboardConfig.ProcessIndex = config.processIndex
  }

  const resp = await client.ProcessImage({
    InputInfo: {
      Type: 'URL',
      UrlInputInfo: { Url: presignedUrl },
    },
    OutputStorage: {
      Type: 'COS',
      CosOutputStorage: {
        Bucket: creds.bucket,
        Region: creds.region,
      },
    },
    OutputDir: outputDir,
    ScheduleId: config.scheduleId,
    StdExtInfo: JSON.stringify(stdExtInfo),
  })

  return resp.TaskId
}

const SEVEN_DAYS_S = 7 * 24 * 60 * 60

export async function pollUntilFinish(
  taskId: string,
  onProgress: (attempt: number, maxAttempts: number) => void,
  abortSignal: { aborted: boolean },
  intervalMs = 2000,
  maxAttempts = 60
): Promise<SplitResult[]> {
  const client = getMpsClient()

  for (let i = 0; i < maxAttempts; i++) {
    if (abortSignal.aborted) throw new Error('Task cancelled')

    const resp = await client.DescribeImageTaskDetail({ TaskId: taskId })
    onProgress(i, maxAttempts)

    if (resp.Status === 'FINISH') {
      if (resp.ErrCode && resp.ErrCode !== 0) {
        const err: any = new Error(resp.ErrMsg || `MPS error: ${resp.ErrCode}`)
        err.code = String(resp.ErrCode)
        throw err
      }

      const resultSet = resp.ImageProcessTaskResultSet || []
      const results: SplitResult[] = await Promise.all(
        resultSet.map(async (r: any, idx: number) => {
          const cosPath = (r.Output?.Path || '').replace(/^\//, '')
          const url = await getPresignedUrl(cosPath, SEVEN_DAYS_S)
          return {
            index: idx,
            url,
            cosPath,
            expiresAt: Date.now() + SEVEN_DAYS_S * 1000,
          }
        })
      )
      return results
    }

    if (resp.Status === 'FAIL' || (resp.ErrCode && resp.ErrCode !== 0)) {
      const err: any = new Error(resp.ErrMsg || resp.Message || `MPS task failed: ${resp.Status}`)
      err.code = String(resp.ErrCode || '')
      throw err
    }

    await new Promise((r) => setTimeout(r, intervalMs))
  }

  throw new Error('轮询超时，MPS 任务未在 2 分钟内完成')
}
