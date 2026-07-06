#!/usr/bin/env node
/**
 * Cinematography KB MCP Server (stdio, zero-dependency)
 *
 * First-party Catimation MCP that wraps the Alibaba Bailian (Model Studio)
 * knowledge-base retrieval endpoint for the "运镜与结构化描述库":
 *   - 245 camera-motion primitives / 17 skill classes (CameraBench-Pro)
 *   - CHAI 5-dimension structured video captioning spec
 *   - professional caption examples (camera/motion/scene/spatial/subject)
 *   - critique-correction pairs
 *
 * Transport: JSON-RPC 2.0 over stdio (same convention as apiyi-mcp / the
 * catimation bridge). Pure Node built-ins only (node:https / node:readline) so
 * it runs under system `node` OR Electron-as-Node (ELECTRON_RUN_AS_NODE=1) with
 * no node_modules to vendor.
 *
 * Auth: DASHSCOPE_API_KEY is read from the environment. The app injects it at
 * codex spawn (from 设置 → 运镜知识库) via
 * `-c mcp_servers.cinematography_kb.env.DASHSCOPE_API_KEY` — never persisted to
 * config.toml. An external `codex` CLI user can instead hand-add the key to the
 * `mcp_servers.cinematography_kb.env` block in their `~/.codex/config.toml`.
 */

'use strict'

const fs = require('node:fs')
const https = require('node:https')
const path = require('node:path')
const readline = require('node:readline')

const ENDPOINT_HOST = 'ws-zz37st8xsu4cfpof.cn-beijing.maas.aliyuncs.com'
const ENDPOINT_PATH = '/api/v1/indices/knowledge/search'
const AGENT_ID = 'aid-2065266de36042b3aad2505c1ee12dd8'
const API_KEY_ENV = 'DASHSCOPE_API_KEY'
const TIMEOUT_MS = 60000

// --- Sakuga-42M raw-dataset retrieval (DashVector) -------------------------
// The full 1.1M-row Sakuga-42M metadata lives in a DashVector Serverless
// collection (see docs/superpowers/specs/2026-07-05-sakuga-cloud-native-kb-design.md).
// Query vector comes from DashScope text-embedding-v4 (512-dim, same
// DASHSCOPE_API_KEY as the KB above); the DashVector cluster endpoint + key are
// injected via env, same catimation-style runtime `-c` injection as the KB key.
const DASHVECTOR_KEY_ENV = 'DASHVECTOR_API_KEY'
const DASHVECTOR_ENDPOINT_ENV = 'DASHVECTOR_ENDPOINT'
const SAKUGA_COLLECTION = 'sakuga42m'
const SAKUGA_EMBED_DIM = 512
// Bailian AV-search KB "Sakuga作画片段库" retrieval agent (same endpoint host /
// DASHSCOPE_API_KEY as the text KB). Each hit carries a signed, downloadable
// `video_url` of the actual clip segment in its metadata.
const SAKUGA_AV_AGENT_ID = 'aid-f46c435c5877424ca9d8e7bdebd42a2f'
// NOTE: field names must match the ingest schema exactly (Taxonomy_* is
// capitalized in the parquet and in the DashVector collection).
const SAKUGA_OUTPUT_FIELDS = [
  'identifier',
  'text_description',
  'anime_tags',
  'user_tags',
  'aesthetic_score',
  'dynamic_score',
  'rating',
  'url_link',
  'scene_start_time',
  'scene_end_time',
  'Taxonomy_Filming',
  'Taxonomy_Composition',
  'Taxonomy_Time',
  'Taxonomy_Venue',
  'Taxonomy_Media',
  'Taxonomy_Character',
  'fps',
  'width',
  'height',
]

// sakugabooru tag-type dictionary (built by scripts/sakuga/build_tag_dict.py):
// classifies each user_tag token as artist (作画人员) / copyright (作品) /
// general (技法词条) / character / circle (工作室). Loaded once, lazily.
const TAG_DICT_PATH = path.join(__dirname, 'sakuga-tag-types.json')
let tagTypeIndex = null
function getTagTypeIndex() {
  if (tagTypeIndex !== null) return tagTypeIndex
  tagTypeIndex = {}
  try {
    const dict = JSON.parse(fs.readFileSync(TAG_DICT_PATH, 'utf8'))
    for (const [type, names] of Object.entries(dict)) {
      if (type.startsWith('_') || !Array.isArray(names)) continue
      for (const name of names) tagTypeIndex[name] = type
    }
  } catch {
    // dictionary missing → classification silently degrades to raw tags
  }
  return tagTypeIndex
}

/** Split space-separated user_tags into named buckets via the booru tag types. */
function classifyUserTags(userTags) {
  const idx = getTagTypeIndex()
  const buckets = { artist: [], copyright: [], general: [], character: [], circle: [], other: [] }
  String(userTags || '')
    .split(/\s+/)
    .filter(Boolean)
    .forEach((tok) => {
      if (tok === 'animated' || tok === 'presumed') return
      const type = idx[tok]
      if (type && buckets[type]) buckets[type].push(tok)
      else buckets.other.push(tok)
    })
  return buckets
}

/** Strip the '(label: n)' suffix and drop unlabeled 'Others' taxonomy values. */
function cleanTaxonomy(value) {
  const v = String(value || '').replace(/\s*\((?:label|lable):\s*-?\d+\)\s*$/i, '').trim()
  return v && v.toLowerCase() !== 'others' ? v : ''
}

function send(response) {
  process.stdout.write(JSON.stringify(response) + '\n')
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function isObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Best-effort extraction of retrieved chunks. DashScope nests results under
 * data.nodes; each node carries a pre-formatted `text` plus `metadata`. Falls
 * back to pretty JSON when the shape is unexpected.
 */
function extractChunks(payload) {
  if (!isObject(payload)) return null
  const container = isObject(payload.data)
    ? payload.data
    : isObject(payload.output)
      ? payload.output
      : payload
  let nodes = null
  if (isObject(container)) {
    nodes = container.nodes || container.results || container.chunks
  } else if (Array.isArray(container)) {
    nodes = container
  }
  if (!Array.isArray(nodes)) return null

  const chunks = []
  nodes.forEach((item, idx) => {
    if (!isObject(item)) {
      chunks.push(String(item))
      return
    }
    const node = isObject(item.node) ? item.node : item
    const text = node.text || node.content || node.chunk_text
    const meta = isObject(node.metadata)
      ? node.metadata
      : isObject(item.metadata)
        ? item.metadata
        : {}
    const score = item.score != null ? item.score : item.relevance_score
    const title = meta.doc_name || meta.title || meta.file_name || ''
    let header = `[${idx + 1}]`
    if (score != null) {
      const num = Number(score)
      header += Number.isFinite(num) ? ` score=${num.toFixed(3)}` : ` score=${score}`
    }
    if (title) header += ` · ${title}`
    chunks.push(`${header}\n${text || JSON.stringify(node)}`)
  })
  return chunks
}

function searchKb(query, topK, agentId = AGENT_ID, raw = false) {
  return new Promise((resolve) => {
    const apiKey = (process.env[API_KEY_ENV] || '').trim()
    if (!apiKey) {
      resolve({ success: false, error: `Environment variable ${API_KEY_ENV} is not set.` })
      return
    }
    const bodyObj = { query, agent_id: agentId }
    if (topK) {
      bodyObj.dense_similarity_top_k = Number(topK)
      bodyObj.rerank_top_n = Number(topK)
    }
    const body = Buffer.from(JSON.stringify(bodyObj), 'utf8')
    const req = https.request(
      {
        host: ENDPOINT_HOST,
        path: ENDPOINT_PATH,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': body.length,
        },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const parts = []
        res.on('data', (d) => parts.push(d))
        res.on('end', () => {
          const rawBody = Buffer.concat(parts).toString('utf8')
          if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
            resolve({ success: false, error: `HTTP ${res.statusCode}`, detail: rawBody.slice(0, 1000) })
            return
          }
          let payload
          try {
            payload = JSON.parse(rawBody)
          } catch {
            resolve(raw ? { success: false, error: 'Non-JSON response' } : { success: true, text: rawBody.slice(0, 6000) })
            return
          }
          if (raw) {
            resolve({ success: true, payload })
            return
          }
          const chunks = extractChunks(payload)
          if (chunks && chunks.length) {
            resolve({ success: true, text: chunks.join('\n\n') })
          } else {
            resolve({ success: true, text: JSON.stringify(payload, null, 2).slice(0, 6000) })
          }
        })
      },
    )
    req.on('timeout', () => {
      req.destroy()
      resolve({ success: false, error: `Request timed out after ${TIMEOUT_MS}ms` })
    })
    req.on('error', (err) => {
      resolve({ success: false, error: `Network error: ${err.message}` })
    })
    req.write(body)
    req.end()
  })
}

/** Generic HTTPS JSON POST helper (shared by embedding + DashVector calls). */
function postJson(host, pathName, headers, bodyObj) {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify(bodyObj), 'utf8')
    const req = https.request(
      {
        host,
        path: pathName,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': body.length, ...headers },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const parts = []
        res.on('data', (d) => parts.push(d))
        res.on('end', () => {
          const raw = Buffer.concat(parts).toString('utf8')
          if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
            resolve({ success: false, error: `HTTP ${res.statusCode}`, detail: raw.slice(0, 1000) })
            return
          }
          try {
            resolve({ success: true, payload: JSON.parse(raw) })
          } catch {
            resolve({ success: false, error: 'Non-JSON response', detail: raw.slice(0, 500) })
          }
        })
      },
    )
    req.on('timeout', () => {
      req.destroy()
      resolve({ success: false, error: `Request timed out after ${TIMEOUT_MS}ms` })
    })
    req.on('error', (err) => {
      resolve({ success: false, error: `Network error: ${err.message}` })
    })
    req.write(body)
    req.end()
  })
}

/** Generic HTTPS JSON GET helper (DashVector fetch-by-ids). */
function getJson(host, pathName, headers) {
  return new Promise((resolve) => {
    const req = https.request(
      { host, path: pathName, method: 'GET', headers, timeout: TIMEOUT_MS },
      (res) => {
        const parts = []
        res.on('data', (d) => parts.push(d))
        res.on('end', () => {
          const raw = Buffer.concat(parts).toString('utf8')
          if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
            resolve({ success: false, error: `HTTP ${res.statusCode}`, detail: raw.slice(0, 500) })
            return
          }
          try {
            resolve({ success: true, payload: JSON.parse(raw) })
          } catch {
            resolve({ success: false, error: 'Non-JSON response', detail: raw.slice(0, 500) })
          }
        })
      },
    )
    req.on('timeout', () => {
      req.destroy()
      resolve({ success: false, error: `Request timed out after ${TIMEOUT_MS}ms` })
    })
    req.on('error', (err) => {
      resolve({ success: false, error: `Network error: ${err.message}` })
    })
    req.end()
  })
}

/** Embed the natural-language query with DashScope text-embedding-v4 (512-dim). */
async function embedQuery(text) {
  const apiKey = (process.env[API_KEY_ENV] || '').trim()
  if (!apiKey) {
    return { success: false, error: `Environment variable ${API_KEY_ENV} is not set.` }
  }
  const res = await postJson(
    'dashscope.aliyuncs.com',
    '/api/v1/services/embeddings/text-embedding/text-embedding',
    { Authorization: `Bearer ${apiKey}` },
    {
      model: 'text-embedding-v4',
      input: { texts: [text] },
      parameters: { dimension: SAKUGA_EMBED_DIM },
    },
  )
  if (!res.success) return res
  const embeddings =
    res.payload && res.payload.output && Array.isArray(res.payload.output.embeddings)
      ? res.payload.output.embeddings
      : null
  if (!embeddings || !embeddings.length || !Array.isArray(embeddings[0].embedding)) {
    return { success: false, error: 'Unexpected embedding response shape', detail: JSON.stringify(res.payload).slice(0, 500) }
  }
  return { success: true, vector: embeddings[0].embedding }
}

/** Pure: assemble the DashVector query request body. */
function buildSakugaQueryBody(vector, args) {
  const a = isObject(args) ? args : {}
  const topkRaw = Number(a.top_k)
  const body = {
    vector,
    topk: Number.isFinite(topkRaw) && topkRaw > 0 ? Math.min(Math.floor(topkRaw), 50) : 10,
    include_vector: false,
    output_fields: SAKUGA_OUTPUT_FIELDS,
  }
  if (a.filter) body.filter = String(a.filter)
  return body
}

/** Pure: render DashVector hits into a compact, agent-friendly text block. */
function formatSakugaHits(payload) {
  const hits = isObject(payload) && Array.isArray(payload.output) ? payload.output : null
  if (!hits || !hits.length) return '(no results)'
  const lines = []
  hits.forEach((hit, idx) => {
    const f = isObject(hit.fields) ? hit.fields : {}
    let header = `[${idx + 1}] ${hit.id != null ? hit.id : f.identifier || ''}`
    const score = Number(hit.score)
    if (Number.isFinite(score)) header += ` score=${score.toFixed(3)}`
    const aes = Number(f.aesthetic_score)
    const dyn = Number(f.dynamic_score)
    if (Number.isFinite(aes) || Number.isFinite(dyn)) {
      header += ` (aes ${Number.isFinite(aes) ? aes.toFixed(2) : '?'} / dyn ${Number.isFinite(dyn) ? dyn.toFixed(2) : '?'})`
    }
    const parts = [header]
    if (f.text_description) parts.push(String(f.text_description))
    if (f.user_tags) {
      const b = classifyUserTags(f.user_tags)
      if (b.general.length) parts.push(`技法词条 (technique terms): ${b.general.join(', ')}`)
      if (b.artist.length) parts.push(`作画人员 (animator/key animator): ${b.artist.join(', ')}`)
      if (b.circle.length) parts.push(`工作室 (studio/circle): ${b.circle.join(', ')}`)
      if (b.copyright.length) parts.push(`作品 (source work): ${b.copyright.join(', ')}`)
      if (b.character.length) parts.push(`角色 (characters): ${b.character.join(', ')}`)
      if (b.other.length) parts.push(`其他标签: ${b.other.join(', ')}`)
    }
    const tax = [
      ['运镜', f.Taxonomy_Filming],
      ['构图', f.Taxonomy_Composition],
      ['时间', f.Taxonomy_Time],
      ['场地', f.Taxonomy_Venue],
      ['媒介', f.Taxonomy_Media],
      ['人物', f.Taxonomy_Character],
    ]
      .map(([label, v]) => {
        const clean = cleanTaxonomy(v)
        return clean ? `${label}=${clean}` : ''
      })
      .filter(Boolean)
    if (tax.length) parts.push(`六维分类: ${tax.join(' · ')}`)
    if (f.anime_tags) parts.push(`画面细节标签 (anime_tags): ${String(f.anime_tags).slice(0, 400)}`)
    if (f.url_link) {
      let src = `source: ${f.url_link}`
      if (f.scene_start_time || f.scene_end_time) {
        src += ` (${f.scene_start_time || '?'}–${f.scene_end_time || '?'})`
      }
      parts.push(src)
    }
    lines.push(parts.join('\n'))
  })
  return lines.join('\n\n')
}

/** Embed query → DashVector semantic search over the sakuga42m collection. */
async function querySakuga(args) {
  const dvKey = (process.env[DASHVECTOR_KEY_ENV] || '').trim()
  const dvEndpoint = (process.env[DASHVECTOR_ENDPOINT_ENV] || '').trim()
  if (!dvKey || !dvEndpoint) {
    const missing = [!dvKey && DASHVECTOR_KEY_ENV, !dvEndpoint && DASHVECTOR_ENDPOINT_ENV]
      .filter(Boolean)
      .join(', ')
    return { success: false, error: `Environment variable(s) not set: ${missing}` }
  }
  const embedded = await embedQuery(String(args.query))
  if (!embedded.success) return embedded
  const res = await postJson(
    dvEndpoint,
    `/v1/collections/${SAKUGA_COLLECTION}/query`,
    { 'dashvector-auth-token': dvKey },
    buildSakugaQueryBody(embedded.vector, args),
  )
  if (!res.success) return res
  if (isObject(res.payload) && res.payload.code !== undefined && res.payload.code !== 0) {
    return { success: false, error: `DashVector code ${res.payload.code}`, detail: String(res.payload.message || '').slice(0, 500) }
  }
  return { success: true, text: formatSakugaHits(res.payload) }
}

// --- Sakuga clip search: Bailian AV KB + DashVector metadata join ----------

/** Pure: pull the useful parts out of one AV-KB retrieval node. */
function parseAvNode(node) {
  const meta = isObject(node.metadata) ? node.metadata : {}
  const docName = String(meta.doc_name || '')
  const idMatch = docName.match(/^(\d+_\d+)/)
  // Keep only the parsed narration; drop the 【文档名】/【标题】 boilerplate.
  let text = String(node.text || '')
  const bodyIdx = text.indexOf('【正文】:')
  if (bodyIdx >= 0) text = text.slice(bodyIdx + '【正文】:'.length)
  return {
    docName,
    id: idMatch ? idMatch[1] : null,
    videoUrl: meta.video_url ? String(meta.video_url) : '',
    segmentTitle: meta.title ? String(meta.title) : '',
    text: text.trim(),
  }
}

/** Fetch full metadata rows for the given doc ids from DashVector (best-effort). */
async function fetchSakugaMeta(ids) {
  const dvKey = (process.env[DASHVECTOR_KEY_ENV] || '').trim()
  const dvEndpoint = (process.env[DASHVECTOR_ENDPOINT_ENV] || '').trim()
  if (!dvKey || !dvEndpoint || !ids.length) return {}
  const res = await getJson(
    dvEndpoint,
    `/v1/collections/${SAKUGA_COLLECTION}/docs?ids=${encodeURIComponent(ids.join(','))}`,
    { 'dashvector-auth-token': dvKey },
  )
  if (!res.success || !isObject(res.payload) || res.payload.code !== 0) return {}
  return isObject(res.payload.output) ? res.payload.output : {}
}

/** Pure: render one enriched clip hit. */
function formatClipHit(idx, parsed, fields) {
  const f = isObject(fields) ? fields : {}
  let header = `[${idx + 1}] ${parsed.id || parsed.docName}`
  const aes = Number(f.aesthetic_score)
  const dyn = Number(f.dynamic_score)
  if (Number.isFinite(aes) || Number.isFinite(dyn)) {
    header += ` (aes ${Number.isFinite(aes) ? aes.toFixed(2) : '?'} / dyn ${Number.isFinite(dyn) ? dyn.toFixed(2) : '?'})`
  }
  if (parsed.segmentTitle) header += ` ${parsed.segmentTitle.replace(/\|.*$/, '').trim()}`
  const parts = [header]
  if (parsed.text) parts.push(`画面: ${parsed.text.slice(0, 500)}`)
  if (parsed.videoUrl) parts.push(`视频 (signed URL, expires): ${parsed.videoUrl}`)
  if (f.text_description) parts.push(`英文描述: ${String(f.text_description).slice(0, 300)}`)
  const tagSource = f.user_tags || (parsed.docName.includes('__') ? parsed.docName.split('__')[1].replace(/\+/g, ' ') : '')
  if (tagSource) {
    const b = classifyUserTags(tagSource)
    if (b.general.length) parts.push(`技法词条: ${b.general.join(', ')}`)
    if (b.artist.length) parts.push(`作画人员: ${b.artist.join(', ')}`)
    if (b.circle.length) parts.push(`工作室: ${b.circle.join(', ')}`)
    if (b.copyright.length) parts.push(`作品: ${b.copyright.join(', ')}`)
    if (b.character.length) parts.push(`角色: ${b.character.join(', ')}`)
  }
  const tax = [
    ['运镜', f.Taxonomy_Filming],
    ['构图', f.Taxonomy_Composition],
    ['时间', f.Taxonomy_Time],
    ['场地', f.Taxonomy_Venue],
    ['媒介', f.Taxonomy_Media],
    ['人物', f.Taxonomy_Character],
  ]
    .map(([label, v]) => {
      const clean = cleanTaxonomy(v)
      return clean ? `${label}=${clean}` : ''
    })
    .filter(Boolean)
  if (tax.length) parts.push(`六维分类: ${tax.join(' · ')}`)
  if (f.url_link) {
    let src = `原始出处: ${f.url_link}`
    if (f.scene_start_time || f.scene_end_time) {
      src += ` (${f.scene_start_time || '?'}–${f.scene_end_time || '?'})`
    }
    parts.push(src)
  }
  return parts.join('\n')
}

/**
 * Three-layer clip search: Bailian AV KB (visual match + signed mp4 URL) →
 * doc-name identifier → DashVector full-metadata enrichment. The DashVector
 * layer is best-effort; text + video_url always come back.
 */
async function querySakugaClips(args) {
  const res = await searchKb(String(args.query), args.top_k, SAKUGA_AV_AGENT_ID, true)
  if (!res.success) return res
  const container = isObject(res.payload.data) ? res.payload.data : res.payload
  const nodes = Array.isArray(container.nodes) ? container.nodes : []
  if (!nodes.length) return { success: true, text: '(no results)' }
  const parsedNodes = nodes.map(parseAvNode)
  const ids = [...new Set(parsedNodes.map((p) => p.id).filter(Boolean))]
  const metaById = await fetchSakugaMeta(ids)
  const lines = parsedNodes.map((p, i) => {
    const doc = p.id && isObject(metaById[p.id]) ? metaById[p.id] : null
    return formatClipHit(i, p, doc ? doc.fields : null)
  })
  return { success: true, text: lines.join('\n\n') }
}

const TOOLS = [
  {
    name: 'search_cinematography_kb',
    description:
      'Search the cinematography knowledge base (运镜与结构化描述库): 245 camera-motion ' +
      'primitives / 17 skill classes, CHAI 5-dimension structured video captioning spec, ' +
      'professional caption examples (camera/motion/scene/spatial/subject), and ' +
      'critique-correction pairs. Use for questions about camera movement terminology ' +
      '(dolly in/out, pan, tilt, truck, pedestal, arc, crane, whip pan, rack focus...), ' +
      'how to write structured shot descriptions, or good vs bad caption examples.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: "Natural-language query, e.g. '相机向前推进的运镜术语 dolly in 怎么描述'.",
        },
        top_k: {
          type: 'integer',
          description: 'Optional number of chunks to retrieve (default endpoint setting).',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'query_sakuga_dataset',
    description:
      'Semantic search over the raw Sakuga-42M dataset: 1.1M real hand-drawn animation ' +
      'clips with English scene descriptions, sakugabooru technique tags (smears, ' +
      'impact_frames, background_animation, character_acting, effects...), animator / ' +
      'studio / source-work attribution, 6-dimension taxonomy (filming/composition/' +
      'time/venue/media/character), quality scores and source URLs with timecodes. ' +
      'Each hit is returned with tags classified into technique terms, animation staff ' +
      '(作画人员), studio, source work and characters. Supports DashVector filter ' +
      "expressions over fields like aesthetic_score/dynamic_score/user_tags, e.g. " +
      '"aesthetic_score > 0.7 and user_tags like \'%smears%\'". Use ' +
      'search_cinematography_kb for concepts/specs/how-to; use this tool when you need ' +
      'real example clips (descriptions + source links) of a technique or motion.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: "Natural-language query, e.g. 'fast smear frames during a sword fight'.",
        },
        filter: {
          type: 'string',
          description:
            "Optional DashVector filter, e.g. \"aesthetic_score > 0.7 and dynamic_score > 0.6\".",
        },
        top_k: {
          type: 'integer',
          description: 'Optional number of clips to return (default 10, max 50).',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_sakuga_clips',
    description:
      'Visual-content search over real hand-drawn animation clips (Bailian AV KB, ' +
      'Sakuga-42M pilot set). Matches against frame-by-frame visual parsing of the ' +
      'actual videos, and each hit returns: the parsed scene narration, a signed ' +
      'downloadable mp4 URL of the clip segment, plus full metadata joined from the ' +
      'Sakuga-42M dataset (technique terms, animator/key-animator names, studio, ' +
      'source work, 6-dimension taxonomy, original sakugabooru link with timecodes). ' +
      'Use this when you need actual watchable/downloadable reference footage of a ' +
      'motion or technique; use query_sakuga_dataset for metadata-only search over ' +
      'the full 1.1M-clip corpus.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: "Natural-language visual description, e.g. '激烈的打斗 冲击帧' or 'missiles circling with smoke trails'.",
        },
        top_k: {
          type: 'integer',
          description: 'Optional number of hits (endpoint default is 5).',
        },
      },
      required: ['query'],
    },
  },
]

async function handleRequest(request) {
  const { method, id } = request
  const params = request.params || {}

  if (method === 'initialize') {
    sendResult(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'cinematography-kb-mcp', version: '1.0.0' },
    })
  } else if (method === 'tools/list') {
    sendResult(id, { tools: TOOLS })
  } else if (method === 'tools/call') {
    const toolName = params.name
    const args = params.arguments || {}
    if (toolName === 'search_cinematography_kb') {
      const query = args.query || ''
      if (!query) {
        sendResult(id, { content: [{ type: 'text', text: "Error: 'query' is required." }], isError: true })
        return
      }
      const result = await searchKb(query, args.top_k)
      if (result.success) {
        sendResult(id, { content: [{ type: 'text', text: result.text || '(empty)' }] })
      } else {
        let msg = result.error || 'unknown error'
        if (result.detail) msg += `\n${result.detail}`
        sendResult(id, { content: [{ type: 'text', text: msg }], isError: true })
      }
    } else if (toolName === 'query_sakuga_dataset' || toolName === 'search_sakuga_clips') {
      const query = args.query || ''
      if (!query) {
        sendResult(id, { content: [{ type: 'text', text: "Error: 'query' is required." }], isError: true })
        return
      }
      const result = toolName === 'query_sakuga_dataset' ? await querySakuga(args) : await querySakugaClips(args)
      if (result.success) {
        sendResult(id, { content: [{ type: 'text', text: result.text || '(empty)' }] })
      } else {
        let msg = result.error || 'unknown error'
        if (result.detail) msg += `\n${result.detail}`
        sendResult(id, { content: [{ type: 'text', text: msg }], isError: true })
      }
    } else {
      sendError(id, -32601, `Unknown tool: ${toolName}`)
    }
  } else if (method === 'notifications/initialized') {
    /* no-op */
  } else if (method === 'ping') {
    sendResult(id, {})
  } else if (id !== undefined) {
    sendError(id, -32601, `Method not found: ${method}`)
  }
}

function main() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false })
  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    let request
    try {
      request = JSON.parse(trimmed)
    } catch {
      return
    }
    Promise.resolve(handleRequest(request)).catch((err) => {
      process.stderr.write(`Error: ${err && err.message ? err.message : String(err)}\n`)
    })
  })
}

if (require.main === module) {
  main()
}

// Exposed for unit tests (pure functions + tool descriptors); the stdio loop
// only starts when this file is the entrypoint.
module.exports = { TOOLS, buildSakugaQueryBody, formatSakugaHits, parseAvNode, formatClipHit }
