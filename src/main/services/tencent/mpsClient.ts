import { mps } from 'tencentcloud-sdk-nodejs-mps'
import { getCredentials, onCredentialsInvalidated } from './credentials'

let mpsInstance: any = null

onCredentialsInvalidated(() => { mpsInstance = null })

export function getMpsClient(): any {
  if (!mpsInstance) {
    const creds = getCredentials()
    const MpsClientClass = (mps as any).v20190612.Client
    mpsInstance = new MpsClientClass({
      credential: { secretId: creds.secretId, secretKey: creds.secretKey },
      region: creds.region,
      profile: {
        signMethod: 'TC3-HMAC-SHA256',
        httpProfile: { reqMethod: 'POST', reqTimeout: 30 },
      },
    })
  }
  return mpsInstance
}
