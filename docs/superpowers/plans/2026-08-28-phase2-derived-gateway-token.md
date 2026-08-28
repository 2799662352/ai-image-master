# 第二期 · 派生网关 token 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 CATIMATION 桌面端能用登录账号自己的计费池出图，凭据是一枚短命的派生 token，而不是那枚永不过期、四个服务端共用的 allocation token。

**Architecture:** RFC 8693 式两层。长期 allocation token 留在服务端不动；new-api 新增内部端点，在**同一个影子用户**（同一个钱包）上另铸带 `ExpiredTime` 的 Token 行；sora-ui-backend 加一层只认 JWT 身份的封装；桌面端主进程按本地缓存年龄取用与刷新，渲染层把网关请求的发起方从渲染进程搬到主进程。

**Tech Stack:** Go 1.x + gin + gorm（new-api）、Node/Express/Prisma + vitest（sora-ui-backend）、Electron 43 + TypeScript + vitest（CATIMATION）

## Global Constraints

- **绝不修改 `PersonalAllocation.NewapiTokenKey`，也不改那枚 allocation token 的任何字段。** 整个方案成立的前提是「现有那枚一动不动」——它被 sora-ui-backend 的 relay、`projectAuth.ts` 的成员校验、shortdrama、Python 后端四处共用。
- 派生 token 必须 `UnlimitedQuota: true`。设 `false` 会因 `RemainQuota` 为 0 被 `new-api/service/quota.go:147` 直接拦死。
- 派生 token 必须 `UserId = alloc.NewapiUserId`（复用已有影子用户，**绝不新建 user**）。同一个 `UserId` 才等于同一个钱包，扣费才走 `quota.go:426` 那条既有路径。
- 派生 token 的 `RemainQuota` **不设**（会和充值打架）。
- 端点返回 **`expires_in`（相对秒）**，不返回绝对时间戳。理由见 spec §六的 2026-08-28 修正①。
- 桌面端**按本地缓存年龄**决定是否重取，默认 300 秒；**不**解析或比较任何服务端时间。
- 凭据只在主进程，`safeStorage` 加密落盘；**绝不经 IPC 下发渲染层**，**绝不进日志/错误上报**。
- `platformUserId` 只能从 JWT 取，**绝不从 query/body 读**。上游 `X-Internal-Key` 能为任意 id 铸 token，这是全部安全性的支点。

**Spec:** `docs/superpowers/specs/2026-08-27-account-quota-design.md`（§二、§六第二期）
**方案选型依据:** `docs/superpowers/specs/2026-08-28-phase2-credential-options.md`

---

## 契约（先定死，三个仓库照此实现）

### C1. new-api 内部端点

```
POST /api/internal/derived-token
Header: X-Internal-Key: <NEWAPI_INTERNAL_KEY>
Body:   { "platform_user_id": "u1", "project_id": 342,
          "producer_project_id": 5,      // 可选，>0 走 producer 池查找
          "ttl_seconds": 900 }           // 可选，默认 900，clamp 到 [60, 3600]

200 { "token_key": "sk-dk...", "expires_in": 900, "newapi_user_id": 123 }
404 { "error": "no allocation found" }
400 { "error": "missing platform_user_id or project_id" }
```

### C2. sora-ui-backend 封装端点

```
GET /api/user/gateway-token?projectId=342&producerProjectId=5
Header: Authorization: Bearer <平台 JWT>

200 { "success": true, "data": { "token": "sk-dk...", "expiresIn": 900 } }
401 未登录 / 403 不是该项目成员 / 503 成员资格核不了 / 404 无 allocation
```

**响应里只有 `token` 和 `expiresIn`。** `newapi_user_id` 不透给客户端——它是内部标识，客户端拿了没用，泄露只增加攻击面。

### C3. 桌面端主进程

```ts
// src/main/services/auth/gatewayToken.ts
export async function resolveGatewayToken(pool: Pool): Promise<string>  // 认缓存
export async function refreshGatewayToken(pool: Pool): Promise<string>  // 无条件重取
export function clearGatewayTokens(): void                              // 登出 / 切池时清
```

---

## Task 1: new-api —— 铸派生 token 的内部端点

**Files:**
- Modify: `D:\tecx\text\25\soraui_4.0\new-api\controller\internal.go`（在 `InternalGetAllocation` 之后追加）
- Modify: `D:\tecx\text\25\soraui_4.0\new-api\router\org-router.go:110-115`（注册路由）
- Test: `D:\tecx\text\25\soraui_4.0\new-api\controller\internal_derived_token_test.go`（新建）

**Interfaces:**
- Consumes: `model.GetPersonalAllocation` / `model.GetPersonalAllocationByProducerProject`、`model.Token`、`model.GenerateInviteCode()`
- Produces: 契约 C1

- [ ] **Step 1: 写失败测试 —— 正常铸出且不动 allocation**

参照 `controller/internal_allocation_test.go` 的 `newAllocationRouter()` 建 router 与内存库。

```go
func TestInternalMintDerivedToken_MintsOnSameShadowUser(t *testing.T) {
	router := newDerivedTokenRouter()
	seedAllocation(t, "u1", 342, 100, "sk-pa-original")

	code, body := postDerivedToken(t, router,
		`{"platform_user_id":"u1","project_id":342,"ttl_seconds":900}`)
	require.Equal(t, http.StatusOK, code)

	key, _ := body["token_key"].(string)
	assert.True(t, strings.HasPrefix(key, "sk-"))
	assert.NotEqual(t, "sk-pa-original", key)
	assert.EqualValues(t, 900, body["expires_in"])

	// 新 Token 行挂在同一个影子用户上，且带真实过期
	var tok model.Token
	require.NoError(t, model.DB.Where("`key` = ?", strings.TrimPrefix(key, "sk-")).First(&tok).Error)
	assert.Equal(t, 100, tok.UserId)
	assert.True(t, tok.UnlimitedQuota)
	assert.NotEqual(t, int64(-1), tok.ExpiredTime)
	assert.Greater(t, tok.ExpiredTime, time.Now().Unix())
}
```

- [ ] **Step 2: 写失败测试 —— 不弄坏现有业务（这条最重要）**

```go
func TestInternalMintDerivedToken_LeavesAllocationUntouched(t *testing.T) {
	router := newDerivedTokenRouter()
	seedAllocation(t, "u1", 342, 100, "sk-pa-original")

	_, _ = postDerivedToken(t, router, `{"platform_user_id":"u1","project_id":342}`)

	// PersonalAllocation 一个字符都没变
	var alloc model.PersonalAllocation
	require.NoError(t, model.DB.Where("platform_user_id = ? AND project_id = ?", "u1", 342).First(&alloc).Error)
	assert.Equal(t, "sk-pa-original", alloc.NewapiTokenKey)

	// 同一个影子用户上有两枚 Token 时，allocation 端点仍返回原来那枚
	allocRouter := newAllocationRouter()
	code, allocBody := getAllocation(t, allocRouter, "platform_user_id=u1&project_id=342")
	require.Equal(t, http.StatusOK, code)
	assert.Equal(t, "sk-pa-original", allocBody["newapi_token_key"])
}
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd D:\tecx\text\25\soraui_4.0\new-api && go test ./controller/ -run DerivedToken -v`
Expected: FAIL —— `undefined: InternalMintDerivedToken`

- [ ] **Step 4: 实现 handler**

```go
// InternalMintDerivedToken 在已有影子用户上另铸一枚**带过期**的 token 交给桌面端。
//
// 为什么不能直接把 alloc.NewapiTokenKey 交出去：那枚 ExpiredTime 是 -1(永不过期),
// 而且是 relay / 成员校验 / shortdrama / Python 后端四处共用的同一个字符串 ——
// 泄漏之后无法单独吊销,作废它等于同时弄断该用户的网页出图和项目成员判定。
//
// 为什么 UnlimitedQuota 必须 true:它决定「这枚 token 有没有自己的子预算」。设 false
// 会因为 RemainQuota 为 0 被 service/quota.go:147 直接拦死;设 true 才是「与钱包共用」,
// 扣费落到 user.quota,与 allocation token 逐字同一条路径。
//
// 为什么 UserId 复用 alloc.NewapiUserId 而不是新建:同一个 UserId 才等于同一个钱包。
// 新建 user 会造出第二个余额,网页与桌面立刻对不上账。
func InternalMintDerivedToken(c *gin.Context) {
	var req struct {
		PlatformUserId    string `json:"platform_user_id"`
		ProjectId         int64  `json:"project_id"`
		ProducerProjectId int64  `json:"producer_project_id"`
		TTLSeconds        int64  `json:"ttl_seconds"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid body"})
		return
	}
	if req.PlatformUserId == "" || req.ProjectId == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing platform_user_id or project_id"})
		return
	}

	// clamp:别信调用方传的 TTL。上限存在的意义是「泄漏窗口以分钟计」这个前提不被绕过。
	ttl := req.TTLSeconds
	if ttl <= 0 {
		ttl = derivedTokenDefaultTTL
	}
	if ttl < derivedTokenMinTTL {
		ttl = derivedTokenMinTTL
	}
	if ttl > derivedTokenMaxTTL {
		ttl = derivedTokenMaxTTL
	}

	// 查找逻辑与 InternalGetAllocation 一致,但**刻意不做 auto_provision**:
	// 铸短命票据不该顺手建配额行(那等于隐式加入项目)。查不到就 404。
	var alloc *model.PersonalAllocation
	var err error
	if req.ProducerProjectId > 0 {
		alloc, err = model.GetPersonalAllocationByProducerProject(req.PlatformUserId, req.ProducerProjectId)
	} else {
		alloc, err = model.GetPersonalAllocation(req.PlatformUserId, req.ProjectId)
	}
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "no allocation found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to query allocation"})
		return
	}

	// `dk` 前缀把派生 token 与 allocation 的 `pa` 前缀区分开 —— 排查时一眼能看出
	// 哪枚是短命票据。注意 Token.Key 存的是**不带 sk- 前缀**的 suffix(与
	// service/allocation.go:395-402 同约定),sk- 只在交出去时拼上。
	suffix := fmt.Sprintf("dk%s%d%s", shortUID(alloc.NewapiUserId), req.ProjectId, model.GenerateInviteCode())
	if len(suffix) > 45 {
		suffix = suffix[:45]
	}

	now := time.Now().Unix()
	token := model.Token{
		UserId: alloc.NewapiUserId,
		Key:    suffix,
		// 这个名字会出现在用户的使用明细里(Log.TokenName)。两枚 token 意味着明细会
		// 出现两种名字,起个能看懂的,否则用户会以为账串了。
		Name:           fmt.Sprintf("桌面端-%d", req.ProjectId),
		Status:         1,
		UnlimitedQuota: true,
		CreatedTime:    now,
		// 🚨 **绝不能是 -1。** -1 = 永不过期 = 退回到「把长期钥匙交给客户端」,
		// 整个两层设计就白做了。
		ExpiredTime: now + ttl,
	}
	if err := model.DB.Create(&token).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create token"})
		return
	}

	// 只回相对秒。绝对时间戳要求两边时钟一致,而客户端是用户机器 —— 偏快会疯狂刷新,
	// 偏慢会拿着死 token 打请求(表现为莫名其妙的 401)。Codex 同理,它连过期字段都不回。
	c.JSON(http.StatusOK, gin.H{
		"token_key":      "sk-" + suffix,
		"expires_in":     ttl,
		"newapi_user_id": alloc.NewapiUserId,
	})
}
```

同文件顶部加常量：

```go
const (
	derivedTokenDefaultTTL = int64(900)  // 15 分钟
	derivedTokenMinTTL     = int64(60)
	derivedTokenMaxTTL     = int64(3600)
)
```

- [ ] **Step 5: 注册路由**

`router/org-router.go`，在 `internalApi` 组里加一行（该组已 `Use(middleware.InternalAuth())`）：

```go
		internalApi.POST("/derived-token", controller.InternalMintDerivedToken)
```

- [ ] **Step 6: 跑测试确认通过**

Run: `go test ./controller/ -run DerivedToken -v`
Expected: PASS

- [ ] **Step 7: 补齐剩余用例并跑全**

补：无 allocation → 404；缺 `platform_user_id` → 400；`ttl_seconds` 传 5 与 99999 各断言被 clamp 成 60 / 3600；producer 池路径（`producer_project_id > 0`）能查到。

Run: `go test ./controller/... ./service/...`
Expected: PASS，且既有 allocation / user-balance 测试无回归

- [ ] **Step 8: 提交**

```bash
cd D:\tecx\text\25\soraui_4.0\new-api
gofmt -w controller/internal.go controller/internal_derived_token_test.go router/org-router.go
git add controller/internal.go controller/internal_derived_token_test.go router/org-router.go
git commit -m "feat(internal): 新增派生 token 端点,在已有影子用户上铸带过期的短命 key"
```

---

## Task 2: sora-ui-backend —— 面向已登录用户的封装

**Files:**
- Modify: `src/services/newApiService.ts`（加上游调用）
- Modify: `src/routes/userOrg.ts`（加端点，与 `/balance`、`/usage-logs` 并列）
- Test: `src/routes/__tests__/userOrg.gatewayToken.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的契约 C1；既有 `authMiddleware`、`forwardNewApiError`（`userOrg.ts:43-95`）、`requireOwnedProjectId`（`utils/projectAuth.ts`）、`resolvePersonalBillingProjectId`（`utils/personalBilling.ts`）
- Produces: 契约 C2

- [ ] **Step 1: 建分支**

```bash
cd D:\tecx\text\25\soraui_4.0\sora-ui-backend
git switch -c feat/desktop-gateway-token
```

- [ ] **Step 2: 写失败测试 —— 安全支点**

这条是整个 Task 的理由所在：上游 `X-Internal-Key` 能为任意 id 铸 token，所以身份**只能**来自 JWT。

```ts
it('platformUserId 只从 JWT 取,query 里塞别人的 id 不生效', async () => {
  const res = await request(makeApp('user-A'))
    .get('/api/user/gateway-token?projectId=342&platformUserId=user-B&platform_user_id=user-B')
  expect(res.status).toBe(200)
  // 上游收到的必须是 A,不是 query 里的 B
  expect(mintDerivedTokenMock).toHaveBeenCalledWith(
    expect.objectContaining({ platformUserId: 'user-A' }),
  )
})
```

- [ ] **Step 3: 写失败测试 —— 核不了成员资格时 503 而不是放行**

```ts
it('成员校验本身失败时回 503,绝不放行', async () => {
  getUserTokenMock.mockRejectedValue(new Error('upstream down'))
  const res = await request(makeApp('user-A')).get('/api/user/gateway-token?projectId=700')
  expect(res.status).toBe(503)
  expect(mintDerivedTokenMock).not.toHaveBeenCalled()
})
```

- [ ] **Step 4: 写失败测试 —— 个人计费落点例外**

个人落点刻意不出现在 `/api/user/organizations` 里（后端设计前提），所以不能走成员校验。

```ts
it('个人计费落点即使不在 organizations 列表里也放行', async () => {
  process.env.PERSONAL_BILLING_PROJECT_ID = '342'
  getUserTokenMock.mockResolvedValue(null) // 不是任何项目的成员
  const res = await request(makeApp('user-A')).get('/api/user/gateway-token?projectId=342')
  expect(res.status).toBe(200)
})
```

- [ ] **Step 5: 跑测试确认失败**

Run: `npx vitest run src/routes/__tests__/userOrg.gatewayToken.test.ts`
Expected: FAIL —— 404（路由不存在）

- [ ] **Step 6: 实现上游调用**

`src/services/newApiService.ts`，照该文件既有方法的 axios + `X-Internal-Key` 写法：

```ts
	/**
	 * 铸一枚短命的派生网关 token。
	 *
	 * **刻意不缓存。** 它本来就是短命凭据,缓存等于延长泄漏窗口;而且真正需要缓存的是
	 * 桌面端(它按本地年龄复用),这里再缓一层只会让两边的过期语义打架。
	 */
	async mintDerivedToken(input: {
		platformUserId: string
		projectId: number
		producerProjectId?: number
		ttlSeconds?: number
	}): Promise<{ tokenKey: string; expiresIn: number }> {
		const resp = await client.post<{ token_key?: string; expires_in?: number }>(
			'/api/internal/derived-token',
			{
				platform_user_id: input.platformUserId,
				project_id: input.projectId,
				...(input.producerProjectId ? { producer_project_id: input.producerProjectId } : {}),
				...(input.ttlSeconds ? { ttl_seconds: input.ttlSeconds } : {}),
			},
		)
		const tokenKey = resp.data?.token_key
		const expiresIn = resp.data?.expires_in
		if (!tokenKey || typeof expiresIn !== 'number') {
			throw new Error('derived-token response malformed')
		}
		return { tokenKey, expiresIn }
	}
```

- [ ] **Step 7: 实现端点**

`src/routes/userOrg.ts`：

```ts
/**
 * GET /api/user/gateway-token
 *
 * 桌面端拿它换一枚能直连网关、扣自己计费池的短命 token。
 *
 * 这一层的**唯一职责**是把「任意用户」收窄成「当前这个已登录用户」:上游
 * `/api/internal/derived-token` 用 X-Internal-Key,那把钥匙能为任意 platform user
 * 铸 token。所以 userId 只能来自 JWT,绝不能从 query/body 读 —— 读了就等于把内部
 * 万能钥匙直接暴露给任何登录用户。
 */
router.get('/gateway-token', authMiddleware, async (req, res) => {
	const userId: string = (req as any).user?.id
	const projectId = parseInt(String(req.query.projectId), 10)
	const producerProjectId = parseInt(String(req.query.producerProjectId), 10) || undefined

	if (!Number.isFinite(projectId) || projectId <= 0) {
		return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'projectId required' } })
	}

	// 个人计费落点**刻意不出现在** /api/user/organizations 里(后端设计前提),
	// 所以对它做成员校验必然 fail-closed 403。必须先把它排除掉。
	const personalId = resolvePersonalBillingProjectId()
	const isPersonal = personalId !== null && projectId === personalId && !producerProjectId

	if (!isPersonal) {
		// 核不了就拒。shortdrama 在同一位置的注释值得原样遵守:
		// "'likely' is not the standard for the one call in this app that spends somebody's money."
		const auth = await requireOwnedProjectId(userId, projectId, producerProjectId)
		if (!auth.ok) return res.status(auth.err.status).json({ success: false, error: auth.err })
	}

	try {
		const { tokenKey, expiresIn } = await newApiService.mintDerivedToken({
			platformUserId: userId,   // ← 只此一处来源
			projectId,
			producerProjectId,
		})
		// 只回 token 与 expiresIn。newapi_user_id 是内部标识,客户端拿了没用,
		// 透出去只增加攻击面。
		return res.json({ success: true, data: { token: tokenKey, expiresIn } })
	} catch (err) {
		return forwardNewApiError(res, err, 'mint derived token')
	}
})
```

- [ ] **Step 8: 跑测试确认通过**

Run: `npx vitest run src/routes/__tests__/userOrg.gatewayToken.test.ts`
Expected: PASS

- [ ] **Step 9: 补齐剩余用例 + 全量回归**

补：未登录 401；非成员 403；上游 404 透传；响应体不含 `newapi_user_id`；**新增代码路径上没有任何 `console.*` 打印到 token**（逐行看一遍，并加一条断言 mock 的 logger 未收到含 `sk-` 的字符串）。

Run: `npx vitest run src/routes/__tests__/ src/services/__tests__/`
Expected: PASS，既有套件无回归

- [ ] **Step 10: 提交**

```bash
git add src/services/newApiService.ts src/routes/userOrg.ts src/routes/__tests__/userOrg.gatewayToken.test.ts
git commit -m "feat(user): 新增 gateway-token 端点,按 JWT 身份换取短命派生 token"
```

---

## Task 3: CATIMATION 主进程 —— gatewayToken.ts

**Files:**
- Create: `src/main/services/auth/gatewayToken.ts`
- Test: `src/main/services/auth/__tests__/gatewayToken.test.ts`

**Interfaces:**
- Consumes: Task 2 的契约 C2；既有 `session.ts` 的 `authBaseUrl()` / `sendJson()` / `requireToken()` / `toAuthError()`
- Produces: 契约 C3

- [ ] **Step 1: 写失败测试 —— 缓存年龄语义**

```ts
it('缓存未超龄时复用,不重复换取', async () => {
  vi.useFakeTimers()
  fetchMock.mockResolvedValue(okToken('sk-dk-1', 900))
  const m = await import('../gatewayToken')

  await m.resolveGatewayToken(POOL)
  await vi.advanceTimersByTimeAsync(299_000)
  await m.resolveGatewayToken(POOL)

  expect(fetchMock).toHaveBeenCalledTimes(1)
})

it('缓存超龄后重新换取', async () => {
  vi.useFakeTimers()
  fetchMock.mockResolvedValue(okToken('sk-dk-1', 900))
  const m = await import('../gatewayToken')

  await m.resolveGatewayToken(POOL)
  await vi.advanceTimersByTimeAsync(301_000)
  await m.resolveGatewayToken(POOL)

  expect(fetchMock).toHaveBeenCalledTimes(2)
})
```

- [ ] **Step 2: 写失败测试 —— 并发只换一次**

批量出图时 N 张图并发，不持锁会并发铸 N 枚 token（每枚都是一行真实数据库记录）。

```ts
it('并发 resolve 只触发一次换取', async () => {
  let release: ((v: unknown) => void) | undefined
  fetchMock.mockImplementationOnce(() => new Promise((r) => { release = r }))
  const m = await import('../gatewayToken')

  const all = Promise.all([m.resolveGatewayToken(POOL), m.resolveGatewayToken(POOL), m.resolveGatewayToken(POOL)])
  release?.(okToken('sk-dk-1', 900))
  const [a, b, c] = await all

  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect([a, b, c]).toEqual(['sk-dk-1', 'sk-dk-1', 'sk-dk-1'])
})
```

- [ ] **Step 3: 写失败测试 —— 池键是一对，且非 2xx 不写缓存**

```ts
it('池键按 (projectId, producerProjectId) 一对区分,不串号', async () => {
  fetchMock
    .mockResolvedValueOnce(okToken('sk-dk-A', 900))
    .mockResolvedValueOnce(okToken('sk-dk-B', 900))
  const m = await import('../gatewayToken')

  const a = await m.resolveGatewayToken({ projectId: 700, producerProjectId: 5 })
  const b = await m.resolveGatewayToken({ projectId: 700, producerProjectId: 6 })

  expect(a).not.toBe(b)
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it('非 2xx 绝不写缓存,下一次仍会重试', async () => {
  fetchMock.mockResolvedValueOnce(err(503)).mockResolvedValueOnce(okToken('sk-dk-1', 900))
  const m = await import('../gatewayToken')

  await expect(m.resolveGatewayToken(POOL)).rejects.toBeTruthy()
  await expect(m.resolveGatewayToken(POOL)).resolves.toBe('sk-dk-1')
  expect(fetchMock).toHaveBeenCalledTimes(2)
})
```

- [ ] **Step 4: 跑测试确认失败**

Run: `npx vitest run src/main/services/auth/__tests__/gatewayToken.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 5: 实现**

```ts
// 桌面端出图用的短命网关凭据。
//
// 与 `session.ts` 里那枚平台 JWT 是两回事:JWT 证明「你是谁」,这枚证明「这笔算谁的钱」。
// 它只活在主进程,绝不经 IPC 下发渲染层 —— 渲染层只该看到派生状态。

/** 缓存年龄上限。对齐 Codex 的 `refresh_interval_ms` 默认值(config_types.rs)。 */
const MAX_AGE_MS = 300_000

interface CacheEntry {
  token: string
  fetchedAt: number
}

/**
 * 按 `(projectId, producerProjectId)` 这**一对**做键。
 *
 * 只按 projectId 做键会把为 A 池铸的 token 交给 B 池 —— 两个 producer project 可以
 * 共用一个 projectId(见 `types/authApi.ts` 的 AccountOrganization 注释),钱会记错地方。
 */
function cacheKey(pool: Pool): string {
  return `${pool.projectId}:${pool.producerProjectId ?? '-'}`
}

const cache = new Map<string, CacheEntry>()
/** 同一个池正在进行中的换取。见下方 resolve 的注释。 */
const inflight = new Map<string, Promise<string>>()

/**
 * 取一枚可用的 token,缓存未超龄就复用。
 *
 * **按本地缓存年龄判定,不看服务端给的过期时刻。** 端点回的是 `expiresIn`(相对秒)
 * 而不是绝对时间戳,正是为了不依赖两边时钟一致 —— 客户端是用户机器,时钟偏几分钟很
 * 常见:偏快会疯狂刷新,偏慢会拿着已死的 token 打请求(表现为莫名其妙的 401)。
 * Codex 的 `external_bearer.rs` 同样只用本地 `fetched_at.elapsed()`。
 *
 * **并发合流是必须的,不是优化。** 批量出图会同时发起 N 个请求,每一次换取都会在
 * 上游真建一行 Token 记录。Codex 用「锁跨 await 持有」达到同样效果,注释原文是
 * "deliberately held across the command to avoid duplicate refreshes"。
 */
export async function resolveGatewayToken(pool: Pool): Promise<string> {
  const key = cacheKey(pool)
  const hit = cache.get(key)
  if (hit && Date.now() - hit.fetchedAt < MAX_AGE_MS) return hit.token

  const running = inflight.get(key)
  if (running) return running

  const p = fetchAndCache(pool, key).finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

/**
 * 无条件重取并覆盖缓存。**401 走这条**。
 *
 * 与 `resolveGatewayToken` 分成两个函数而不是加一个 force 旗标,是照 Codex 的
 * `resolve()` / `refresh()` 分工 —— 两者的语义确实不同,合成一个函数的调用点会
 * 忘记传旗标。
 */
export async function refreshGatewayToken(pool: Pool): Promise<string> {
  const key = cacheKey(pool)
  cache.delete(key)
  return resolveGatewayToken(pool)
}

async function fetchAndCache(pool: Pool, key: string): Promise<string> {
  const token = await requireToken() // 平台 JWT
  const params = new URLSearchParams({ projectId: String(pool.projectId) })
  if (pool.producerProjectId) params.set('producerProjectId', String(pool.producerProjectId))

  const { status, body } = await sendJson(`/api/user/gateway-token?${params}`, 'GET', { token })
  // 非 2xx 绝不写缓存 —— 缓存一个失败结果会让后续每次调用都拿到坏值,直到超龄为止。
  // Codex 的 `server.rs` 同样在非 2xx 时立刻 return Err,ExchangedTokens 压根不构造。
  if (status >= 400) throw toAuthError(status, body)

  const data = (body.data ?? body) as Record<string, unknown>
  const gatewayToken = requireString(data.token, 'token', status)
  cache.set(key, { token: gatewayToken, fetchedAt: Date.now() })
  return gatewayToken
}

/** 登出、切账号时必须清 —— 否则新账号会拿着上一个账号的钱包在花钱。 */
export function clearGatewayTokens(): void {
  cache.clear()
  inflight.clear()
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run src/main/services/auth/__tests__/gatewayToken.test.ts`
Expected: PASS

- [ ] **Step 7: 接进登出路径 + 变异测试**

在 `session.ts` 的 `logout()` 里调 `clearGatewayTokens()`，并加一条测试断言登出后再 resolve 会重新换取。

逐个改坏、确认变红、改回：去掉 `inflight` 合流；`cacheKey` 只用 `projectId`；非 2xx 时也写缓存；`MAX_AGE_MS` 改成 `Infinity`；`logout` 不清缓存。

- [ ] **Step 8: 提交**

```bash
git add src/main/services/auth/gatewayToken.ts src/main/services/auth/__tests__/gatewayToken.test.ts src/main/services/auth/session.ts
git commit -m "feat(auth): 主进程新增派生网关 token 的取用与刷新"
```

---

## Task 4: CATIMATION —— 把网关请求发起方搬到主进程

> **这是本计划里唯一动出图主路径的任务，也是风险最高的一个。** 单独成任务、单独审。

**Files:**
- Modify: `src/main/services/auth/ipc.ts`（加 `auth:gateway-fetch` 通道）
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/services/api/ApiService.ts:1294-1297`（分流点 + `if (!apiKey)` 早退守卫）
- Test: 对应的 ipc / ApiService 测试

**Interfaces:**
- Consumes: Task 3 的 `resolveGatewayToken` / `refreshGatewayToken`
- Produces: 渲染层可用的「用账号额度发一次网关请求」通道

- [ ] **Step 1: 先写清楚分流语义的测试**

三种状态必须分开呈现（回退绝不静默）：未登录 → 提示登录；已登录但余额不足 → 提示充值；已登录但本次失败 → 明确告知「本次改用你自己的 API Key」。

- [ ] **Step 2–8:** 待 Task 3 落地后细化。**本任务的步骤在 Task 3 完成、真实签名确定之后再展开**——现在写死会与实际接口漂移。

---

## Self-Review

**1. Spec coverage：** spec §六第二期的四个部分（new-api / sora-ui-backend / 主进程 / 渲染层）分别对应 Task 1/2/3/4。spec §二的字段表（`expired_time` / `unlimited_quota` / 不设 `remain_quota` / `model_limits`）在 Task 1 Step 4 逐条落到代码，唯一未实现的是 `model_limits`——它在 spec 里标的是「可设」，YAGNI，本期不做。

**2. Placeholder 扫描：** Task 4 的 Step 2-8 是**有意留白**，理由已写明（依赖 Task 3 的真实签名）。这是本计划唯一的未展开处，其余每个 code step 都有完整代码。

**3. 类型一致性：** `Pool` 在 Task 3 与渲染层 `useQuotaStore` 的 `Pool` 同形（`{ projectId, producerProjectId: number | null }`）；契约 C1 的 snake_case 与 C2 的 camelCase 边界在 Task 2 Step 6 的 `mintDerivedToken` 里显式转换。

**4. 已知缺口（需要你确认的验收项）：** spec §六提到「别让后端也预扣一次」——桌面端走直连时不得调 `preDeduct` / `reserveVideoTaskBillingV2`。这条没有对应的自动化测试，因为它是「不要做某事」。列为人工验收项。

---

## 部署依赖

Task 1 改的是 Go 服务，要部署到测试服才能端到端验证 Task 2/3/4。Task 2 已能对 mock 的上游做完整单测，所以 **Task 1、2、3 可以在部署之前全部完成并测通**；只有 Task 4 的真机验证需要等部署。
