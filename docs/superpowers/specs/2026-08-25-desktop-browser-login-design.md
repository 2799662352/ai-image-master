# 桌面端浏览器登录:复用 sora-ui 账号体系

> 状态:设计已确认,待写实施计划
> 日期:2026-08-25
> 范围裁定:本次只做**登录 + 额度展示**。充值 / 人像库 / COS 按用户隔离见
> 「登录之后能解锁什么(范围边界)」,均为独立后续项。

## 要解决什么

CATIMATION 目前**完全没有账号概念**。全仓搜 `login` / `session` / `JWT` / `accessToken` /
`subscription` / `quota` / `entitlement`,命中的全是第三方 API key(Seedance/Ark、Wan3、
Miau 网关)和无关注释。Prisma 库里只有 `AgentThread` / `AgentMessage` / `AgentToolCall` /
`AgentArtifact` / `AgentAttachment` 五张会话表,没有用户表。

要加的是「点一下 → 系统浏览器 → 自动回到应用」这种登录,身份来自已有的 sora-ui 账号体系
(线上 `https://13797248455.xyz`)。

**范围是软门**:登录只用于「身份 + 云端额度/计费」,自带 API key 的功能不登录也能用。
这条决定让认证服务成为**可降级依赖**而不是单点故障——断网或认证服务挂了,用户自带 key
的活儿照样干。

## 权威依据

这类流程有正式标准,不凭感觉设计。

| 来源 | 用来定什么 |
|---|---|
| [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252.html) OAuth 2.0 for Native Apps(BCP) | 系统浏览器、回环重定向、`127.0.0.1` vs `localhost`、临时端口 |
| [RFC 7636](https://www.rfc-editor.org/rfc/rfc7636) PKCE | 公开客户端无密钥,用 S256 挑战 |
| [RFC 8628](https://www.rfc-editor.org/rfc/rfc8628) Device Authorization Grant | 兜底路径的语义(本次只借鉴,不实现轮询) |
| Electron `docs/api/safe-storage.md` + `shell/browser/api/electron_api_safe_storage.cc` | 凭证落盘 |
| Electron `docs/tutorial/security.md` | 已知偏差的定性 |
| `openai/codex` `codex-rs/login/src/server.rs` | 参照实现(**部分刻意不抄**,见下) |

## 先回答一个更前面的问题:为什么不在应用里放个密码表单

这是最省事的方案,**零后端改动**:应用内一个用户名密码表单,POST 平台的
`/api/auth/login`,把返回的 token 存进 `safeStorage`。sora-ui 自己的 Electron 外壳现在
就是这么做的(`src/stores/authStore.ts:234-291` 的 `autoLogin` 重放存下的凭据),
`shortdrama-mvp` 的网页登录也是同一形状(`src/lib/auth/directory.ts:52-80` 把凭据转发给
平台验证)。

**`shortdrama-mvp` 之所以能这么简单,是因为它根本没有我们这个问题。** 它是网页应用:
「用户输密码的地方」和「凭证要落地的地方」是同一个浏览器,同源、cookie 自动带上,
不存在交接。而且它有服务端,能安全持有共享的 `JWT_SECRET` 做服务器到服务器的调用 ——
桌面应用做不到,任何人都能解包二进制读出密钥,这正是 PKCE 存在的理由。

CATIMATION 的边界是真实的:用户在**系统浏览器**里认证,凭证要落到**Electron 主进程**,
两个进程没有共享的 cookie jar。

否掉密码表单方案的四条理由:

| | 应用内输密码 | 浏览器交接(本设计) |
|---|---|---|
| 后端改动 | 零 | 5 个端点 + 1 张表 |
| 应用是否接触密码 | **是** | 否 |
| 与网站已登录态 | 各自独立,要再输一次 | 可直接复用 |
| 将来接 2FA / 第三方登录 | 走不通 | 天然支持 |
| RFC 8252 | 违反 §4 与 §8.12 | 符合 |

决定性的一条是「应用是否接触密码」。RFC 8252 §8.12 说得很直接:内嵌用户代理让宿主应用
「能拿到用户的完整认证凭据,而不只是本该给它的那份 OAuth 授权」,并且「即使被与授权服务器
同属一方的可信应用使用,也违反最小权限原则」。密码表单是同一个问题的更直接版本。

## 为什么选回环,而不是深链或设备码

上面确定了要走浏览器,剩下的问题是浏览器怎么把凭证交回来。三条路。

**回环回调(选它)**。主进程在回环网卡上起临时 HTTP 服务收重定向。CATIMATION 的 CSP
`connect-src` 已经放行 `http://127.0.0.1:*` 和 `http://localhost:*`,且 `https:` 整个
scheme 通配(`src/main/index.ts:491`),**一行都不用改**。不用注册协议、不用改 NSIS
安装器、三个平台行为一致。

**深链 `catimation://`(否掉)**。要改四处:`electron-builder.yml` 加 `protocols:`、主进程
加 `setAsDefaultProtocolClient`、macOS 加 `open-url`、Windows 把 `second-instance` 回调
改成读 `argv`(现在的回调**一个参数都不接**,`src/main/index.ts:350`)。开发模式还要处理
`process.execPath` 那套别扭逻辑,Linux 上不可靠,而且浏览器会弹一个"要打开 CATIMATION 吗"
的惊吓对话框。收益只是省掉一个端口。

**设备码轮询(否掉,但留作未来)**。RFC 8628 是给**输入受限设备**用的,不是给能开系统浏览器
并接收回调的桌面应用用的。真正需要它的是四种回环失效场景:SSH 到远端开发机、容器/K8s、
企业环境禁止本地监听、WSL2 里浏览器在 Windows 而回调落在 Linux 网络命名空间。Codex CLI
正是为此提供 `codex login --device-auth`。**本次不做**,因为它还要给轮询端点单独开限流桶
(`sora-ui-backend` 的 `app.use('/api', rateLimiter('GLOBAL_WEB'))` 挂在 CORS 之前,
`src/app.ts:116`,轮询会吃这个桶,用户登录时可能把自己限流)。

选定:**回环做主路径 + 手动粘贴授权码做兜底**。这正是 Codex CLI 的形态(`codex login` 走
回环,`codex login --with-api-key` 走 stdin 粘贴)。粘贴兜底**不需要任何额外后端代码**,
也不需要轮询。

### 三处刻意不抄 Codex

1. **用 `127.0.0.1`,不用 `localhost`。** Codex 用 `http://localhost:1455/auth/callback`。
   RFC 8252 §8.3 明确 `localhost` **NOT RECOMMENDED**:它能被 hosts 文件或名称解析配置
   改指向别处,本机有权限的攻击者可以把回调劫走;用 IP 字面量还能避免误监听到非回环网卡,
   也更不容易被客户端防火墙拦。
2. **用临时端口,不硬编码。** Codex 钉死 1455,是端口冲突隐患。RFC 8252 §7.3 要求客户端
   向操作系统申请临时端口(`listen(0)`),并且**授权服务器 MUST 接受请求时指定的任意端口**。
3. **IPv4 和 IPv6 都试。** RFC 8252 §7.3:「客户端不应假设设备支持某个特定 IP 版本」,
   RECOMMENDED 两个都试、用先绑上的那个。

## 上游事实

### sora-ui-backend(身份提供方)

Node + Express + TypeScript + Prisma + PostgreSQL。**注意不是 `sora-ai-backend`**——那是
FastAPI 的 AI 微服务,只验证 JWT、没有任何认证端点(`app/core/config.py:48-52` 写明密钥
要与 Node 后端一致)。也**不是 `new-api`**——那是 Go 的计费网关,有自己独立的用户表。

```
签发      POST /api/auth/login  {username, password}
          → {success, data:{token, user:{id,username,email?,phone?,role?,displayName?}, expiresAt}}
算法      HS256,密钥 JWT_SECRET(services/authService.ts:11)
claims    {userId, username, role, iat, exp} —— 无 sub / jti / iss / aud
有效期    JWT_EXPIRES_IN 默认 '100y'(authService.ts:13)
刷新      不存在
传输      Authorization 头,可带可不带 `Bearer ` 前缀(middleware/auth.ts:73-78)
CORS      origin: CORS_ORIGIN || '*',credentials: true,Authorization 在 allowedHeaders
          全局挂载且在所有路由之前(src/app.ts:120-132)→ 含 /api/auth
迁移      prisma/migrations/
```

四条会咬人的:

- **`JWT_SECRET` 的代码兜底是字面量 `'default-secret-key'`。** 生产没设这个环境变量,
  任何人都能伪造 token。这是既有问题,本次记录但不修。
- **`authMiddleware` 第一步是 `X-Internal-Secret` 旁路**,配 `X-Internal-Act-As-User-Id`
  可无凭证冒充任意用户(`middleware/auth.ts:20-52`)。**这个密钥绝对不能进桌面应用。**
  对本流程的具体含义:`approve` 把 `userId` 只从已验证会话取、绝不从请求体取,但**内部密钥
  持有者可以通过请求头指定被盖章的身份**。这是平台级既有行为、不给内部密钥持有者任何新能力,
  但它是整条链路上**唯一一处请求能影响被盖章身份的地方**,评估威胁模型时必须知道。
- **`POST /api/auth/verify` 只回显 claims、不查库**(`routes/auth.ts:267`)。封号了照样通过,
  **不能用它做存活探测**。
- **无 device / session 表,claims 无 `jti`。** 多设备天然可用(无状态 JWT,登录 N 次得 N 个
  互不作废的 token),但**无法单独吊销某一台**;唯一开关是 `User.isActive = false`
  (`middleware/auth.ts:89-95` 每请求实时查库),一按就是全设备下线。

可抄的先例:`POST /api/admin/users/:id/impersonate` 用 `expiresIn: '2h'` 签短 token
(`routes/admin.ts:648-652`)——签发路径现成。

### sora-ui(线上前端)

React 18 + TypeScript + Vite 5 SPA,react-router-dom v7,Zustand,antd v6,axios。
`vite build` 出 `dist/`,nginx 托管并带 SPA fallback(`docker-nginx.conf:119-121`)——
**新增路由不需要动 nginx 配置**。生产 `VITE_BACKEND_URL` 为空串,所有请求走同源相对路径。

```
路由表          src/App.tsx:1333-1427
登录 / 注册     /login → LoginPage.tsx    /logon → RegisterPage.tsx
全局守卫        src/components/Auth/AuthGuard.tsx,包住整个 <Routes>(App.tsx:1318)
公开白名单      AuthGuard.tsx:10-18,精确匹配 Array.includes(location.pathname),无前缀匹配
redirect 校验   LoginPage.tsx:22-24,必须以 / 开头且不以 // 开头
token 存放      Zustand persist → localStorage 键 `sora-auth-storage`
```

两个要利用/修的点:

- **`/desktop-auth` 不加进 `AUTH_PATHS`。** 这样未登录用户会被守卫自动弹到
  `/login?redirect=/desktop-auth?...`,登完自动回来。**这条链路白送。**
- **`RegisterPage.tsx:93` 硬编码 `navigate('/home')`、完全忽略 `?redirect=`。** 配对过程中
  顺手注册的新用户会掉出流程。补上和 `LoginPage.tsx:22-24` 一样的处理,**在本次范围内**。

### CATIMATION v4.7.2(客户端)

Electron 43 + electron-vite 5 + React 19 + Tailwind v4(CSS-first `@theme`,无
`tailwind.config.js`)+ pnpm + TypeScript 6 + Vitest 4。

```
窗口配置        src/main/index.ts:446-465
                nodeIntegration: true / contextIsolation: false / sandbox: false
CSP             src/main/index.ts:468-500;connect-src 见 :491
导航守卫        will-navigate :504-511(硬阻止应用内导航到外部 origin)
                setWindowOpenHandler :513-519(http(s) 交给系统浏览器并 deny 弹窗)
单实例锁        :337-354,second-instance 回调不接 argv
渲染入口        单 index.html + tab 切换 + React 孤岛
                electron.vite.config.ts:120-124 的 rollup input 只有 index.html
                (index-react.html 存在但不是构建入口)
启动序列        src/renderer/src/main.ts:91-133
safeStorage     范例 src/main/services/tencent/credentials.ts
IPC 通道常量    src/preload/index.ts:134,直接赋值 window(:1782-1787),非 contextBridge
出网            net.fetch + AbortController(src/main/index.ts:1026-1033 注明原因)
```

`will-navigate` 硬阻止应用内导航到 `13797248455.xyz`,**反向印证只能走系统浏览器**——
这与 RFC 8252 §4「原生应用必须用外部用户代理」正好一致。

## 配对协议

后端加 **1 张表 + 5 个端点**,全在 `sora-ui-backend`。

### 表

```prisma
model DesktopPairing {
  id            String    @id @default(cuid())  // URL 里的 pairing id
  codeChallenge String                          // S256(code_verifier)
  state         String                          // 应用生成,32 字节 base64url
  callbackHost  String?                         // 只允许 "127.0.0.1" 或 "[::1]";null = 粘贴模式
  callbackPort  Int?                            // 操作系统分配的临时端口;null = 粘贴模式
  clientName    String                          // "CATIMATION 桌面版 4.7.2"
  status        String    @default("PENDING")   // PENDING|APPROVED|CLAIMED|DENIED
  userId        String?                         // 批准时写入
  grantCode     String?   @unique               // 一次性码,批准时生成
  createdAt     DateTime  @default(now())
  expiresAt     DateTime                        // createdAt + 5min
  claimedAt     DateTime?

  @@index([expiresAt])
}
```

不存 `code_verifier`——按 PKCE 定义,verifier 只留在客户端,服务端只存 challenge。

### 端点

| 端点 | 鉴权 | 作用 |
|---|---|---|
| `POST /api/auth/desktop/start` | 公开 | 收 `{codeChallenge, state, callbackHost?, callbackPort?, clientName}`,建 PENDING 行,返回 `{pairingId, authorizeUrl, expiresIn}` |
| `GET /api/auth/desktop/:id` | `authMiddleware` | 给授权页读展示信息 `{clientName, status, expiresAt}`,**不泄露 `grantCode`** |
| `POST /api/auth/desktop/approve` | `authMiddleware` | 收 `{pairingId, state}`,校验后写 `userId`、生成 `grantCode`,返回 `{grantCode, callbackUrl}`。**`callbackUrl` 由服务端用库里存的 host/port 拼成完整串**(`null` 即粘贴模式)——不返回 host/port 让前端自己拼,否则「path 由服务端构造」只是名义满足(§8.4) |
| `POST /api/auth/desktop/deny` | `authMiddleware` | 置 DENIED |
| `POST /api/auth/desktop/claim` | 公开 | 收 `{pairingId, grantCode, codeVerifier}`,校验后走与 `/api/auth/login` 相同的签发路径返回 `{token, user, expiresAt}`,置 CLAIMED |

`claim` 必须公开,因为应用此刻还没有任何凭证。安全性来自三重绑定:高熵一次性
`grantCode` + 5 分钟窗口 + `S256(codeVerifier) === codeChallenge`。

`approve` 要求 `authMiddleware`,因为此刻浏览器里是登录态——这正是「用户身份」进入流程的
唯一入口。

`start` 收 `callbackPort` 不是随手设计,是 RFC 8252 §7.3 对授权服务器的强制要求
(MUST 接受任意回环端口)。但 `callbackHost` **必须服务端校验为两个字面量之一**
(`127.0.0.1` / `[::1]`),否则这个字段就是一个开放重定向。校验放在 `start`,存下来的值
即为可信值,`approve` 只回显不重新接受输入。

`grantCode` 与 `state` 都取 `crypto.randomBytes(32)` 的 base64url 编码。

### 时序

1. 应用生成 `code_verifier`(43–128 字符 unreserved 集合)、`code_challenge = BASE64URL(SHA256(verifier))`、`state`
2. 应用依次尝试绑 `127.0.0.1:0` 与 `[::1]:0`,取先成功的,记下 host 字面量与操作系统分配的端口
3. 应用 `POST /desktop/start`(带 `callbackHost` / `callbackPort`),拿到 `authorizeUrl`
4. 应用经 `shell.openExternal` 打开 `https://13797248455.xyz/desktop-auth?pairing=<id>&state=<s>`
5. 浏览器未登录 → `AuthGuard` 自动弹到 `/login?redirect=...` → 登完自动回来
6. 授权页显示 `clientName`,用户点同意 → `POST /desktop/approve`
7. 授权页拿 `approve` 回的**成品** `callbackUrl`,只追加查询串:
   `window.location.replace(\`${callbackUrl}?code=${grantCode}&state=${state}\`)`
   —— 前端不参与 host/port/path 的拼装,IPv6 的方括号也已在服务端处理好
8. 回环服务校验 path 与 `state`,回一页"登录成功,可关闭本页"的 HTML,**立刻 `server.close()`**
9. 应用 `POST /desktop/claim`(带 `codeVerifier`)换到 token,写进 `safeStorage`
10. 主进程广播 `auth:state-changed`,渲染层刷新登录态

粘贴兜底:第 2 步跳过、`callbackHost` 与 `callbackPort` 都传 `null`,第 7 步改成授权页把
`grantCode` 显示出来让用户复制,应用侧一个输入框收,仍然调同一个 `claim`。

## Electron 侧模块划分

新建 `src/main/services/auth/`,五个文件各自单一职责。

**`pkce.ts`** — `generateCodeVerifier()` / `deriveChallenge(verifier)` / `generateState()`。
纯函数,`node:crypto` 实现,好测。

**`loopback.ts`** — `startLoopbackListener({ state, timeoutMs })`,返回
`{ port, family, waitForCode(), cancel() }`。依次尝试 `127.0.0.1:0` 与 `[::1]:0`;
**只绑回环接口**(RFC 8252 §7.3:「clients should listen on the loopback network interface
only, in order to avoid interference by other network actors」);只接一个请求;校验 path
与 `state` 后回 HTML 并立刻关闭;带 5 分钟超时与外部取消。回环上用明文 http 是标准认可的
(§8.3:「acceptable for loopback interface redirect URIs as the HTTP request never leaves
the device」),**不需要自签证书**。

**`credentials.ts`** — 照抄 `src/main/services/tencent/credentials.ts` 的形状:
`safeStorage` 加密写 `auth-credentials.bin` 到 `userData`;`isEncryptionAvailable()` 为假
时降级到模块级内存变量(会话内可用、重启失效),并把状态报成 `credentialSource: 'memory'`;
复用它那个 `onCredentialsInvalidated` 回调注册表来驱动 UI 刷新。

**`session.ts`** — token **只在主进程**。对外只给派生态
`{ authenticated, username, displayName, role, credentialSource }`。存活探测拿一个需要
`authMiddleware` 的端点(`GET /api/user/balance`,它会走 `findById` → `isActive`),
60 秒缓存、网络故障 fail-open——这套决策直接取自 `shortdrama-mvp`
的 `src/lib/auth/directory.ts:95-135`,那里把「用存活探测代替吊销列表」的取舍写全了。

**`ipc.ts`** — 导出单个 `registerAuthIpc()`,仿 `src/main/agent/ipc.ts` 的形状。持有本次
登录的 pending 状态:`codeVerifier` / `state` / **`redirectUri` 原串**(RFC 8252 §8.10 的
MUST,见硬约束七)/ 回环句柄。对上只暴露下表那几个通道。把编排逻辑集中在这里,是为了让
上面四个模块保持无状态、可单测。

所有出网走 `net.fetch` + `AbortController`(仓库既有约定,注释里写明原因是代理/证书,
以及半开 TCP 下 `net.fetch` 会永久悬挂)。

IdP 基址:主进程常量默认 `https://13797248455.xyz`,允许 `CATIMATION_AUTH_BASE_URL`
环境变量覆盖(开发指向 `http://127.0.0.1:3001`)。

**IPC** 注册在 `whenReady` 里、**`createWindow()` 之前**(`src/main/index.ts:1323`),
否则登录 UI 挂载时会撞上 "No handler registered"。

| 通道 | 方向 | 作用 |
|---|---|---|
| `auth:get-state` | invoke | 读派生登录态 |
| `auth:start-login` | invoke | 启动回环流程,返回 `{ mode: 'loopback' \| 'paste', authorizeUrl }` |
| `auth:cancel-login` | invoke | 关回环服务、清 pending |
| `auth:submit-code` | invoke | 粘贴兜底:收 `grantCode` 直接 claim |
| `auth:logout` | invoke | 清本地凭证 |
| `auth:state-changed` | 推送 | 登录态变化 |

invoke 通道**不用改白名单**——`safeInvoke` 没有校验(`src/preload/index.ts:829-831`)。
推送事件要新增 `AUTH_EVENTS: ['auth:state-changed']` 给 `safeOnWithCleanup` 用
(仿 `AGENT_EVENTS`,`src/preload/index.ts:339-348`)。

## 渲染层

软门,所以**不在 `main.ts:114` 拦住 `bootstrap()`**。三处改动:

1. **`useAuthStore`**(Zustand,仿 `stores/useSettingsStore.ts`)。挂载时 `auth:get-state`,
   订阅 `auth:state-changed`。**只存派生字段,永远不存 token。**
2. **账号面板**放进 `SettingsPage.tsx`——它已经在做凭证输入 + IPC 往返,是最近的形状。
   未登录显示"登录"按钮,已登录显示用户名/角色/额度 + "退出"。
3. **一个全屏登录视图**放 `pages-react/`。仿 `SmartErasePage.tsx` 的结构(最小的完整全页
   视图),配色用 `@theme` 里的 `--color-cyberpunk-yellow` `#FCE300` 与背景 `#09090B`。
   挂载走 `react-app/main.tsx` 既有的 `mountXxxReact` 惯例。
   「首次启动展示、可跳过」的判定用 `electron-store` 存一个 `authOnboardingSeen` 布尔——
   这是非机密状态,按仓库既有分工归 `electron-store`(`page-states` / `custom-templates`
   同类),不进 `safeStorage`。跳过后仅通过设置页入口登录。

状态机四态:`idle` → `waiting`(浏览器已打开,等回调,显示"取消"和"复制链接"和"手动输入码")
→ `success` / `error`。授权页那侧的状态机可仿 `sora-ui` 的 `PaymentReturnPage.tsx`。

## 会咬人的硬约束

**一、`safeStorage` 在 `app` ready 之前调用会 throw。** Electron 源码
`electron_api_safe_storage.cc` 里 `IsEncryptionAvailable()` 第一行是
`if (!electron::Browser::Get()->is_ready()) return false;`,而 `EncryptString` /
`DecryptString` 会抛 `"safeStorage cannot be used before app is ready"`。所以
`credentials.ts` **不能在模块加载时读凭证**,必须懒加载到首次调用(而首次调用在 `whenReady`
之后)。

**二、`decryptString` 会校验 v10/v11 密文前缀。** 文件被截断或损坏时抛
`"Ciphertext does not appear to be encrypted"`,不是返回垃圾。读路径必须 try/catch 并当作
「无凭证」处理。

**三、Linux 上不要开 `setUsePlainTextEncryption(true)`。** 它会在没有系统密码管理器时改用
**内存中的固定密码**加密,等于混淆不等于加密。对认证 token 宁可降级到「本次会话有效」,
也不要给出虚假的安全感。

**四、授权码必须走 query string,不能走 URL fragment。** fragment 根本不会发给 HTTP
服务器,回环监听器永远收不到。这是个反复被踩的坑(参见
[better-auth#10431](https://github.com/better-auth/better-auth/issues/10431))。

**五、`state` 必须在回环侧校验,不匹配就拒绝且不进入兑换。** Codex 的 `server.rs` 就是这么
做的(`state_valid` 检查后才继续)。同时要拒绝陈旧/外来/重放的回调。

**六、`claim` 必须是一次性的。** 第二次拿同一个 `grantCode` 直接 400。用 `status` 从
`APPROVED` 到 `CLAIMED` 的单向跃迁 + 数据库唯一约束保证。

**七、必须存下发出去的完整 redirect URI,并在收到回调时精确比对。** RFC 8252 §8.10 的
原文是 MUST:「The native app MUST store the redirect URI used in the authorization request
with the authorization session data (i.e., along with "state" and other related data) and
MUST verify that the URI on which the authorization response was received exactly matches
it.」所以 `ipc.ts` 的 pending 状态除 verifier / state 外**还要存 `redirectUri` 原串**,
`loopback.ts` 收到请求时比对 host + port + path 三者全等,任一不符即拒绝。

**八、callback path 由服务端构造,绝不接受客户端传 path。** RFC 8252 §8.4 要求授权服务器
「MUST require clients to register their complete redirect URI (including the path
component)」,回环是唯一例外且「an exact match is required except for the port URI
component」。我们没有客户端注册表(单一第一方客户端,造注册表是过度设计),因此改用构造法
满足这条:`start` 只收 `callbackHost` + `callbackPort`,**path 恒为 `/cb` 由服务端拼**。
这样"除端口外精确匹配"由构造方式保证,不依赖运行时校验。

**九、只支持 `S256`,线路格式里根本不设 method 字段。** 接受 `plain` 会让 PKCE 形同虚设
(挑战等于验证者本身,截获挑战即可兑换)。与其加一个 `codeChallengeMethod` 再校验它等于
`S256`,不如**不提供这个字段**——没有字段就没有降级路径。服务端一律按 S256 验算。

## RFC 8252 逐条对账

对着 RFC 8252 第 8 节(Security Considerations)全部规范性要求过一遍,便于评审与后续审计。

| 条款 | 要求 | 本设计 |
|---|---|---|
| §8.1 | 公开原生客户端 MUST 用 PKCE;服务器 SHOULD 拒绝不带 PKCE 的请求 | ✅ S256;`codeChallenge` 在表上非空,`start` 缺失即拒 |
| §8.2 | 隐式流 NOT RECOMMENDED | ✅ 不适用,走授权码 + PKCE |
| §8.3 | 回环:http 可接受、仅授权期间开端口、只监听回环网卡、用 IP 字面量而非 `localhost` | ✅ 四条全覆盖(见「刻意不抄 Codex」与 `loopback.ts`) |
| §8.4 | 服务器 MUST 记录客户端类型;MUST 要求注册完整 redirect URI,回环例外为「除端口外精确匹配」 | ⚠️ **部分**:无客户端注册表、无 `client_id`(单一第一方客户端,刻意简化);用「服务端构造 path + host 限两个回环字面量」满足精确匹配语义(硬约束八) |
| §8.5 | 不 NOT RECOMMENDED 用静态共享密钥做客户端认证 | ✅ 无客户端密钥 |
| §8.6 | 服务器 SHOULD NOT 在无用户同意/交互时自动处理授权请求 | ✅ `/desktop-auth` 的同意/拒绝页是**规范要求**,不只是 UX |
| §8.7 | 伪造外部用户代理 | ✅ 走真实系统浏览器;`will-navigate` 反而使内嵌路径不可行 |
| §8.8 | 恶意外部用户代理 | ➖ 操作系统层面风险,不在应用可控范围 |
| §8.9 | RECOMMENDED 用高熵 `state` 并拒绝无匹配 pending 请求的响应 | ✅ 32 字节;回环侧校验,不匹配即拒 |
| §8.10 | REQUIRED 每个授权服务器用唯一 redirect URI;MUST 存下 redirect URI 并在收到时精确比对 | ✅ 单一 IdP 天然满足前半;后半见硬约束七 |
| §8.11 | 非浏览器外部用户代理 | ➖ 不适用 |
| §8.12 | MUST NOT 用内嵌用户代理 | ✅ 系统浏览器;`will-navigate` 结构性阻断内嵌路径 |

**残留风险(规范承认且无法消除)**:§8.1 指出「Loopback IP-based redirect URIs may be
susceptible to interception by other apps accessing the same loopback interface on some
operating systems」。同机恶意进程理论上可抢占/嗅探回环回调。PKCE 正是为此设计——截获到
授权码但没有 verifier,码无法兑换。这是选择回环方案已知并接受的代价。

**唯一的有意偏离**是 §8.4 的客户端注册。做法与理由都写在上表与硬约束八,若将来出现第二个
桌面客户端或第三方客户端,必须补上 `client_id` + 注册表,那时「除端口外精确匹配」就不能再
靠构造法保证。

## 错误处理与降级

| 情况 | 行为 |
|---|---|
| 回环两个地址都绑不上 | 自动切粘贴模式,UI 说明原因 |
| 5 分钟内没收到回调 | 关服务、置 `error`,提供"重试"和"手动输入码" |
| 用户在浏览器点拒绝 | 授权页调 `/deny`;应用侧超时后给出明确文案 |
| `state` 不匹配 | 回环返回 400,不进入兑换,记日志 |
| `claim` 返回 409(已领取) | 提示"该授权码已被使用,请重新登录" |
| `safeStorage` 不可用 | 降级内存,UI 标注"重启后需重新登录" |
| 存活探测网络失败 | fail-open,保持登录态(认证服务故障不该把用户锁在外面) |
| 存活探测返回 401/403 | 清本地凭证,广播登出 |
| TLS / 代理层失败(非 HTTP 状态码) | 文案必须与"认证被拒绝"**区分开**,提示可能是网络/代理,并提供重试 |

### 实测:目标域名在开发机上走本地代理

2026-08-25 实测 `13797248455.xyz`:DNS 解到 `198.18.0.153`——RFC 2544 基准测试保留网段,
不是公网地址,这是本地代理 fake-IP 模式的签名(Clash / Surge 那类工具的假 IP 池)。HTTPS
通(`http_code=200`,`ssl_verify=0`),但**80 端口完全无响应**(`http_code=000`),且首次
探测因代理抖动返回过 curl 退出码 35(SSL connect error)。

三个结论:

1. **`net.fetch` 在这里是不可替代的,不只是仓库约定。** Node 全局 fetch(undici)绕过
   Chromium 的代理配置、用自己的 CA 库,在代理后面只吐无信息量的 `fetch failed`;
   `net.fetch` 从 default session 发出,代理与系统证书都生效
   (`src/main/index.ts:1026-1033` 的注释说的正是这个场景)。
2. **IdP 基址只能是 https,绝不能回落 http。** 目标 80 端口不通。这也是认证路径不该复用
   `validateExternalUrlMain`(只查 scheme、放行任意 http/https 主机)的又一个理由。
3. **瞬时 TLS 失败是常态,重试必须从 `start` 重来。** `claim` 是一次性的,重试不能重放
   `claim`;失败后要丢弃整个 pairing、重新生成 verifier/state 走一遍。

## 交付顺序

改动跨三个仓库,顺序不能颠倒——客户端没有后端端点可测,授权页没有 `pairingId` 可读。

1. **`sora-ui-backend`**:Prisma 模型 + 迁移 → 5 个端点 + 单测。此步完成后可用 curl 走通
   「start → approve → claim」全链路,不依赖任何前端。
2. **`sora-ui`**:`/desktop-auth` 路由 + 授权页;顺手修 `RegisterPage.tsx:93` 的
   `?redirect=` 忽略问题。此步完成后可用浏览器走通到重定向那一步(回环还没人接,预期
   连接失败,但 URL 正确即验证通过)。
3. **CATIMATION 主进程**:`src/main/services/auth/` 五个模块 + 单测。此步完成后可端到端。
4. **CATIMATION 渲染层**:store + 设置页面板 + 全屏视图。

第 1、2 步各自独立可发,第 3 步依赖前两步已部署到线上或本地可达的后端。

## 测试

Vitest 4,**测试放 `src/**/__tests__/`**(`vitest.config.ts:26-29` 的 include 只有
`src/**`;顶层 `tests/` 要另一个 config)。

- `pkce.test.ts` — verifier 字符集与长度、challenge 与 RFC 7636 附录 B 测试向量一致
- `loopback.test.ts` — 拿到操作系统分配的端口、`state` 不匹配拒绝、
  **收到的 URI 与存下的 `redirectUri` 不全等时拒绝**(host / port / path 各一例,§8.10)、
  超时自动关闭、cancel 后端口释放、只接受一次请求
- `credentials.test.ts` — 仿 `services/tencent/__tests__/credentials.test.ts`:
  加密往返、`isEncryptionAvailable` 为假时降级内存、损坏密文当作无凭证
- `session.test.ts` — 存活探测 60 秒缓存命中、网络失败 fail-open、401 触发登出
- 后端:`claim` 一次性、过期拒绝、`codeVerifier` 不匹配拒绝、`approve` 需登录态、
  **`callbackHost` 非回环字面量时 `start` 拒绝**(开放重定向回归测试)、
  **`codeChallenge` 缺失时 `start` 拒绝**(§8.1)

## 已知风险与不在本次范围

**已知偏差:凭证保护不是信任边界。** 所有 Electron 认证最佳实践都要求
`contextIsolation: true` + contextBridge。Electron 官方安全文档原话:

> Disabling context isolation for a renderer process by setting `nodeIntegration: true`
> also disables process sandboxing for that process, creating significant security
> vulnerabilities.

CATIMATION 是 `contextIsolation: false` + `nodeIntegration: true`,渲染层本来就能
`require('fs')`。所以「token 只留主进程」在这里是**降低暴露面的缓解措施,不是边界**。
真正的边界是 `will-navigate` + `setWindowOpenHandler` 挡住不受信内容——仓库自己的注释
(`src/main/file-explorer/refImageResolveIpc.ts:32-36`)已经把这层说清楚了。
改 `contextIsolation` 不在本次范围。

**建议顺手做的收紧。** Electron 安全文档要求「永远校验 URL 或用硬编码可信链接」才交给
`shell.openExternal`,官方 `will-navigate` 范例用的是严格 origin 比对(注释明说为了防
子域名绕过)。而 CATIMATION 的 `validateExternalUrlMain`(`src/main/index.ts:2358-2366`)
**只查 scheme、放行任意 http/https 主机**。认证路径不应复用它,而应在
`src/main/services/auth/` 内做**精确 origin 比对**到配置的 IdP 基址。

**token 是永久凭证。** 本次按最小改动使用平台现有的 100 年 token(`JWT_EXPIRES_IN` 默认
`'100y'`),claims 无 `jti`、无 device 表,因此**无法单独吊销某一台设备**;需要全设备下线
时只能 `User.isActive = false`。软门下这个 token 能花云端额度,即等于钱。补偿只有**两点**:
只存 `safeStorage`、渲染层拿不到原文。

> ⚠️ **更正(2026-08-28)**:这里原本还列了第三点「60 秒存活探测让封号快速生效」——
> **那一条不成立**。`probeLiveness()` 写出来了,但全仓没有任何生产调用方(无定时器、
> 无启动钩子、无 IPC handler),所以 `User.isActive = false` 之后桌面端不会察觉。
> 详见 `2026-08-28-gateway-token-known-gaps.md` §零。要真正拿到这条补偿,得单开一条
> 改动把定时探测接上。

**不在本次范围**,按优先级留给后续:

1. `DesktopSession` 表 + 短 TTL token + 刷新 + `jti`,换来单设备吊销
2. RFC 8628 设备码流程,覆盖 SSH / 容器 / WSL2 / 禁止本地监听四种场景
3. `JWT_SECRET` 兜底字面量的移除(既有安全债)
4. `contextIsolation: true` 迁移

## 登录之后能解锁什么(范围边界)

常被问到的四件事,现状差异很大,分开记清楚。

**账号额度 —— 本次直接可用。** 五个端点全部 `authMiddleware` 门控:
`GET /api/user/balance`(`userOrg.ts:134`)、`/quota`(:261)、`/usage-summary`(:372)、
`/producer-balance`(:410)、`/organizations`(:101),挂在 `app.use('/api/user', …)`
(`app.ts:261`,注释「代理 New API」——余额实际住在 new-api,后端转发,对客户端透明)。
本设计已用 `/api/user/balance` 做存活探测,所以这条链路第一天就打通并被测到,额度展示顺带完成。

**充值 —— 可行,但不能自动跳回应用,属追加工作。** 路由齐全
(`POST /api/payment/alipay/orders` `payment.ts:65`、`GET /api/payment/config` :279、
订单查询 :296)。硬约束:`ALIPAY_RETURN_URL` **从服务端环境变量读**
(`alipayService.ts:81`,用在 :156-158),客户端无法指定回跳地址,支付宝只会跳回网站。
桌面端形态只能是「`shell.openExternal` 开充值页 → 用户在浏览器付完 → 应用重新拉余额
(或轮询 `/api/payment/alipay/orders/:outTradeNo`)」。复用同一套 `shell.openExternal`
管道,`sora-ui` 的 `/payment/return`(`PaymentReturnPage.tsx`)本就是落地页。

**人像库 —— 这个登录帮不上,需独立设计。** 权威归属不在 sora-ui:上游是 Seedance/Ark
素材接口,**跟着 Seedance 密钥走而非 sora-ui 账号**(`assetLibraryPolicy.ts:11-15`:
`verifyContentAssetReferences` 要 Seedance 的 apiKey/apiSecret);本地那层是
`userData/portrait-library-overlay.json`,per-install 明文 JSON,补上游缺失的改名/分组/
软删除(`portraitOverlay.ts:1-10`)。要让它跟账号走,得先给叠加层找一个后端家(加表 +
同步 + 冲突解决),与本次登录无依赖关系。

**COS 桶 —— 已是 STS 临时凭证,登录是一次可选升级。** 不存在「要不要把 COS 密钥发给
客户端」的问题:`stsCredentials.ts` 从 SCF 函数 URL 取短期 STS 凭证
(`DEFAULT_STS_ENDPOINT`,可用 `COS_STS_ENDPOINT` 覆盖),且**按前缀限权**
(`mediaRelay.ts:12` / :84:「STS 临时凭证仅授权此前缀」,前缀 `image-history/`)。
改进空间在门禁:现在是应用级共享密钥 `COS_STS_APP_TOKEN`(`stsCredentials.ts:92`),
装了应用的人拿同一个。登录后可把签发条件换成用户 JWT、前缀收紧到
`image-history/<userId>/`,才谈得上 per-user 存储配额(`UserStorageQuota` 表已存在)。
**需要改 SCF 函数,不在本次范围。**

## 验收

- 六个 CI 门全绿(`contracts` / `typecheck` / `unit-tests` / `skill-gates` / `build` / `e2e-stable`)
- 不新增 typecheck 诊断——`tests/ci-cd/typecheck-baseline.json` 的 `expiresAt` 是
  **2026-08-31**,硬编码在 `scripts/ci/typecheck-baseline.mjs:148`,`--write` 也推不动。
  集成期会撞上这个期限,需提前安排。
- 加依赖必须提交 `pnpm-lock.yaml`(CI 用 `--frozen-lockfile`)
- 手工验收:登录成功 / 浏览器拒绝 / 超时 / 粘贴兜底 / 断网后自带 key 功能仍可用 / 退出后
  重启仍是登出态
