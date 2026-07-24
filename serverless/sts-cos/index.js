'use strict'

// Tencent SCF function: issue short-lived STS credentials for the desktop app.
//
// The permanent sub-account key lives ONLY in this function's environment
// variables (TENCENT_SECRET_ID / TENCENT_SECRET_KEY) and is never shipped to
// the client. Clients call this endpoint and receive a 30-minute token whose
// power depends on the requested `scope`:
//
//   scope=image-history (default, back-compat)
//     PutObject-only under `image-history/*` in the image bucket. Used by the
//     history-image upload path.
//
//   scope=media
//     Read/write/delete under `smart-erase/*` + `storyboard-split/*` in the
//     media bucket, PLUS the MPS submit/poll actions. Lets the 智能去字幕 /
//     分镜切图 features run with ZERO user-provided keys.
//
// The `scope` is read from the query string (?scope=media) or a JSON body
// ({"scope":"media"}). Unknown scopes are rejected.

const STS = require('qcloud-cos-sts')

const REGION = process.env.COS_REGION || 'ap-guangzhou'
const BUCKET = process.env.COS_BUCKET || 'image-master-1345773498'
// APPID is the numeric suffix of the bucket name.
const APPID = process.env.COS_APPID || BUCKET.slice(BUCKET.lastIndexOf('-') + 1)
const ALLOW_PREFIX = process.env.COS_ALLOW_PREFIX || 'image-history/*'
const DURATION = Number(process.env.DURATION_SECONDS || 1800)

// Media scope (智能去字幕 / 分镜切图): its own bucket + prefixes.
const MEDIA_BUCKET = process.env.MEDIA_BUCKET || 'map-tiles-bucket-1345773498'
const MEDIA_APPID =
  process.env.MEDIA_APPID || MEDIA_BUCKET.slice(MEDIA_BUCKET.lastIndexOf('-') + 1)
const MEDIA_ALLOW_PREFIXES = (
  process.env.MEDIA_ALLOW_PREFIXES || 'smart-erase/*,storyboard-split/*'
)
  .split(',')
  .map((p) => p.trim())
  .filter(Boolean)

const imageHistoryPolicy = {
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

const mediaPolicy = {
  version: '2.0',
  statement: [
    {
      effect: 'allow',
      action: [
        'name/cos:PutObject',
        'name/cos:PostObject',
        'name/cos:GetObject',
        'name/cos:HeadObject',
        'name/cos:DeleteObject',
        'name/cos:DeleteMultipleObjects',
        'name/cos:InitiateMultipartUpload',
        'name/cos:ListMultipartUploads',
        'name/cos:ListParts',
        'name/cos:UploadPart',
        'name/cos:CompleteMultipartUpload',
        'name/cos:AbortMultipartUpload',
      ],
      resource: MEDIA_ALLOW_PREFIXES.map(
        (prefix) => `qcs::cos:${REGION}:uid/${MEDIA_APPID}:${MEDIA_BUCKET}/${prefix}`,
      ),
    },
    {
      // MPS submit + poll. MPS tasks are not COS-resource scoped, so the
      // resource is `*`; power is still bounded by the explicit action list
      // and the 30-minute lifetime.
      effect: 'allow',
      action: [
        'name/mps:ProcessMedia',
        'name/mps:ProcessImage',
        'name/mps:DescribeTaskDetail',
        'name/mps:DescribeImageTaskDetail',
      ],
      resource: ['*'],
    },
  ],
}

const SCOPES = {
  'image-history': { policy: imageHistoryPolicy, bucket: BUCKET, region: REGION },
  media: { policy: mediaPolicy, bucket: MEDIA_BUCKET, region: REGION },
}

function parseScope(event) {
  const fromQuery =
    (event && event.queryString && event.queryString.scope) ||
    (event && event.queryStringParameters && event.queryStringParameters.scope)
  if (fromQuery) return String(fromQuery)
  try {
    const body = event && event.body ? JSON.parse(event.body) : null
    if (body && body.scope) return String(body.scope)
  } catch {
    /* non-JSON body → fall through to default */
  }
  return 'image-history'
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
  // of this public endpoint.
  const appToken = process.env.APP_TOKEN
  if (appToken) {
    const headers = event.headers || {}
    const provided = headers['x-app-token'] || headers['X-App-Token']
    if (provided !== appToken) {
      return buildResponse(403, { error: 'forbidden' })
    }
  }

  const scopeName = parseScope(event)
  const scope = SCOPES[scopeName]
  if (!scope) {
    return buildResponse(400, { error: `unknown scope: ${scopeName}` })
  }

  const secretId = process.env.TENCENT_SECRET_ID
  const secretKey = process.env.TENCENT_SECRET_KEY
  if (!secretId || !secretKey) {
    return buildResponse(500, { error: 'server credentials not configured' })
  }

  try {
    const data = await new Promise((resolve, reject) => {
      STS.getCredential(
        { secretId, secretKey, policy: scope.policy, durationSeconds: DURATION },
        (err, credential) => (err ? reject(err) : resolve(credential)),
      )
    })

    return buildResponse(200, {
      credentials: data.credentials,
      startTime: data.startTime,
      expiredTime: data.expiredTime,
      bucket: scope.bucket,
      region: scope.region,
      scope: scopeName,
    })
  } catch (err) {
    return buildResponse(500, { error: String((err && err.message) || err) })
  }
}
