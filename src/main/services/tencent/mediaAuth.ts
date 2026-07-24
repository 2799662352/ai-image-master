// src/main/services/tencent/mediaAuth.ts
//
// Unified credential resolution for the media features (智能去字幕 smartErase /
// 分镜切图 storyboardSplit):
//
//   1. Permanent credentials (settings → .env → optional local file) win when
//      the user filled them — full control over bucket/region, original
//      behavior unchanged.
//   2. Otherwise fall back to short-lived STS tokens from the SCF endpoint
//      (scope=media): zero user configuration, permanent key never ships.
//
// Callers get a discriminated union so COS/MPS clients can attach the session
// token only in STS mode.

import { getCredentials } from './credentials'
import { getMediaStsCredentials } from './stsCredentials'

export type MediaAuth =
  | {
      mode: 'permanent'
      secretId: string
      secretKey: string
      bucket: string
      region: string
    }
  | {
      mode: 'sts'
      secretId: string
      secretKey: string
      sessionToken: string
      expiredTime: number
      bucket: string
      region: string
    }

/** True when the user configured a permanent key (settings/.env/local file). */
export function hasPermanentCredentials(): boolean {
  return Boolean(getCredentials().secretId)
}

/**
 * Resolve the credentials + target bucket/region for a media operation.
 * Permanent first; STS media scope otherwise. Throws when neither works —
 * callers surface that as the normal "task failed" path.
 */
export async function getMediaAuth(): Promise<MediaAuth> {
  const creds = getCredentials()
  if (creds.secretId && creds.secretKey) {
    return {
      mode: 'permanent',
      secretId: creds.secretId,
      secretKey: creds.secretKey,
      bucket: creds.bucket,
      region: creds.region,
    }
  }
  const sts = await getMediaStsCredentials()
  return {
    mode: 'sts',
    secretId: sts.tmpSecretId,
    secretKey: sts.tmpSecretKey,
    sessionToken: sts.sessionToken,
    expiredTime: sts.expiredTime,
    bucket: sts.bucket,
    region: sts.region,
  }
}
