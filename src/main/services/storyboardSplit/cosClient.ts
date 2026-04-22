import { getCredentials, onCredentialsInvalidated } from './config'

let COS: any = null
let cosInstance: any = null

onCredentialsInvalidated(() => { cosInstance = null })

function getCosInstance() {
  if (!cosInstance) {
    const creds = getCredentials()
    if (!COS) COS = require('cos-nodejs-sdk-v5')
    cosInstance = new COS({
      SecretId: creds.secretId,
      SecretKey: creds.secretKey,
      Protocol: 'https:',
      Timeout: 120000,
    })
  }
  return cosInstance
}

function getBucketAndRegion() {
  const creds = getCredentials()
  return { Bucket: creds.bucket, Region: creds.region }
}

export async function uploadOriginal(
  taskId: string,
  buffer: Buffer,
  ext: string
): Promise<string> {
  const cos = getCosInstance()
  const { Bucket, Region } = getBucketAndRegion()
  const key = `storyboard-split/${taskId}/input.${ext}`

  const contentTypeMap: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
  }

  await new Promise<void>((resolve, reject) => {
    cos.putObject(
      {
        Bucket,
        Region,
        Key: key,
        Body: buffer,
        ContentType: contentTypeMap[ext] || 'image/jpeg',
      },
      (err: any) => (err ? reject(err) : resolve())
    )
  })

  return key
}

export function getPresignedUrl(key: string, expireSeconds: number): Promise<string> {
  const cos = getCosInstance()
  const { Bucket, Region } = getBucketAndRegion()

  return new Promise((resolve, reject) => {
    cos.getObjectUrl(
      {
        Bucket,
        Region,
        Key: key,
        Sign: true,
        Expires: expireSeconds,
        Method: 'GET',
      },
      (err: any, data: any) => {
        if (err) return reject(err)
        resolve(data.Url)
      }
    )
  })
}
