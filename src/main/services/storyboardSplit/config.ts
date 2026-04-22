import type { SplitConfig, CredentialState } from '../../../types/storyboardSplit'
import { DEFAULT_SPLIT_CONFIG } from '../../../types/storyboardSplit'

let Store: any
let credentialStore: any = null

interface Credentials {
  secretId: string
  secretKey: string
  bucket: string
  region: string
}

function getCredentialStore() {
  if (!credentialStore) {
    if (!Store) Store = require('electron-store')
    credentialStore = new Store({
      name: 'tencent-credentials',
      encryptionKey: 'tencent-cred-v1',
      defaults: {
        secretId: '',
        secretKey: '',
        bucket: '',
        region: 'ap-guangzhou',
      },
    })
  }
  return credentialStore
}

export function getCredentials(): Credentials {
  const store = getCredentialStore()
  const storeId = store.get('secretId') || ''
  const storeKey = store.get('secretKey') || ''
  const storeBucket = store.get('bucket') || ''
  const storeRegion = store.get('region') || ''

  return {
    secretId: storeId || process.env.COS_SECRET_ID || '',
    secretKey: storeKey || process.env.COS_SECRET_KEY || '',
    bucket: storeBucket || process.env.COS_BUCKET || process.env.COS_BUCKET_NAME || '',
    region: storeRegion || process.env.COS_REGION || 'ap-guangzhou',
  }
}

export function getCredentialState(): CredentialState {
  const store = getCredentialStore()
  const storeId = store.get('secretId') || ''
  const envId = process.env.COS_SECRET_ID || ''

  let source: CredentialState['credentialSource'] = 'none'
  let id = ''
  if (storeId) { source = 'store'; id = storeId }
  else if (envId) { source = 'env'; id = envId }

  return {
    hasCredentials: !!id,
    credentialSource: source,
    secretIdMasked: id ? `${id.slice(0, 4)}****` : undefined,
    bucket: getCredentials().bucket || undefined,
    region: getCredentials().region || undefined,
  }
}

export function setCredentials(creds: Partial<Credentials>): void {
  const store = getCredentialStore()
  if (creds.secretId !== undefined) store.set('secretId', creds.secretId)
  if (creds.secretKey !== undefined) store.set('secretKey', creds.secretKey)
  if (creds.bucket !== undefined) store.set('bucket', creds.bucket)
  if (creds.region !== undefined) store.set('region', creds.region)
}

let defaultConfig: SplitConfig = { ...DEFAULT_SPLIT_CONFIG }

export function getDefaultConfig(): SplitConfig {
  return { ...defaultConfig }
}

export function setDefaultConfig(config: SplitConfig): void {
  defaultConfig = { ...config }
}
