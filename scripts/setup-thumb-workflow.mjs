#!/usr/bin/env node
/**
 * setup-thumb-workflow — 在 image-history 桶上配一条数据万象**工作流**:上传即自动
 * 出 512 / 1024 两档 WebP 缩略图,存回原图旁边(服务端触发,客户端不用带任何头)。
 *
 * 与主进程的 `Pic-Operations`(cosThumbRules.ts)是同一套命名约定
 * (`<key>.thumb512.webp` / `.thumb1024.webp`),两条路写同一个对象、内容相同:
 *   - Pic-Operations:上传返回时缩略图就在(同步),但只覆盖新版本客户端;
 *   - 工作流:异步几秒,但覆盖**所有**客户端(老版本也算),将来回填老图也走它
 *     (`CreateInventoryTriggerJob`,本脚本不做 —— 用户拍板「老图回填先不做」)。
 *
 * 防死循环:工作流输出物是 .webp;Start 节点的 ExtFilter 用自定义后缀白名单且**不含
 * webp**,输出物落桶时不会再次触发。代价是 image/webp 原图不走工作流(新客户端仍由
 * Pic-Operations 覆盖,老客户端的 webp 原图回落实时 imageMogr2)。
 *
 * 用法:
 *   node scripts/setup-thumb-workflow.mjs --dry-run                  只打印将要提交的 XML
 *   node scripts/setup-thumb-workflow.mjs --prefix image-history/_probe/ --name catimation-thumbs-probe
 *                                                                    先在探针前缀上验证
 *   node scripts/setup-thumb-workflow.mjs                            正式:prefix image-history/,Active
 *   node scripts/setup-thumb-workflow.mjs --state Paused             暂停(不删)
 *   node scripts/setup-thumb-workflow.mjs --delete --name <name>     删除同名工作流(模板保留)
 *   node scripts/setup-thumb-workflow.mjs --show                     打印当前模板与工作流
 *
 * 需要 .env 里的 COS_SECRET_ID / COS_SECRET_KEY(永久密钥,需有 ci 模板/工作流管理权限)。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
try {
  require('dotenv').config({ path: path.join(REPO_ROOT, '.env') })
} catch {
  // dotenv 可选
}
const COS = require('cos-nodejs-sdk-v5')

const args = process.argv.slice(2)
const flag = (n) => args.includes(n)
const opt = (n, fb) => {
  const i = args.indexOf(n)
  return i >= 0 && args[i + 1] ? args[i + 1] : fb
}
const dryRun = flag('--dry-run')
const show = flag('--show')
const del = flag('--delete')
const Bucket = opt('--bucket', process.env.COS_IMAGE_HISTORY_BUCKET || 'image-master-1345773498')
const Region = opt('--region', process.env.COS_IMAGE_HISTORY_REGION || 'ap-guangzhou')
const Prefix = opt('--prefix', 'image-history/')
const Name = opt('--name', 'catimation-image-thumbs')
const State = opt('--state', 'Active')

const SecretId = process.env.COS_SECRET_ID
const SecretKey = process.env.COS_SECRET_KEY
if (!SecretId || !SecretKey) {
  console.error('❌ Missing COS_SECRET_ID / COS_SECRET_KEY')
  process.exit(1)
}
const Proxy = process.env.COS_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || undefined
const cos = new COS({ SecretId, SecretKey, Protocol: 'https:', Timeout: 60000, ...(Proxy ? { Proxy } : {}) })
const CI_HOST = `https://${Bucket}.ci.${Region}.myqcloud.com`

// 与 cosThumbRules.ts / renderer/utils/cosThumb.ts 一致 —— 改了三处一起改。
const SIZES = [512, 1024]
const templateName = (size) => `catimation-thumb-${size}`
const thumbRule = (size) => `imageMogr2/thumbnail/${size}x${size}>/format/webp/quality/85`
// 不含 webp:输出物是 .webp,靠这个白名单不再触发自己。最多 10 个后缀(官方限制)。
const TRIGGER_EXTS = 'png/jpg/jpeg/gif/bmp/avif/heic/heif/tif/tiff'

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function ci(method, pathname, { query, body } = {}) {
  return new Promise((resolve, reject) => {
    cos.request(
      {
        Bucket,
        Region,
        Method: method,
        Key: pathname.replace(/^\//, ''),
        Url: `${CI_HOST}${pathname}`,
        ...(query ? { Query: query } : {}),
        ...(body ? { Body: body, ContentType: 'application/xml' } : {}),
      },
      (err, data) => (err ? reject(err) : resolve(data)),
    )
  })
}

const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v])

/**
 * 模板 / 工作流属于「媒体处理」服务,桶只绑了「图片处理」时会回
 * `400 MediaBucketUnBinded`。`POST /mediabucket` 等价于控制台的「开通媒体处理」
 * (空请求体,建队列并绑定万象;开通本身不计费,任务按功能计费)。幂等:已开通直接返回。
 */
async function ensureMediaBucket() {
  const data = await ci('GET', '/mediabucket', { query: { bucketNames: Bucket, pageSize: '10' } })
  const list = asList(data?.Response?.MediaBucketList ?? data?.MediaBucketList)
  if (list.some((b) => b?.Name === Bucket || b?.BucketId === Bucket)) {
    console.log('   media processing: already enabled on this bucket')
    return
  }
  if (dryRun) return console.log('   [dry-run] POST /mediabucket (enable media processing)')
  const res = await ci('POST', '/mediabucket')
  const mb = res?.Response?.MediaBucket ?? res?.MediaBucket
  console.log(`   media processing: enabled (${mb?.BucketId ?? Bucket}, created ${mb?.CreateTime ?? 'now'})`)
}

/**
 * PicProcess 模板 / 任务走「图片处理(异步)」服务,是独立于实时 imageMogr2 的另一层
 * 绑定(未绑回 `400 PicBucketUnBinded`)。`POST /picbucket` = 控制台「开通图片处理
 * (异步)」,空请求体,建队列;幂等。
 */
async function ensurePicBucket() {
  const data = await ci('GET', '/picbucket', { query: { bucketNames: Bucket, pageSize: '10' } })
  const list = asList(data?.Response?.PicBucketList ?? data?.PicBucketList)
  if (list.some((b) => b?.Name === Bucket || b?.BucketId === Bucket)) {
    console.log('   async picture processing: already enabled on this bucket')
    return
  }
  if (dryRun) return console.log('   [dry-run] POST /picbucket (enable async picture processing)')
  const res = await ci('POST', '/picbucket')
  const pb = res?.Response?.PicBucket ?? res?.PicBucket
  console.log(`   async picture processing: enabled (${pb?.BucketId ?? Bucket}, created ${pb?.CreateTime ?? 'now'})`)
}

async function findTemplate(name) {
  const data = await ci('GET', '/template', { query: { names: name, pageSize: '50' } })
  const list = asList(data?.Response?.TemplateList ?? data?.TemplateList)
  return list.find((t) => t?.Name === name && t?.Tag === 'PicProcess') ?? null
}

async function ensureTemplate(size) {
  const name = templateName(size)
  const existing = await findTemplate(name)
  if (existing) {
    const rule = existing.PicProcess?.ProcessRule
    console.log(`   template ${name}: exists (${existing.TemplateId}) rule=${rule}`)
    if (rule !== thumbRule(size)) console.warn(`   ⚠ rule differs from expected ${thumbRule(size)} — update it in the console if intended`)
    return existing.TemplateId
  }
  const xml = `<Request><Tag>PicProcess</Tag><Name>${esc(name)}</Name><PicProcess><IsPicInfo>false</IsPicInfo><ProcessRule>${esc(thumbRule(size))}</ProcessRule></PicProcess></Request>`
  if (dryRun) {
    console.log(`   [dry-run] POST /template\n${xml}`)
    return `t-dry-${size}`
  }
  const data = await ci('POST', '/template', { body: xml })
  const id = data?.Response?.Template?.TemplateId ?? data?.Template?.TemplateId
  console.log(`   template ${name}: created ${id}`)
  return id
}

async function findWorkflow(name) {
  const data = await ci('GET', '/workflow', { query: { name, pageSize: '50' } })
  const list = asList(data?.Response?.MediaWorkflowList ?? data?.MediaWorkflowList)
  return list.find((w) => w?.Name === name) ?? null
}

function workflowXml(templateIds) {
  const nodeName = (size) => `Thumb${size}`
  const nodes = SIZES.map(
    (size) => `
      <${nodeName(size)}>
        <Type>PicProcess</Type>
        <Operation>
          <TemplateId>${esc(templateIds[size])}</TemplateId>
          <Output>
            <Region>${esc(Region)}</Region>
            <Bucket>${esc(Bucket)}</Bucket>
            <Object>\${InputPath}\${InputName}.thumb${size}.webp</Object>
          </Output>
        </Operation>
      </${nodeName(size)}>`,
  ).join('')
  const deps = SIZES.map((size) => `<${nodeName(size)}>End</${nodeName(size)}>`).join('')
  return `<Request>
  <MediaWorkflow>
    <Name>${esc(Name)}</Name>
    <State>${esc(State)}</State>
    <Topology>
      <Dependencies>
        <Start>${SIZES.map(nodeName).join(',')}</Start>
        ${deps}
      </Dependencies>
      <Nodes>
        <Start>
          <Type>Start</Type>
          <Input>
            <ObjectPrefix>${esc(Prefix)}</ObjectPrefix>
            <ExtFilter>
              <State>On</State>
              <Video>false</Video>
              <Audio>false</Audio>
              <Image>false</Image>
              <ContentType>false</ContentType>
              <Custom>true</Custom>
              <CustomExts>${esc(TRIGGER_EXTS)}</CustomExts>
              <AllFile>false</AllFile>
            </ExtFilter>
          </Input>
        </Start>${nodes}
      </Nodes>
    </Topology>
  </MediaWorkflow>
</Request>`
}

async function main() {
  console.log(`🔧 bucket ${Bucket} (${Region}) · prefix ${Prefix} · workflow ${Name} · state ${State}${dryRun ? ' · DRY-RUN' : ''}`)

  if (show) {
    for (const size of SIZES) console.log(`   template ${templateName(size)}:`, JSON.stringify(await findTemplate(templateName(size)))?.slice(0, 300))
    const wf = await findWorkflow(Name)
    console.log(`   workflow ${Name}:`, wf ? JSON.stringify(wf).slice(0, 1200) : 'not found')
    return
  }

  if (del) {
    const wf = await findWorkflow(Name)
    if (!wf) {
      console.log('   nothing to delete')
      return
    }
    if (dryRun) return console.log(`   [dry-run] PUT /workflow/${wf.WorkflowId}?paused → DELETE /workflow/${wf.WorkflowId}`)
    // Active 的工作流改不了也删不了(403 ActiveWorkflowForbiddenUpdate),先暂停。
    if (wf.State === 'Active') await setWorkflowState(wf.WorkflowId, 'paused')
    await ci('DELETE', `/workflow/${wf.WorkflowId}`)
    console.log(`   deleted workflow ${wf.WorkflowId}`)
    return
  }

  await ensureMediaBucket()
  await ensurePicBucket()
  const templateIds = {}
  for (const size of SIZES) templateIds[size] = await ensureTemplate(size)

  const xml = workflowXml(templateIds)
  const existing = await findWorkflow(Name)
  if (dryRun) {
    console.log(`   [dry-run] ${existing ? `PUT /workflow/${existing.WorkflowId}` : 'POST /workflow'}\n${xml}`)
    return
  }
  let data
  if (existing) {
    // 更新同样要求 Paused;改完按目标 State 决定是否重新启用。
    if (existing.State === 'Active') await setWorkflowState(existing.WorkflowId, 'paused')
    data = await ci('PUT', `/workflow/${existing.WorkflowId}`, { body: xml })
    if (State === 'Active') await setWorkflowState(existing.WorkflowId, 'active')
  } else {
    data = await ci('POST', '/workflow', { body: xml })
  }
  const wf = data?.Response?.MediaWorkflow ?? data?.MediaWorkflow
  console.log(`   workflow ${Name}: ${existing ? 'updated' : 'created'} ${wf?.WorkflowId ?? existing?.WorkflowId ?? ''} state=${State}`)
  if (!existing) {
    console.log('   ⓘ 上传事件绑定有几分钟传播期:刚建好的前 1–3 分钟内上传的对象可能不触发(实测),之后 ~2 s 出图。')
  }
}

/** `PUT /workflow/<id>?paused|active`,空 body。 */
async function setWorkflowState(workflowId, action) {
  await ci('PUT', `/workflow/${workflowId}`, { query: { [action]: '' } })
  console.log(`   workflow ${workflowId}: ${action}`)
}

main().catch((e) => {
  console.error('❌', e?.statusCode ?? '', e?.code ?? '', e?.message ?? e)
  if (e?.error) console.error('   ', JSON.stringify(e.error).slice(0, 600))
  process.exit(1)
})
