# 平台余额（网关 token）方案的已知缺口

**这些都不在 `2026-08-28-desktop-gateway-token.md` 的修复范围内。写下来是为了让下一个人知道它们是「已知且刻意未做」，而不是「没人想到」。**

方案背景：桌面端直接持有影子账号的 allocation token（`expired_time = -1`，永不过期），而不是短命的派生 token。这是用户在多轮讨论后明确选定的取舍——备选方案的完整计划见同目录 `../plans/2026-08-28-phase2-derived-gateway-token.md`（已作废，保留了上游取证）。

由此产生的根本约束：**这枚 token 泄漏后无法单独吊销**（作废它等于同时弄断该用户的网页端出图与项目成员判定），所以所有防护都只能是「不让它离开主进程」，没有事后补救手段。爆炸半径是该用户自己充值的余额——影子账号按 (用户, 池) 一一对应，New API 预扣费，透支不了。

---

## 一、网关侧几乎没有可用的防御阀门

凭据存储的权威调研给出的头号建议是「把防御重心从『藏住密钥』移到『限制它能造成的损失』」，理由很直接：一旦攻击者拿到同用户态的代码执行权，所有客户端措施同时失效，只有服务端侧的还有效。

**但 new-api 这一侧基本是空的。**

### 1.1 没有令牌级的速率限制或消费上限

唯一作用于 relay 的限流按 **user id** 计数（`middleware/model-rate-limit.go:80`），配置来源才是令牌的 group（`:180-191`）。意味着给桌面端限流会**连带限住服务端那几个共用方**（relay / 成员校验 / shortdrama / Python 后端）。

上游明确拒绝做这个功能。issue [#571](https://github.com/QuantumNous/new-api/issues/571) 维护者原话：「不会在开源版增加此功能」。issue #2674 提了同样诉求（「用户分配多个令牌，需要针对每个令牌的访问模型进行速率限制」），至今 open 无回复。

单次请求额度上限、日消费上限：**不存在**。`common.PreConsumedQuota`（默认 500）是预扣费金额，不是上限。

### 1.2 唯一的内置告警是「余额快用完了」，不是「消费突增」

`service/quota.go:455-502` 的 `checkAndSendQuotaNotify`，条件是 `UserQuota - consumeQuota < threshold`，看的是**剩余绝对值**，不看速率。被盗刷时它会在钱快花光时才响。

**可做的粗糙替代**：把该用户的 `quota_warning_threshold` 调高（比如设成日常余额的 80%），把「余额预警」当「消费异常」用。零成本，但很粗。

### 1.3 `AllowIps` 对我们没用，而且可被绕过

桌面端用户是动态 IP，白名单本身就不适用。更要紧的是它**当前可伪造**——见下一条。

---

## 二、`TRUSTED_PROXIES` 缺失（独立的安全修复，应单开一条线）

`SetTrustedProxies` 在 new-api 整个 Go 代码库里**零命中**。Gin 的默认值是信任所有代理（`trustedProxies: ["0.0.0.0/0", "::/0"]`、`ForwardedByClientIP: true`、`RemoteIPHeaders: ["X-Forwarded-For", "X-Real-IP"]`）。

**后果**：任何能直连网关端口的人，发一个伪造的 `X-Forwarded-For` 就能绕过 `AllowIps`、绕过 IP 限流、污染日志里的 IP 归因。也就是说所有与 IP 相关的能力**看起来在生效，其实可伪造**。

上游已经修了（`middleware/trusted_proxies.go` + 文档里的「可信代理与 IP 限流」章节，三态配置 + 启动告警 + `TRUSTED_PROXIES=none` 严格直连模式），**我们这份 fork 没同步**。

修法二选一：cherry-pick 上游那个中间件；或在 nginx 层写 `proxy_set_header X-Forwarded-For $remote_addr;`（**覆写**，不是 `$proxy_add_x_forwarded_for` 追加）。

⚠️ 改之前先确认：有没有哪个服务端组件当前**依赖**伪造 XFF 通过什么检查——有的话改完会断。

---

## 三、令牌在数据库里是明文

`Token.Key` 是 `varchar(128)`（`model/token.go:17`），`GetTokenByKey` 做的是明文等值比对（`WHERE key = ?`）。对照组：用户密码走 bcrypt（`common/crypto.go:23-27`）。

**库泄漏 = 所有令牌立即可用**，不需要破解。

Redis 那边好一些：键名是 HMAC-SHA256，且 `token.Clean()` 在写缓存前把 Key 字段置空（`model/token_cache.go:11-19`），单独拿到 Redis dump 还原不出明文。但如果 `CryptoSecret` 同时泄漏，可以对候选令牌做离线 HMAC 校验。

---

## 四、Windows 上 `safeStorage` 不防同用户态的其他程序

Electron 官方对 DPAPI 的原话：防的是「同机器上的其他用户」，**不防「同一个登录用户下运行的其他程序」**。我们主要出的就是 Windows NSIS 包。

**所以任何用户可见文案都不得宣称「已安全保护」。** 加密落盘的真实含义是「防翻硬盘」，不是「防那台机器上的恶意软件」。

macOS 的 Keychain 语义更强（`protected from other users **and other apps**`），但要求应用代码签名才能表现一致。

Linux 上如果没有 secret store，`safeStorage` 会用**硬编码明文口令**加密——等于没加密。已在 `gatewayToken.ts` 里检测（`getSelectedStorageBackend() === 'basic_text'` 时拒绝落盘），但注意 `isEncryptionAvailable()` 在该后端下**仍返回 true**，它只回答「有没有加密能力」，不回答「这个加密有没有用」。

另：`getSelectedStorageBackend()` 在 win32 上**不存在**（`electron.d.ts` 标 `@platform linux`，实测 `typeof === 'undefined'`）。代码里已用 `process.platform !== 'linux'` 显式短路绕开。

---

## 五、Nano Banana 三个模型不支持平台余额

`gemini-3.1-flash-image` / `gemini-3-pro-image` / `gemini-2.5-flash-image`（`apiType: 'gemini-native'`）在平台计费模式下**会 401**。

根因：`buildRequestUrl`（`ApiService.ts:1907-1908`）对 `gemini-native` 会绕开加速域名走源站 `directBaseURL`，而主进程注入器的 host 白名单只有 `https://miauapi.13797248455.xyz/*`，标记头原样出网、没有 `Authorization`。

`directBaseURL` 存在的原因写在 `ApiService.ts:540`：EdgeOne 不支持 `/v1beta/models/...:generateContent` 这条路径，走加速域名一律 524，而 524 错误页不带 CORS 头，浏览器报的是「No 'Access-Control-Allow-Origin'」，把真实原因盖住。

**为什么不把源站加进白名单**：`directBaseURL` 是 `http://175.178.198.17:3000`——**明文 HTTP**。把一枚永不过期、不可单独吊销的凭据放进明文信道，等于让它在网络路径上裸奔。这条路直接出局。

**当前处置（用户 2026-08-28 拍板）**：UI 明说这三个模型暂不支持平台余额，选中时提示用自填 Key，而不是让它静默 401。

**根治**：让 EdgeOne 支持 `/v1beta/` 路径，取消 `directBaseURL` 这个例外。属服务端/CDN 工作。

---

## 六、可选增强：用量归因（未做）

New API 的消费日志会从请求头读三个字段并落库，而且它们**不会被剥离**（对比 `X-Producer-Id` / `X-Producer-Project-Id` / `X-Pre-Deducted-Quota` 会在没有合法 `X-Internal-Key` 时被 `middleware/auth.go:283-285` 删掉）：

```397:409:new-api/model/log.go
	if params.SessionId == "" {
		params.SessionId = c.GetHeader("X-Session-Id")
	}
	if params.ProjectId == 0 {
		if pidStr := c.GetHeader("X-Project-Id"); pidStr != "" { … }
	}
	if params.PlatformUserId == "" {
		params.PlatformUserId = c.GetHeader("X-Platform-User-Id")
	}
```

所以桌面端带上 `X-Session-Id: desktop-<uuid>` 之类的标记，就能在用量明细里把自己的消费单独捞出来——**共用同一枚 token 也不影响归因**。

注意这是客户端可控字段，**只能用于归因，不能用于执行**（任何人都能伪造）。

另外 `record_ip_log` 默认 **false**（`dto/user_settings.go:15`，用户级设置而非系统级），所以现在日志里根本没有 IP。打开它 + 上面三个头，事后就能按 IP/用户聚合做突增告警——但那需要外部脚本，New API 自己没有这个能力（见 §1.2）。

**本方案未做**，因为需要先确认这些头不会与网关既有语义冲突。

---

## 七、其余散项

- **`ECONNABORTED` 曾不在 `NETWORK_LAYER_ERROR_CODES` 里**（`sora-ui-backend/src/routes/userOrg.ts`），axios 默认超时抛的正是它，导致上游超时被归成 500 而非 503——客户端当成「服务器有 bug」，重试逻辑根本不触发。**已修**（提交 `35a11e6`），此处仅留档，因为它影响的是所有走 `forwardNewApiError` 的端点，不只本功能。
- **`sora-ui-backend` 有三个死测试文件**：不在 `vitest.config.ts` 的 include 白名单里，等于一行没跑，却让人以为那块有覆盖。已知的有 `src/services/__tests__/newApiService.getUserToken.test.ts` 和 `src/__tests__/newApiUserTokenResult.test.ts`。
- **`sora-ui-backend` 把构建产物 `dist_tmp/` 提交进了 git**，且 `.gitignore` 没覆盖它。
