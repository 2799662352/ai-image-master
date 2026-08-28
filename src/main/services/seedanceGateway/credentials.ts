/**
 * 「这一次提交用哪枚 token」—— 这条链路上唯一需要**决策**的地方。
 *
 * 单独成文件而不是在 transport 里写两行三元表达式：选错不会报错,只会把钱记到
 * 别人头上,而那种错误从桌面端事后根本查不出来。
 *
 * ## 两枚候选
 *
 * | 计费模式 | 凭据 | 出处 |
 * |---|---|---|
 * | 平台余额 | 影子 token（按计费池签发） | `auth/gatewayToken.ts` 的 `getActivePoolToken()` |
 * | 自填 Key | 用户自己的 Miau key | `wan3/credentials.ts` 的 `getWan3ApiKey()`（provider store 的 `apiKeys['qwen']`） |
 *
 * 两者都发往同一个 host（`MIAU_BASE_URL` 与 `DEFAULT_GATEWAY_ORIGIN` 同源）,
 * 所以**只有 Authorization 这一个字节级差异**决定这次生成从谁的钱包里扣。
 *
 * ## 为什么不靠 `gatewayHeaderInjector`
 *
 * 那个注入器挂在 `onBeforeSendHeaders` 上,渲染层打一个标记头、它在出网前把
 * Authorization 换成影子 token。主进程的 `net.fetch` **确实**会经过它（Electron
 * 文档明写「requests made with `net.fetch` … will trigger webRequest handlers if
 * present」,且本仓的窗口没有设 `partition`,`webContents.session` 此刻就是
 * `session.defaultSession`）。所以「主进程也打个标记头」在今天是能跑通的。
 *
 * 仍然不这么做,三个理由：
 *
 * 1. **它的失败模式是删掉 Authorization 后放行。** 打了标记却取不到 token 时,
 *    注入器会先删掉我们写的头、又写不回自己的（刻意如此,免得静默用用户的钱出图）,
 *    请求裸奔出去撞一个 401。那对渲染层是对的（它有既有错误路径），对提交视频
 *    是最坏的：用户看到的是一句没有信息量的网关错误,而我们本可以在请求出门之前
 *    就说「请先选择计费池」。
 * 2. **它的覆盖范围是偶然成立的。** `index.ts:471` 刻意把注入器挂在
 *    `mainWindow.webContents.session` 而不是 `session.defaultSession`（注释写着
 *    「用 defaultSession 在设了 partition 的窗口上会挂错地方」）。哪天有人给窗口
 *    加一个 `partition`,渲染层照常工作,而主进程这条路会**静默**失去注入 ——
 *    正是注入器自己的注释里警告过的「看着接好了、一次都不生效」。
 * 3. 那是渲染层与主进程之间的私有协议。主进程拿它跟自己说话,只是绕远路去读一个
 *    它本来就能直接读的值（`getActivePoolToken()`）。
 *
 * ## 已知缺口（不假装它不存在）
 *
 * 主进程的 `activePool` 是渲染层 `billingSource` 的镜像,但不是同一个真源。
 * `useQuotaStore.setBillingSource('own-key')` 会先落本地状态、再尽力调
 * `clearBillingPool()`；那一步**失败时被吞掉**（对出图是对的——不打标记就不会注入）。
 * 于是存在一个窗口：渲染层已是 own-key,主进程仍握着 activePool。此时不带意向来
 * 提交（MCP 那条路）会走平台余额。
 *
 * 所以 UI 那条路**应当显式传 `prefer`**（Task 5），别依赖这里的兜底；兜底是给
 * 没有渲染层的 MCP 路径用的。真要根除,得让 `clearBillingPool` 的失败在渲染层
 * 变成一个阻塞式的错误,那超出本任务范围。
 */

export type GatewayBillingSource = 'platform' | 'own-key'

export interface SeedanceGatewayTokenSources {
  /** 平台影子 token。同步读,没有就是 null（见 `auth/gatewayToken.ts` 为什么同步）。 */
  platformToken: () => string | null
  /** 用户自填的 Miau key —— 与万相共用的那一枚,用户不必配置新东西。 */
  ownKey: () => string
}

export interface ResolvedGatewayToken {
  /** 这一次实际按哪种模式取的。取不到时它决定该给哪一句人话。 */
  billing: GatewayBillingSource
  /** 空串 = 该模式下没有可用凭据。**绝不跨模式回落。** */
  token: string
}

/** 取值异常（store 还没就绪等）不该炸掉整条提交链路。 */
function safeRead(read: () => string | null): string {
  try {
    return (read() ?? '').trim()
  } catch {
    return ''
  }
}

/**
 * @param prefer 调用方的计费意向。UI 路径应当显式传；MCP 路径没有渲染层,缺省即可。
 */
export function resolveSeedanceGatewayToken(
  sources: SeedanceGatewayTokenSources,
  prefer?: GatewayBillingSource,
): ResolvedGatewayToken {
  if (prefer === 'platform') {
    // 刻意不回落到自填 Key：静默回落 = 用户以为在花平台余额、实际在花自己的钱。
    return { billing: 'platform', token: safeRead(sources.platformToken) }
  }
  if (prefer === 'own-key') {
    // 反方向同样致命：用户以为在花自己的 Key、实际在扣组织的钱。
    return { billing: 'own-key', token: safeRead(sources.ownKey) }
  }

  const platform = safeRead(sources.platformToken)
  if (platform) return { billing: 'platform', token: platform }
  // 两枚都没有时也报 own-key：那是用户唯一能自己补上的一枚,提示才有可执行的动作。
  return { billing: 'own-key', token: safeRead(sources.ownKey) }
}

/** 两种缺席的补救动作完全不同,所以是两句话而不是一句「凭据缺失」。 */
export function describeMissingGatewayToken(billing: GatewayBillingSource): string {
  return billing === 'platform'
    ? '平台余额未就绪：请先在账号设置里选择一个计费池并启用平台余额。'
    : '未配置 Miau 密钥：请先在设置里填写图片生成的 Miau Key。'
}

/**
 * 适配成 `VideoTransport` 要的 `() => string`。
 *
 * `getPreference` 每次现读而不是构造时定死：用户中途切计费模式不该需要重建
 * transport（transport 的生命周期跟着整个视频服务走,不跟着一次提交走）。
 */
export function createSeedanceGatewayTokenResolver(
  sources: SeedanceGatewayTokenSources,
  getPreference?: () => GatewayBillingSource | undefined,
): () => string {
  return () => resolveSeedanceGatewayToken(sources, getPreference?.()).token
}
