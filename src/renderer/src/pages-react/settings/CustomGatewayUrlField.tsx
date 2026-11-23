import { DEFAULT_CUSTOM_GATEWAY_URL, GATEWAY_URL_FAILURE_MESSAGE, normalizeGatewayUrl } from '../../services/api/customGatewayUrl'

interface CustomGatewayUrlFieldProps {
  /** 输入框里的原文(可能敲到一半)。 */
  value: string
  /** 当前**真正生效**的地址(已归一化)。输入不合法时它仍是上一个合法值。 */
  activeUrl: string
  onChange: (raw: string) => void
}

/**
 * 「自定义网关」的地址输入框(原来是「服务端口」)。
 *
 * 本机的 new-api、局域网机器、公网部署的网关都从这里填,不用再单独管端口。
 * 输入不合法时界面照实说,并写明仍在用哪个地址 —— 否则会出现「输入框里是坏的、
 * 实际请求发往上一个地址」而用户毫不知情。
 */
export function CustomGatewayUrlField({ value, activeUrl, onChange }: CustomGatewayUrlFieldProps) {
  // 留空 = 恢复缺省,不算错。
  const result = value.trim() ? normalizeGatewayUrl(value) : null

  return (
    <div className="mt-3 space-y-2">
      <div className="flex items-center gap-3">
        <label htmlFor="custom-gateway-url" className="text-sm text-zinc-400 whitespace-nowrap">
          网关地址
        </label>
        <input
          id="custom-gateway-url"
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => {
            // 敲完离开输入框时把原文收成归一化的样子(补协议、去 /v1),所见即所用。
            if (result?.ok && result.url !== value) onChange(result.url)
          }}
          placeholder={DEFAULT_CUSTOM_GATEWAY_URL}
          aria-invalid={result !== null && !result.ok}
          className="flex-1 min-w-0 px-3 py-2 bg-zinc-800 border-2 border-zinc-700 text-white placeholder-zinc-500 focus:outline-none focus:border-cyberpunk-yellow text-sm"
        />
      </div>

      {result && !result.ok ? (
        <p role="alert" className="text-xs text-red-400">
          {GATEWAY_URL_FAILURE_MESSAGE[result.reason]}(仍在使用 {activeUrl})
        </p>
      ) : (
        <p className="text-xs text-zinc-500">
          当前: <span className="text-zinc-400">{activeUrl}</span>
        </p>
      )}

      {result?.ok && result.insecurePublicHttp && (
        <p role="note" className="text-xs text-amber-400">
          这是公网的明文 http 地址,API Key 会明文传输;如果网关支持,建议改用 https。
        </p>
      )}

      <p className="text-xs text-zinc-500">
        本地或公网部署的 New API 网关都可以填,不用单独设置端口。可以省略 http(s):// 和结尾的 /v1。
      </p>
    </div>
  )
}
