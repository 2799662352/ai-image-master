/**
 * 万相的凭据 —— 就是那枚**已经存在**的 Miau token。
 *
 * ## 用户不需要配置任何新东西
 *
 * 万相经 Miau 网关（new-api）打 DashScope，用的是 `apiKeys['qwen']` 里那枚 token
 * ——用户在**图片生成设置**里填的那个，渲染端通过 `setProviderApiKey('qwen', …)`
 * 镜像进 provider store，qwen 理解工具与 qwen 子代理一直在用同一枚。
 *
 * 这也是选择走网关而不是直连百炼的主要理由：直连要用户另配一份百炼 API Key 和
 * WorkspaceId，而那两样跟他已经配好的东西毫无关系。
 *
 * ## 为什么是「注入」而不是自己去读
 *
 * token 的主人是 `AgentManager`（它持有 `CodexProviderStore` 实例，并在
 * `setProviderApiKey('qwen', …)` 时刷新内存副本 `miauToken`）。视频服务反过来
 * import agent 内部是错的依赖方向；自己另开一个 `CodexProviderStore` 实例则会
 * 各缓存各的，用户改了密钥我们这边还是旧值。
 *
 * 所以由 agent 侧**往下推**一个取值函数 —— 与 apiyi 那枚 MCP 密钥的既有做法
 * 同一个模式。没推之前回落到环境变量 `MIAU_API_KEY`（codex 侧用的也是这个名字），
 * 便于本地起服务调试。
 */

type TokenSource = () => string

let tokenSource: TokenSource | null = null

/** 由 agent 侧在初始化时注入。重复调用以最后一次为准。 */
export function setWan3TokenSource(source: TokenSource): void {
  tokenSource = source
}

/**
 * 现取，不缓存。
 *
 * 缓存会让「用户刚改完密钥、下一次提交仍然 401」——而那个错误看起来像是密钥填错
 * 了，用户会去反复检查一个其实已经正确的值。这条路一次生成只调用一两次，省不下
 * 什么。
 */
export function getWan3ApiKey(): string {
  let fromSource = ''
  if (tokenSource) {
    try {
      fromSource = (tokenSource() ?? '').trim()
    } catch {
      // 取值异常（store 还没就绪等）不该炸掉整个视频服务 —— 退到环境变量，
      // 真的没有就由 hasWan3ApiKey 给出「请先配置」的人话提示。
      fromSource = ''
    }
  }
  if (fromSource) return fromSource
  return (process.env.MIAU_API_KEY ?? '').trim()
}

/** 提交前用它给出「请先配置 Miau 密钥」，而不是让用户等一个上游 401。 */
export function hasWan3ApiKey(): boolean {
  return getWan3ApiKey().length > 0
}

/** 测试用：清掉注入的来源，免得用例之间互相看见。 */
export function __resetWan3Credentials(): void {
  tokenSource = null
}
