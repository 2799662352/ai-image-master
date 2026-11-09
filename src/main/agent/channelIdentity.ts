import { MIAU_BASE_URL } from '../../shared/miau'
import type { ProviderChannelPreset } from './gatewayModelRouting'

/**
 * 给走 Miau 网关的对话补一段「通道说明」,作为新线程的 `developer_instructions`。
 *
 * 为什么需要(2026-11-09 实测):
 * - Miau 的 Qwen / DeepSeek / Grok 通道在应用里挂在 `apiyi` / `rightcode` 两个网关分组名下
 *   (`rightcode-deepseek-miau` 之类),`codex-providers.json` 里写的也是 `selectedGatewayId:
 *   "rightcode"`。模型在排查问题时会去读这些配置文件,看到 `rightcode` 就把原因归给
 *   Right.Codes——实际请求走的是 Miau,Right.Codes 一个字节也没收到。
 * - 火山方舟的联网搜索是 Responses 的**托管工具**(`{"type":"web_search"}`,由平台在服务端
 *   执行),不会出现在模型的函数工具清单里。模型数着清单就会断言「我没有 web_search」,
 *   即使工具其实已经发出、搜索也确实能跑。
 * - A/B(同一问题、同一模型 `deepseek-v4-1-flash-261017`、各 2 次):不带说明时,一次回答
 *   「该怪 RightCode」、一次自称「我是 Anthropic 的 Claude」;带说明后 2/2 都说清楚是
 *   Miau 网关 + 火山方舟、`rightcode` 只是内部分组 id、搜索由方舟托管。样本很小,不是统计结论。
 *
 * 只对 baseUrl 指向 Miau 的通道生效:Right.Codes / API易 自家端点上的 `rightcode` 就是真的
 * Right.Codes,不能对它们说这句话。
 *
 * 只对**新线程**生效(`thread/start`);已在跑的线程不会重读。用条件句写模型相关的部分,
 * 因为线程中途切模型(fork)会把这段话带到别的通道上。
 */

export interface ChannelIdentityOptions {
  /** `web_search` 配置值;`disabled` 时不能告诉模型它能联网。 */
  webSearch: 'live' | 'cached' | 'disabled' | string
}

/** 联网搜索说明只给火山方舟上的 DeepSeek 通道:其余 Miau 模型的搜索行为没验过,不替它们打包票。 */
const WEB_SEARCH_CHANNEL_SUFFIX = '-deepseek-miau'

const IDENTITY_PARAGRAPH = [
  '# 模型通道说明(应用注入)',
  '',
  '你当前通过 Miau 网关访问上游模型。应用的配置文件(`codex-providers.json`、`config.toml`)里出现的 `rightcode`、`apiyi` 等字样,只是应用内部的「网关分组 id」,不是实际的服务商,与 Right.Codes 服务无关。遇到报错或异常时,不要因为在配置里看到这些字样就把原因归给 Right.Codes;请只根据错误本身的内容判断。',
].join('\n')

const WEB_SEARCH_PARAGRAPH =
  '联网搜索:如果当前模型是火山方舟上的 DeepSeek(模型名以 `deepseek-v4-1-flash` 开头),它的联网搜索是方舟托管的 `web_search` 工具,由平台在服务端自动执行。它不会出现在你的函数工具清单里,这是正常的,不代表不能联网。需要实时信息(今天的日期、最新新闻、近期发布的资料等)时直接发起搜索即可,不要回答「没有联网能力」;搜索结果要核对来源,互相矛盾时说明不确定。'

export function buildChannelIdentityInstructions(
  channel: Pick<ProviderChannelPreset, 'id' | 'baseUrl'>,
  options: ChannelIdentityOptions,
): string | undefined {
  if (channel.baseUrl !== MIAU_BASE_URL) return undefined
  const sections = [IDENTITY_PARAGRAPH]
  if (options.webSearch !== 'disabled' && channel.id.endsWith(WEB_SEARCH_CHANNEL_SUFFIX)) {
    sections.push(WEB_SEARCH_PARAGRAPH)
  }
  return sections.join('\n\n')
}
