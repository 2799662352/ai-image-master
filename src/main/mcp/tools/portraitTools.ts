// 人像库(素材库)MCP 工具 —— 让 agent 自主管理人像库:上传、搜索、下载、
// 改名/分组/隐藏整理。底层主进程 handler 见 services/seedance/runtime.ts:
//  - list/add/download 走上游 Seedance 素材接口(真实服务端能力);
//  - edit(改名/分组/隐藏)走主进程「叠加层」单一真相源,与人像库 UI 共享。
//
// banner 约定与 imageTools/videoTools 一致:短文本 + 结尾 machine-readable JSON 行。

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import type { ToolRouter } from '../ToolRouter'

function textResult(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] }
}

function errorBanner(tool: string, error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error)
  if (msg.includes('Secret') || msg.includes('SEEDANCE_KEY_MISSING')) {
    return [
      `❌ ${tool} — Seedance 素材库未就绪(需要 API Key + API Secret)。`,
      '提示用户打开 设置页 → 「Seedance 视频生成」填入 API Key 与 API Secret(素材库接口要签名),再重试。',
      JSON.stringify({ ok: false, error: msg }),
    ].join('\n')
  }
  return [`❌ ${tool} failed: ${msg}`, JSON.stringify({ ok: false, error: msg })].join('\n')
}

interface ListItem {
  assetId: string
  assetUrl: string
  name: string
  kind: string
  sourceUrl?: string
  group?: string
  hidden: boolean
}

interface ListResult {
  items: ListItem[]
  total: number
  page: number
  totalPages: number
  hasMore: boolean
  scanCapped?: boolean
  groups: string[]
}

/** 精简单项,只留 agent 行动所需字段(codex 默认 ~10K token 截断,冗余字段会挤掉真正的项)。 */
function leanItem(it: ListItem): Record<string, unknown> {
  return {
    assetId: it.assetId,
    name: it.name,
    kind: it.kind,
    assetUrl: it.assetUrl,
    ...(it.group ? { group: it.group } : {}),
    ...(it.sourceUrl ? { sourceUrl: it.sourceUrl } : {}),
    ...(it.hidden ? { hidden: true } : {}),
  }
}

export function registerPortraitTools(server: McpServer, router: ToolRouter): void {
  server.registerTool(
    'list_portrait_library',
    {
      description:
        'Search / browse the user\'s portrait library (人像库 / 素材库) — the shared pool of images, ' +
        'videos and audio used for video generation. Use this to FIND existing material before ' +
        'generating, to reuse a character/scene for consistency, or to look up an assetId to edit. ' +
        'Returns each item\'s assetId, display name, kind, custom group, and a directly-referenceable ' +
        'asset://assetId (pass it to generate_video as firstFrame/referenceImages). Supports a text ' +
        'query, kind filter, and group filter. Results are paginated (the library can be large): the ' +
        'response carries page/totalPages/hasMore — when hasMore is true, fetch the next page with ' +
        'page:N+1 instead of asking for a huge pageSize. Narrow with query/kind/group before paging.',
      inputSchema: z.object({
        query: z.string().optional().describe('Text to search asset names.'),
        kind: z
          .enum(['all', 'image_people', 'image_environment', 'video', 'audio'])
          .optional()
          .describe('Filter by kind. image_people = 人像. Default returns all kinds.'),
        group: z.string().optional().describe('Only items in this user-defined group.'),
        page: z.number().int().min(1).optional().describe('Page number (default 1).'),
        pageSize: z.number().int().min(1).max(50).optional().describe('Items per page (default 12, max 50).'),
        includeHidden: z.boolean().optional().describe('Include soft-deleted/hidden items. Default false.'),
      }),
    },
    async (params) => {
      try {
        const res = (await router.call('list_portrait_library', params)) as ListResult
        if (res.items.length === 0) {
          return textResult(
            ['📭 人像库为空(或当前筛选无结果)。', JSON.stringify({ ok: true, count: 0, total: res.total, groups: res.groups })].join('\n'),
          )
        }
        // 渐进式披露:只回一行人类摘要 + 一行精简 JSON(避免人类行/JSON 重复
        // 序列化撑爆 codex 的 ~10K token 截断)。还有更多则提示下一页页码。
        const more = res.hasMore ? ` —— 还有更多,翻页用 page:${res.page + 1}` : ''
        const capped = res.scanCapped ? '(分组扫描达上限,结果可能不全)' : ''
        return textResult(
          [
            `📚 人像库 第 ${res.page}/${res.totalPages} 页,本页 ${res.items.length} 项 / 共 ${res.total}${more}${capped}。引用素材把 asset://assetId 传给 generate_video。`,
            JSON.stringify({
              ok: true,
              count: res.items.length,
              total: res.total,
              page: res.page,
              totalPages: res.totalPages,
              hasMore: res.hasMore,
              groups: res.groups,
              items: res.items.map(leanItem),
            }),
          ].join('\n'),
        )
      } catch (error) {
        return textResult(errorBanner('list_portrait_library', error))
      }
    },
  )

  server.registerTool(
    'add_to_portrait_library',
    {
      description:
        'Upload an image, video, or audio file into the user\'s portrait library (人像库 / 素材库) so it ' +
        'persists and can be reused across video generations. Use this PROACTIVELY: when the user gives ' +
        'you material for a video, or after you generate an image they want to reuse, add it here. ' +
        'Accepts a local file path, a data: URL, an http(s) URL, or an existing asset://assetId. Kind is ' +
        'auto-detected from the file; identical content is deduplicated upstream (same assetId), which ' +
        'keeps characters consistent. Returns the assetId + asset://assetId you can immediately pass to ' +
        'generate_video.',
      inputSchema: z.object({
        source: z.string().min(1).describe('Local file path, data: URL, https URL, or asset://assetId.'),
        kind: z.enum(['image', 'video', 'audio']).optional().describe('Override auto-detected kind.'),
        name: z.string().optional().describe('Display name for the asset (otherwise upstream picks one).'),
        imageCategory: z
          .enum(['image_people', 'image_environment'])
          .optional()
          .describe('For images: 人像(image_people, default) or 场景(image_environment).'),
      }),
    },
    async (params) => {
      try {
        const res = (await router.call('add_to_portrait_library', params)) as {
          duplicated: boolean
          assetId: string
          assetUrl: string
          name: string
          kind: string
        }
        return textResult(
          [
            `✅ add_to_portrait_library DONE — ${res.duplicated ? '已存在(去重复用)' : '已上传'} 「${res.name}」[${res.kind}]。`,
            `引用:把 ${res.assetUrl} 传给 generate_video 的 firstFrame/referenceImages 即可。`,
            JSON.stringify({ ok: true, ...res }),
          ].join('\n'),
        )
      } catch (error) {
        return textResult(errorBanner('add_to_portrait_library', error))
      }
    },
  )

  server.registerTool(
    'download_portrait_asset',
    {
      description:
        'Download a portrait-library asset to a local file and return the saved path. Use it when the ' +
        'user wants to save/export a library item locally. Pass the asset\'s sourceUrl (from ' +
        'list_portrait_library results).',
      inputSchema: z.object({
        url: z.string().min(1).describe('The asset sourceUrl (http(s)) from list_portrait_library.'),
        name: z.string().optional().describe('Optional filename for the saved file.'),
      }),
    },
    async (params) => {
      try {
        const res = (await router.call('download_portrait_asset', params)) as { localPath: string; name: string }
        return textResult(
          [
            `✅ download_portrait_asset DONE — 已保存到本地。`,
            `📁 SAVED FILE: ${res.localPath}`,
            JSON.stringify({ ok: true, ...res }),
          ].join('\n'),
        )
      } catch (error) {
        return textResult(errorBanner('download_portrait_asset', error))
      }
    },
  )

  server.registerTool(
    'edit_portrait_library',
    {
      description:
        'Organize the portrait library: rename an asset, move asset(s) into a user-defined group, ' +
        'hide/unhide (soft-delete/restore) asset(s), or create/delete a group. These edits are shared ' +
        'live with the 人像库 page the user sees. Get assetIds from list_portrait_library first.',
      inputSchema: z.object({
        action: z
          .enum(['rename', 'move_group', 'hide', 'unhide', 'new_group', 'delete_group'])
          .describe('What to do.'),
        assetId: z.string().optional().describe('Target assetId (for rename).'),
        assetIds: z.array(z.string()).optional().describe('Target assetIds (for move_group/hide/unhide).'),
        name: z.string().optional().describe('New name (for rename).'),
        group: z
          .string()
          .optional()
          .describe('Group name (for move_group/new_group/delete_group). Omit group on move_group to ungroup.'),
      }),
    },
    async (params) => {
      try {
        const res = (await router.call('edit_portrait_library', params)) as {
          ok: boolean
          action: string
          affected: number
          groups: string[]
        }
        return textResult(
          [
            `✅ edit_portrait_library DONE — ${res.action}${res.affected ? ` (${res.affected} 项)` : ''}。`,
            JSON.stringify(res),
          ].join('\n'),
        )
      } catch (error) {
        return textResult(errorBanner('edit_portrait_library', error))
      }
    },
  )
}
