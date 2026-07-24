import { mps } from 'tencentcloud-sdk-nodejs-mps'
import { onCredentialsInvalidated } from './credentials'
import { getMediaAuth } from './mediaAuth'

let mpsInstance: any = null
// STS tokens expire; remember which expiry the cached client was built with so
// we can rebuild once the underlying token rotates. 0 = permanent-key client.
let builtWithExpiredTime = 0

onCredentialsInvalidated(() => {
  mpsInstance = null
  builtWithExpiredTime = 0
})

const REFRESH_SKEW_SECONDS = 300

function stsClientStale(): boolean {
  if (builtWithExpiredTime === 0) return false
  return builtWithExpiredTime - Math.floor(Date.now() / 1000) <= REFRESH_SKEW_SECONDS
}

/**
 * MPS client with the same permanent-first / STS-fallback resolution as COS
 * (see ./mediaAuth). Async because the STS path may need a network fetch;
 * permanent-key结果与旧同步版完全一致。
 */
export async function getMpsClient(): Promise<any> {
  if (!mpsInstance || stsClientStale()) {
    const auth = await getMediaAuth()
    const MpsClientClass = (mps as any).v20190612.Client
    mpsInstance = new MpsClientClass({
      credential: {
        secretId: auth.secretId,
        secretKey: auth.secretKey,
        ...(auth.mode === 'sts' ? { token: auth.sessionToken } : {}),
      },
      region: auth.region,
      profile: {
        signMethod: 'TC3-HMAC-SHA256',
        httpProfile: { reqMethod: 'POST', reqTimeout: 30 },
      },
    })
    builtWithExpiredTime = auth.mode === 'sts' ? auth.expiredTime : 0
  }
  return mpsInstance
}
