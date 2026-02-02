# R2 云端上传优化 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 优化历史记录上传云端的速度，从串行上传改为并行+直传模式，预计提升 3-5 倍速度

**Architecture:** 
1. 阶段一：将 Base64 上传改为二进制流上传，减少 33% 传输量
2. 阶段二：实现 Presigned URL 直传，客户端直接上传到 R2，跳过 Worker 代理
3. 已完成：并行上传（4 并发）

**Tech Stack:** TypeScript, Cloudflare Workers, R2 Storage, AWS S3 SDK (aws4fetch)

---

## 当前架构分析

```
当前流程（慢）:
客户端 Base64 (+33%) → Worker 解码 → R2

优化后流程（快）:
客户端 Blob → Presigned URL → R2 直传
```

---

## Phase 1: 二进制流上传（客户端改造）

### Task 1: 添加 Blob 上传方法到 R2StorageService

**Files:**
- Modify: `src/renderer/src/services/r2-storage/R2StorageService.ts`

**Step 1: 添加 uploadBlob 方法**

在 `uploadBase64` 方法后添加新方法：

```typescript
/**
 * 上传 Blob/File 到 R2（比 Base64 快 33%）
 */
async uploadBlob(blob: Blob, metadata: UploadMetadata = {}): Promise<UploadResult> {
  await this.init()

  if (!this.isAvailable()) {
    return { success: false, error: 'R2 服务不可用' }
  }

  try {
    const { signature, timestamp, nonce } = this.generateSignature({
      type: 'upload',
      size: blob.size,
      contentType: blob.type
    })

    const formData = new FormData()
    formData.append('file', blob)
    formData.append('metadata', JSON.stringify({
      ...metadata,
      source: 'ai-image-master',
      uploadedAt: new Date().toISOString()
    }))

    const response = await fetch(`${this.workerUrl}/api/upload-blob`, {
      method: 'POST',
      headers: {
        'X-Signature': signature,
        'X-Timestamp': String(timestamp),
        'X-Nonce': nonce,
        'Origin': window.location.origin
      },
      body: formData
    })

    if (!response.ok) {
      return { success: false, error: `上传失败: ${response.status}` }
    }

    const result = await response.json()
    
    if (result.success && result.url) {
      console.log('✅ Blob 上传成功:', result.url)
      return {
        success: true,
        url: result.url,
        key: result.key
      }
    }

    return { success: false, error: result.error || '上传失败' }
  } catch (error) {
    console.error('❌ Blob 上传失败:', error)
    return { success: false, error: (error as Error).message }
  }
}
```

**Step 2: 添加 Base64 转 Blob 工具方法**

```typescript
/**
 * Base64 转 Blob
 */
private base64ToBlob(base64: string): Blob {
  const parts = base64.split(',')
  const mimeMatch = parts[0].match(/:(.*?);/)
  const mimeType = mimeMatch ? mimeMatch[1] : 'image/png'
  const byteString = atob(parts[1])
  const ab = new ArrayBuffer(byteString.length)
  const ia = new Uint8Array(ab)
  for (let i = 0; i < byteString.length; i++) {
    ia[i] = byteString.charCodeAt(i)
  }
  return new Blob([ab], { type: mimeType })
}
```

**Step 3: 修改 batchProcess 优先使用 Blob 上传**

```typescript
// 在 processUrl 函数中
if (url.startsWith('data:image')) {
  // 优先使用 Blob 上传（比 Base64 快 33%）
  const blob = this.base64ToBlob(url)
  const result = await this.uploadBlob(blob)
  if (result.success && result.url) {
    return { index, result: result.url }
  }
  // 回退到 Base64 上传
  const fallbackResult = await this.uploadBase64(url)
  if (fallbackResult.success && fallbackResult.url) {
    return { index, result: fallbackResult.url }
  }
}
```

**Step 4: 验证构建**

Run: `npm run build:vite`
Expected: 构建成功，无错误

**Step 5: Commit**

```bash
git add src/renderer/src/services/r2-storage/R2StorageService.ts
git commit -m "feat(r2): add blob upload method for 33% faster uploads"
```

---

### Task 2: Worker 端添加 Blob 上传 API

**Files:**
- Modify: R2 Worker (需要单独部署)

**注意:** 此任务需要访问 Cloudflare Worker 代码，如果 Worker 代码不在此项目中，需要单独处理。

**Step 1: 添加 /api/upload-blob 端点**

```typescript
// 在 Worker 中添加
case '/api/upload-blob': {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  // 验证签名
  const signature = request.headers.get('X-Signature')
  const timestamp = request.headers.get('X-Timestamp')
  const nonce = request.headers.get('X-Nonce')
  
  if (!verifySignature(signature, timestamp, nonce, env.AUTH_SECRET)) {
    return new Response('Unauthorized', { status: 401 })
  }

  const formData = await request.formData()
  const file = formData.get('file') as File
  const metadata = JSON.parse(formData.get('metadata') as string || '{}')

  if (!file) {
    return new Response(JSON.stringify({ success: false, error: 'No file provided' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  const key = `images/${Date.now()}-${crypto.randomUUID()}.${file.type.split('/')[1] || 'png'}`
  
  await env.R2_BUCKET.put(key, file.stream(), {
    httpMetadata: {
      contentType: file.type
    },
    customMetadata: metadata
  })

  const url = `${env.PUBLIC_URL}/${key}`
  
  return new Response(JSON.stringify({
    success: true,
    url,
    key
  }), {
    headers: { 'Content-Type': 'application/json' }
  })
}
```

---

## Phase 2: Presigned URL 直传（可选，进一步优化）

### Task 3: Worker 端添加 Presigned URL 生成 API

**Files:**
- Modify: R2 Worker

**Step 1: 安装 aws4fetch**

```bash
npm install aws4fetch
```

**Step 2: 添加 /api/presign-upload 端点**

```typescript
import { AwsClient } from 'aws4fetch'

// 在 Worker 中添加
case '/api/presign-upload': {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  // 验证签名...

  const { contentType, filename } = await request.json()
  
  const key = `images/${Date.now()}-${crypto.randomUUID()}-${filename || 'image.png'}`
  
  const client = new AwsClient({
    service: 's3',
    region: 'auto',
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  })

  const r2Url = `https://${env.ACCOUNT_ID}.r2.cloudflarestorage.com/${env.BUCKET_NAME}/${key}`
  
  const signedRequest = await client.sign(
    new Request(r2Url + '?X-Amz-Expires=3600', {
      method: 'PUT',
      headers: {
        'Content-Type': contentType || 'image/png',
      },
    }),
    { aws: { signQuery: true } }
  )

  return new Response(JSON.stringify({
    success: true,
    uploadUrl: signedRequest.url,
    key,
    publicUrl: `${env.PUBLIC_URL}/${key}`
  }), {
    headers: { 'Content-Type': 'application/json' }
  })
}
```

---

### Task 4: 客户端添加 Presigned URL 上传方法

**Files:**
- Modify: `src/renderer/src/services/r2-storage/R2StorageService.ts`

**Step 1: 添加 getPresignedUrl 方法**

```typescript
/**
 * 获取 Presigned URL 用于直传
 */
async getPresignedUrl(contentType: string, filename?: string): Promise<{
  success: boolean
  uploadUrl?: string
  publicUrl?: string
  error?: string
}> {
  await this.init()

  if (!this.isAvailable()) {
    return { success: false, error: 'R2 服务不可用' }
  }

  try {
    const { signature, timestamp, nonce } = this.generateSignature({
      type: 'presign',
      contentType
    })

    const response = await fetch(`${this.workerUrl}/api/presign-upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Signature': signature,
        'X-Timestamp': String(timestamp),
        'X-Nonce': nonce,
        'Origin': window.location.origin
      },
      body: JSON.stringify({ contentType, filename })
    })

    if (!response.ok) {
      return { success: false, error: `获取上传 URL 失败: ${response.status}` }
    }

    return await response.json()
  } catch (error) {
    console.error('获取 Presigned URL 失败:', error)
    return { success: false, error: (error as Error).message }
  }
}
```

**Step 2: 添加 uploadWithPresignedUrl 方法**

```typescript
/**
 * 使用 Presigned URL 直传到 R2（最快）
 */
async uploadWithPresignedUrl(blob: Blob): Promise<UploadResult> {
  const presignResult = await this.getPresignedUrl(blob.type)
  
  if (!presignResult.success || !presignResult.uploadUrl) {
    console.warn('Presigned URL 获取失败，回退到普通上传')
    return this.uploadBlob(blob)
  }

  try {
    const response = await fetch(presignResult.uploadUrl, {
      method: 'PUT',
      body: blob,
      headers: {
        'Content-Type': blob.type
      }
    })

    if (response.ok) {
      console.log('✅ Presigned URL 直传成功:', presignResult.publicUrl)
      return {
        success: true,
        url: presignResult.publicUrl
      }
    }

    // 回退到普通上传
    console.warn('Presigned URL 上传失败，回退')
    return this.uploadBlob(blob)
  } catch (error) {
    console.error('Presigned URL 上传失败:', error)
    return this.uploadBlob(blob)
  }
}
```

**Step 3: 更新 batchProcess 使用最优方法**

```typescript
// 上传优先级：Presigned URL > Blob > Base64
if (url.startsWith('data:image')) {
  const blob = this.base64ToBlob(url)
  
  // 1. 尝试 Presigned URL 直传（最快）
  const presignResult = await this.uploadWithPresignedUrl(blob)
  if (presignResult.success && presignResult.url) {
    return { index, result: presignResult.url }
  }
}
```

**Step 4: 验证构建**

Run: `npm run build:vite`
Expected: 构建成功

**Step 5: Commit**

```bash
git add src/renderer/src/services/r2-storage/R2StorageService.ts
git commit -m "feat(r2): add presigned URL direct upload for 3x speed improvement"
```

---

## 验证清单

- [ ] Phase 1 完成后：上传速度提升约 33%
- [ ] Phase 2 完成后：上传速度提升约 3x
- [ ] 所有现有功能正常工作
- [ ] 历史记录上传状态正确显示
- [ ] 错误处理和回退机制正常

---

## 依赖关系

```
Task 1 (客户端 Blob) ←─── 可独立实现
        │
        └──→ Task 2 (Worker Blob API) ←─── 需要部署 Worker
        
Task 3 (Worker Presigned) ←─── 需要部署 Worker
        │
        └──→ Task 4 (客户端 Presigned) ←─── 依赖 Task 3
```

---

## 注意事项

1. **Worker 代码位置**: 如果 R2 Worker 代码不在此项目中，Task 2 和 Task 3 需要单独处理
2. **回退机制**: 所有新方法都有回退到旧方法的逻辑，确保兼容性
3. **CORS**: Presigned URL 直传需要 R2 Bucket 配置正确的 CORS 策略
