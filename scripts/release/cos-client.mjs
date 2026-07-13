import { createHash } from 'node:crypto'
import { Writable } from 'node:stream'

import COS from 'cos-nodejs-sdk-v5'

const CHANNEL_MANIFESTS = ['latest.yml', 'beta.yml', 'alpha.yml']

function header(headers, name) {
  const expected = name.toLowerCase()
  const entry = Object.entries(headers ?? {}).find(
    ([key]) => key.toLowerCase() === expected,
  )
  return entry?.[1] ?? null
}

function isNotFound(error) {
  return (
    error?.statusCode === 404 ||
    error?.code === 'NoSuchKey' ||
    error?.code === 'NotFound'
  )
}

function encodedObjectPath(key) {
  return key.split('/').map(encodeURIComponent).join('/')
}

export class CosClientAdapter {
  constructor({ secretId, secretKey, bucket, region, prefix }) {
    if (!secretId || !secretKey || !bucket || !region || !prefix) {
      throw new Error('COS credentials, bucket, region, and prefix are required')
    }
    this.bucket = bucket
    this.region = region
    this.prefix = prefix.replace(/^\/+|\/+$/g, '')
    this.cos = new COS({ SecretId: secretId, SecretKey: secretKey })
    this.allowedChannelKeys = new Set(
      CHANNEL_MANIFESTS.map((name) => `${this.prefix}/${name}`),
    )
  }

  params(key) {
    return {
      Bucket: this.bucket,
      Region: this.region,
      Key: key,
    }
  }

  async getBucketVersioning() {
    const result = await this.cos.getBucketVersioning({
      Bucket: this.bucket,
      Region: this.region,
    })
    return result.VersioningConfiguration?.Status ?? null
  }

  async checkReadAccess() {
    for (const channelName of CHANNEL_MANIFESTS) {
      await this.headObject(`${this.prefix}/${channelName}`)
    }
  }

  async listVersions() {
    const prefixes = []
    let marker
    do {
      const result = await this.cos.getBucket({
        Bucket: this.bucket,
        Region: this.region,
        Prefix: `${this.prefix}/versions/`,
        Delimiter: '/',
        MaxKeys: 1000,
        ...(marker ? { Marker: marker } : {}),
      })
      prefixes.push(...(result.CommonPrefixes ?? []))
      const truncated =
        String(result.IsTruncated).toLowerCase() === 'true'
      marker = truncated ? result.NextMarker : null
      if (truncated && !marker) {
        throw new Error('COS version listing was truncated without NextMarker')
      }
    } while (marker)

    return prefixes
      .map((entry) => entry.Prefix)
      .filter((value) => typeof value === 'string')
      .map((value) => value.replace(/\/$/, '').split('/').at(-1))
      .filter(Boolean)
  }

  async headObject(key) {
    try {
      const result = await this.cos.headObject(this.params(key))
      const contentLength = header(result.headers, 'content-length')
      return {
        size: contentLength === null ? null : Number(contentLength),
        sha256: header(result.headers, 'x-cos-meta-sha256'),
        crc64: header(result.headers, 'x-cos-hash-crc64ecma'),
        cacheControl: header(result.headers, 'cache-control'),
        contentType: header(result.headers, 'content-type'),
      }
    } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
  }

  async getObject(key) {
    try {
      const result = await this.cos.getObject(this.params(key))
      return Buffer.isBuffer(result.Body) ? result.Body : Buffer.from(result.Body)
    } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
  }

  async hashObject(key, algorithm) {
    const hash = createHash(algorithm)
    const output = new Writable({
      write(chunk, _encoding, callback) {
        hash.update(chunk)
        callback()
      },
    })
    try {
      await this.cos.getObject({ ...this.params(key), Output: output })
      return hash.digest('hex')
    } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
  }

  async putImmutableObject(input) {
    const common = {
      ...this.params(input.key),
      CacheControl: input.cacheControl,
      ContentType: input.contentType,
      Headers: {
        'x-cos-forbid-overwrite': 'true',
      },
      'x-cos-meta-sha256': input.metadata.sha256,
      'x-cos-meta-crc64ecma': input.metadata.crc64ecma,
    }

    if (input.filePath) {
      return this.cos.sliceUploadFile({
        ...common,
        FilePath: input.filePath,
        SliceSize: 5 * 1024 * 1024,
      })
    }
    return this.cos.putObject({
      ...common,
      Body: input.body,
      ContentLength: input.size,
    })
  }

  async copyObject(input) {
    return this.cos.putObjectCopy({
      ...this.params(input.targetKey),
      CopySource: `${this.bucket}.cos.${this.region}.myqcloud.com/${encodedObjectPath(input.sourceKey)}`,
      MetadataDirective: input.metadataDirective,
      CacheControl: input.cacheControl,
      ContentType: input.contentType,
    })
  }

  assertAllowedChannelKey(key) {
    if (!this.allowedChannelKeys.has(key)) {
      throw new Error(`Refusing mutable COS operation outside channel keys: ${key}`)
    }
  }

  async putChannelObject(input) {
    this.assertAllowedChannelKey(input.key)
    return this.cos.putObject({
      ...this.params(input.key),
      Body: input.body,
      ContentLength: input.body.length,
      CacheControl: input.cacheControl,
      ContentType: input.contentType,
    })
  }

  async deleteObject(key) {
    this.assertAllowedChannelKey(key)
    return this.cos.deleteObject(this.params(key))
  }
}
