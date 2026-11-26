import type { CodexSessionConfig } from '../../types/agent'
import {
  XAI_REMOTE_MCP_MAX,
  isAllowedRemoteMcpUrl,
  XAI_MCP_LABEL_PATTERN,
} from '../../shared/xaiServerTools'
import { inferModelFamily } from './gatewayModelRouting'

/**
 * xAI(Grok)服务端托管工具:`x_search` / `code_interpreter` / Remote `mcp`。
 *
 * 依据 docs.apiyi.com 的两页(2026-07-13 实测,模型 `grok-4.5`,端点 `/v1/responses`,默认分组 Key 直接可用):
 *  - 「Grok 联网搜索与 X 搜索」:`tools:[{"type":"web_search"}]` / `[{"type":"x_search"}]`;
 *  - 「Grok 代码执行与 Remote MCP」:`[{"type":"code_interpreter"}]`、
 *    `[{"type":"mcp","server_label":…,"server_url":…,"require_approval":"never"}]`。
 *
 * ## 为什么在本机兼容桥里做,而不是走 codex 配置
 * codex 自己只会发 `web_search`(由 `-c web_search=…` 控制,桥已经把 xAI 不认的
 * `external_web_access` / `indexed_web_access` 去掉);它没有任何配置能声明 `x_search` /
 * `code_interpreter` / 远程 `mcp`。所有 xAI 族请求本来就必须过桥(见
 * `responsesCompatibilityProxy` 的「never-regress」守卫),桥的 `transformBody` 就是现成的、
 * 唯一的改写点,而且**每条请求读一次设置**,开关改了下一条消息就生效。
 *
 * ## 护栏(这几条是这个模块存在的理由,别随手放宽)
 * 1. **只动 xAI 族**:`inferModelFamily(body.model) === 'xai'`。Qwen / Gemini / DeepSeek / GPT
 *    的请求即使经过同一座桥也一个字节都不改。
 * 2. **默认全关**,`settings` 为空或全关时 `body` 逐字节不变。
 * 3. **`x_search` 跟着联网搜索走**:请求里没有 `web_search` 工具(= 用户把联网搜索关了,或这是
 *    codex 的后台瞬时线程)就不注入。联网关了而 X 搜索还在,等于绕过了用户的开关。
 * 4. **`code_interpreter` 是 xAI 服务端的沙箱,不是本机 shell**:它看不到用户的文件。注入的同时在
 *    `instructions` 末尾追加一段说明,否则模型可能「在沙箱里跑完就当改好了本机文件」。
 * 5. **网关不认就退回去**:没有账号对 Miau / Right.Codes 的 Grok 渠道做过 live 验证(文档只测了
 *    API易 的 `grok-4.5`),所以 400 / 422 且请求里带着我们注入的工具时,桥会剥掉注入内容重发一次,
 *    重发成功就在一段时间内不再注入(见 `responsesCompatibilityProxy`)。这样「某个渠道不支持」
 *    最坏的结果是「这个开关没效果」,而不是「Grok 一发消息就报错」。
 * 6. Remote MCP 的 URL 在注入前**再校验一遍**(落盘文件可能被手改过),不合格的直接丢掉。
 *
 * 没做、也不打算在没有 live 验证前做的:把 `x_search_call` / `code_interpreter_call` 改写成
 * codex 认识的条目好在聊天里显示进度卡。codex 对不认识的输出条目会忽略(不会报错),所以现在
 * 的行为是「搜索 / 执行在服务端发生,聊天里只看到最终回答」;改写条目一旦形状猜错,下一轮会把
 * 一个上游不认识的 id 回放回去,那才是真正会把对话打坏的做法。
 */

export interface XaiServerToolsSettings {
  xSearch: boolean
  codeInterpreter: boolean
  remoteMcp: ReadonlyArray<{ label: string; url: string }>
}

type JsonObject = Record<string, unknown>

/** 我们会注入的工具类型。codex 自己从不发这三种,所以请求里出现它们 = 是我们加的。 */
export const XAI_INJECTED_TOOL_TYPES: ReadonlySet<string> = new Set([
  'x_search',
  'code_interpreter',
  'mcp',
])

/** 追加到 `instructions` 末尾的段落标记;剥离时也靠它定位。 */
export const XAI_INSTRUCTIONS_MARKER = '# xAI 服务端工具(应用注入)'

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 会话配置 → 桥要读的设置;三项都没开返回 `null`(桥据此整条跳过)。 */
export function xaiServerToolsFromSessionConfig(
  config: Pick<CodexSessionConfig, 'grokXSearch' | 'grokCodeInterpreter' | 'grokRemoteMcp'>,
): XaiServerToolsSettings | null {
  const remoteMcp = Array.isArray(config.grokRemoteMcp) ? config.grokRemoteMcp : []
  if (!config.grokXSearch && !config.grokCodeInterpreter && remoteMcp.length === 0) return null
  return {
    xSearch: config.grokXSearch === true,
    codeInterpreter: config.grokCodeInterpreter === true,
    remoteMcp,
  }
}

function buildInstructions(injected: {
  xSearch: boolean
  codeInterpreter: boolean
  mcpLabels: readonly string[]
}): string {
  const lines = [
    XAI_INSTRUCTIONS_MARKER,
    '本轮请求额外开通了 xAI 服务端托管工具,由 xAI 在服务端执行,不会出现在你的函数工具清单里(这是正常的,不代表没有):',
  ]
  if (injected.xSearch) {
    lines.push(
      '- `x_search`:检索 X(推特)平台的实时帖子、账号动态与话题讨论。只在用户明确要看 X 上的内容时使用;一次问答控制在 3 次搜索以内(它很慢也很费 token);引用时注明来源帖子。',
    )
  }
  if (injected.codeInterpreter) {
    lines.push(
      '- `code_interpreter`:xAI 服务端的 Python 沙箱,只适合精确计算与数据处理。它看不到用户本机的任何文件,也改不了本机的任何东西;读写本机文件、运行项目命令,仍然必须用本地的 shell / apply_patch 等工具,不要把沙箱里的运行结果当成本机已经改好。',
    )
  }
  if (injected.mcpLabels.length > 0) {
    lines.push(
      `- 远程 MCP(${injected.mcpLabels.join('、')}):由 xAI 服务端直连的第三方 MCP 服务器,对话内容会经 xAI 发给对方。只在任务明确需要它提供的能力时才调用,不要把无关的内容发过去。`,
    )
  }
  return lines.join('\n')
}

/**
 * 按设置往一份 `/responses` 请求体里原地注入服务端工具,返回实际注入的工具类型
 * (空数组 = 没改任何东西)。调用前提:`flattenNamespaceTools` 已经跑过(此时 `web_search`
 * 上 xAI 不认的字段已被去掉,`tools` 里不再有 namespace 包装)。
 */
export function injectXaiServerTools(
  body: JsonObject,
  settings: XaiServerToolsSettings | null | undefined,
): string[] {
  if (!settings) return []
  if (typeof body.model !== 'string' || inferModelFamily(body.model) !== 'xai') return []
  if (!Array.isArray(body.tools) || body.tools.length === 0) return []

  const tools = body.tools as unknown[]
  const hasType = (type: string): boolean =>
    tools.some((tool) => isJsonObject(tool) && tool.type === type)

  const injected: string[] = []
  let xSearch = false
  let codeInterpreter = false
  const mcpLabels: string[] = []

  if (settings.xSearch && hasType('web_search') && !hasType('x_search')) {
    tools.push({ type: 'x_search' })
    injected.push('x_search')
    xSearch = true
  }
  if (settings.codeInterpreter && !hasType('code_interpreter')) {
    tools.push({ type: 'code_interpreter' })
    injected.push('code_interpreter')
    codeInterpreter = true
  }
  for (const server of settings.remoteMcp ?? []) {
    // 上限按「实际注入的个数」算,而不是按输入的前 N 项:前面有写坏的条目不该挤掉后面合格的。
    if (mcpLabels.length >= XAI_REMOTE_MCP_MAX) break
    if (
      !server
      || !XAI_MCP_LABEL_PATTERN.test(server.label)
      || !isAllowedRemoteMcpUrl(server.url)
    ) {
      continue
    }
    const alreadyThere = tools.some((tool) => (
      isJsonObject(tool) && tool.type === 'mcp' && tool.server_label === server.label
    ))
    if (alreadyThere) continue
    tools.push({
      type: 'mcp',
      server_label: server.label,
      server_url: server.url,
      // 文档:默认会返回审批请求、要二次确认;codex 没有处理这种条目的通道,所以必须 `never`。
      require_approval: 'never',
    })
    injected.push('mcp')
    mcpLabels.push(server.label)
  }

  if (injected.length > 0) {
    const note = buildInstructions({ xSearch, codeInterpreter, mcpLabels })
    const base = typeof body.instructions === 'string' ? body.instructions.trimEnd() : ''
    body.instructions = base ? `${base}\n\n${note}` : note
  }
  return injected
}

/** 请求体里是否带着我们注入的东西。 */
export function hasInjectedXaiServerTools(body: JsonObject): boolean {
  return Array.isArray(body.tools) && body.tools.some(
    (tool) => isJsonObject(tool)
      && typeof tool.type === 'string'
      && XAI_INJECTED_TOOL_TYPES.has(tool.type),
  )
}

/**
 * {@link injectXaiServerTools} 的逆:剥掉注入的工具与 `instructions` 末尾的说明,
 * 用于上游不认这些工具时的重发。返回新对象,不改入参。
 */
export function stripInjectedXaiServerTools<T extends JsonObject>(body: T): T {
  const stripped: JsonObject = { ...body }
  if (Array.isArray(body.tools)) {
    stripped.tools = body.tools.filter(
      (tool) => !(
        isJsonObject(tool)
        && typeof tool.type === 'string'
        && XAI_INJECTED_TOOL_TYPES.has(tool.type)
      ),
    )
  }
  if (typeof body.instructions === 'string') {
    const cut = body.instructions.indexOf(`\n\n${XAI_INSTRUCTIONS_MARKER}`)
    if (cut >= 0) stripped.instructions = body.instructions.slice(0, cut)
    else if (body.instructions.startsWith(XAI_INSTRUCTIONS_MARKER)) delete stripped.instructions
  }
  return stripped as T
}
