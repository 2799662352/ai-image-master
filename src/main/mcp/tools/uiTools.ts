import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import type { ToolRouter } from '../ToolRouter'

export function registerUiTools(server: McpServer, router: ToolRouter): void {
  server.registerTool('open_image_viewer', {
    description: 'Open CATIMATION image viewer with one or more image URLs.',
    inputSchema: z.object({
      urls: z.array(z.string()).min(1),
      startIndex: z.number().int().min(0).default(0),
    }),
  }, async (params) => {
    await router.call('open_image_viewer', params)
    return { content: [{ type: 'text', text: 'opened' }] }
  })

  // Renderer 端 AgentToolExecutor.navigatePage 一直在(useTabStore.switchTab),
  // 此前 MCP 侧从未注册 —— 这里补上,agent 即可切主界面页签。
  server.registerTool('navigate_page', {
    description:
      "Switch the main app to a page tab. Tabs: generate(出图) | batch(批量) | compare(对比) | history(历史) | videoWorkbench(生成视频工作台) | understand(理解) | director(分镜/故事板页 — NOT the 3D Director Stage; for the 3D stage use director_open) | storyboardSplit | smartErase | portraitLibrary | promptTemplates | agentWorkspace | marketplace | settings.",
    inputSchema: z.object({
      tab: z.enum([
        'generate',
        'batch',
        'compare',
        'history',
        'videoWorkbench',
        'understand',
        'director',
        'storyboardSplit',
        'smartErase',
        'portraitLibrary',
        'promptTemplates',
        'agentWorkspace',
        'marketplace',
        'settings',
      ]),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (params) => {
    const result = await router.call('navigate_page', params as Record<string, unknown>)
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      structuredContent: result as Record<string, unknown>,
    }
  })
}
