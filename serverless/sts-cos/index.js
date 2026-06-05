'use strict'

// Tencent SCF function: issue short-lived STS credentials scoped to
// uploading image-history objects into the COS image bucket.
//
// The permanent sub-account key lives ONLY in this function's environment
// variables (TENCENT_SECRET_ID / TENCENT_SECRET_KEY) and is never shipped to
// the client. Clients call this endpoint, receive a 30-minute token that can
// ONLY PutObject under `image-history/*`, and upload directly to COS.

const STS = require('qcloud-cos-sts')

const REGION = process.env.COS_REGION || 'ap-guangzhou'
const BUCKET = process.env.COS_BUCKET || 'image-master-1345773498'
// APPID is the numeric suffix of the bucket name.
const APPID = process.env.COS_APPID || BUCKET.slice(BUCKET.lastIndexOf('-') + 1)
const ALLOW_PREFIX = process.env.COS_ALLOW_PREFIX || 'image-history/*'
const DURATION = Number(process.env.DURATION_SECONDS || 1800)

const policy = {
  version: '2.0',
  statement: [
    {
      effect: 'allow',
      action: [
        'name/cos:PutObject',
        'name/cos:PostObject',
        'name/cos:InitiateMultipartUpload',
        'name/cos:ListMultipartUploads',
        'name/cos:ListParts',
        'name/cos:UploadPart',
        'name/cos:CompleteMultipartUpload',
        'name/cos:AbortMultipartUpload',
      ],
      resource: [`qcs::cos:${REGION}:uid/${APPID}:${BUCKET}/${ALLOW_PREFIX}`],
    },
  ],
}

function buildResponse(statusCode, bodyObj) {
  return {
    isBase64Encoded: false,
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,X-App-Token',
    },
    body: JSON.stringify(bodyObj),
  }
}

exports.main_handler = async (event) => {
  const method = (event && (event.httpMethod || event.requestContext?.httpMethod)) || 'GET'
  if (method === 'OPTIONS') {
    return buildResponse(200, { ok: true })
  }

  // Optional shared-secret gate. Set APP_TOKEN env var to require callers to
  // send a matching `X-App-Token` header. Raises the bar against random abuse
  // of this public endpoint; the token only guards a minimal PutObject scope.
  const appToken = process.env.APP_TOKEN
  if (appToken) {
    const headers = event.headers || {}
    const provided = headers['x-app-token'] || headers['X-App-Token']
    if (provided !== appToken) {
      return buildResponse(403, { error: 'forbidden' })
    }
  }

  const secretId = process.env.TENCENT_SECRET_ID
  const secretKey = process.env.TENCENT_SECRET_KEY
  if (!secretId || !secretKey) {
    return buildResponse(500, { error: 'server credentials not configured' })
  }

  try {
    const data = await new Promise((resolve, reject) => {
      STS.getCredential(
        { secretId, secretKey, policy, durationSeconds: DURATION },
        (err, credential) => (err ? reject(err) : resolve(credential)),
      )
    })

    return buildResponse(200, {
      credentials: data.credentials,
      startTime: data.startTime,
      expiredTime: data.expiredTime,
      bucket: BUCKET,
      region: REGION,
    })
  } catch (err) {
    return buildResponse(500, { error: String((err && err.message) || err) })
  }
}
