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

import { getCredentials, isLikelyValidSecretId } from './credentials'
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

let warnedInvalidKey = false

/** True when the user configured a *usable* permanent key (settings/.env/local file). */
export function hasPermanentCredentials(): boolean {
  return isLikelyValidSecretId(getCredentials().secretId)
}

/**
 * Resolve the credentials + target bucket/region for a media operation.
 * Permanent first; STS media scope otherwise. Throws when neither works —
 * callers surface that as the normal "task failed" path.
 *
 * 格式明显不对的永久密钥(非 AKID 开头,通常是用户误粘别家 key)会被
 * **忽略并降级到 STS 免密钥通道**——拿它去签名只会收到 COS
 * `InvalidAccessKeyId`,不如直接走可用的免密钥链路。
 */
export async function getMediaAuth(): Promise<MediaAuth> {
  const creds = getCredentials()
  if (creds.secretId && creds.secretKey && !isLikelyValidSecretId(creds.secretId)) {
    if (!warnedInvalidKey) {
      warnedInvalidKey = true
      console.warn(
        '[tencent/mediaAuth] 配置的 SecretId 不是合法腾讯云永久密钥格式(应为 AKID 开头),' +
          '已忽略并降级到免密钥 STS 通道。可在设置页清除或改正密钥。',
      )
    }
  } else if (creds.secretId && creds.secretKey) {
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
