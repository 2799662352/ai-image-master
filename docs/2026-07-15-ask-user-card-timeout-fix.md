# ask_user 选项卡「过一段时间再点就卡住」— 根因与修复 (2026-07-15)

> 状态: 已修复,测试全绿(ToolRouter 6/6、agent-chat 76 文件 653/653、codexLaunch+MCP tools 147/147),`build:vite` 通过。
> 涉及主进程 ToolRouter、codex 启动参数、渲染层 store 事件归约、AskUserCard 展示层四处。
> 需重新打包/重启应用生效。

## 一、现象

- Agent 在聊天里弹出 `ask_user` 选项卡(如 film 管线的「G3 内人物定妆与三张场景卡是否锁定?」+「锁定并继续」按钮);
- 用户**离开一段时间(> ~33 分钟)后回来点按钮,毫无反应**,流程停死;
- 佐证:此时用户能在输入框正常发消息(如「你卡住了」)——回合在跑时输入框是锁死的,说明**回合其实早已结束**,只是卡片还留着可点的死按钮。

## 二、链路与根因

`ask_user` 完整链路:

```
codex 发起 MCP 调用 ask_user
  → askTools.ts handler(别名统一归一到 canonical 'ask_user')
  → 主进程 ToolRouter.callRenderer(挂 pending + 超时定时器)
  → IPC agent:tool-request → 渲染层 AgentToolExecutor.askUser
  → store.ask() 追加 choiceRequest 卡片,promise 存 choiceResolvers 等点击
  → 用户点击 → settleChoiceRequest → resolve → 工具结果原路返回 codex
```

这条「等人」的链路上挂着**两个约 33 分钟的超时**,而卡片本身没有任何生命周期管理:

| # | 环节 | 问题 |
|---|------|------|
| 1 | 主进程 `ToolRouter` | `RENDERER_TOOL_TIMEOUT_MS = 2_000_000ms (~33.3min)` 对所有渲染层工具一视同仁——为 generate_image 这类「等算力」设计的护栏,砍在了「等人」的 ask_user 头上 |
| 2 | codex 侧 | `mcp_servers.catimation.tool_timeout_sec=2000`(同样 ~33.3min),与 #1 几乎同刻引爆 |
| 3 | 渲染层 store | 只有 `cancel()` / `deleteThread()` 会冻结 pending 卡片;`turn_completed` / 终态 `error` / `cancelled` 事件**都不清理** → 工具调用死了,卡片却永远 pending |
| 4 | 迟到点击 | `settleChoiceRequest` 正常 resolve,响应送回主进程,但 `ToolRouter.handleRendererResponse` 里 `pending.get(id)` 已被超时删除 → **答案被静默丢弃**,无任何提示 |

时间线还原:用户离开 → ~33 分钟时 #1/#2 引爆,MCP 工具向 codex 返回超时错误 → 模型收尾、回合结束 → 卡片成僵尸(#3)→ 用户回来点击 → 答案进黑洞(#4)→「卡住了」。

**这不是 codex 上游 bug。** 上游相关 issues 只是同类问题的旁证(等人输入的阻塞调用必须有明确生命周期归宿):

- [openai/codex#11816](https://github.com/openai/codex/issues/11816) — mcp-server elicitation 无人应答时 `receiver.await` 无限挂起(无超时、无 client capability 检查);
- [openai/codex#15824](https://github.com/openai/codex/issues/15824) / [#16685](https://github.com/openai/codex/issues/16685) — MCP 调用误入 `RequestUserInput` 审批流,非交互环境下卡死/被自动取消。

## 三、修复

设计原则:**「等人」和「等算力」是两种超时**;卡片的可点击态必须与底层工具调用的存活严格同步。

### 1. ToolRouter:ask_user 单独 6 小时窗口(`src/main/mcp/ToolRouter.ts`)

```ts
const ASK_USER_TOOL_TIMEOUT_MS = 21_600_000 // 6h

function rendererToolTimeoutMs(toolName: string): number {
  // 别名(askuser/catimationaskuser/…)在 askTools.ts 已归一到 canonical,单判足够
  return toolName === 'ask_user' ? ASK_USER_TOOL_TIMEOUT_MS : RENDERER_TOOL_TIMEOUT_MS
}
```

其他工具维持 ~33 分钟不变(那是「渲染进程彻底没响应」的护栏,不该放宽)。

### 2. codex 兜底天花板抬高(`src/main/agent/codexLaunch.ts`)

`mcp_servers.catimation.tool_timeout_sec` 从 `2000` → `25000`(~6.9h),**严格高于** 6h 窗口,
保证迟到但有效的点击先于 codex 自己发明超时到达。

安全性论证:codex 的 `tool_timeout_sec` 只是最后兜底——每个 catimation 工具都由我方进程内
ToolRouter 的预算守护(算力工具 ~33min、ask_user 6h),**总会显式返回结果或错误**;codex
天花板只在主进程自身卡死时才有意义。因此抬高它不影响任何算力工具的错误检测时延。
apiyi 的 `tool_timeout_sec=2000` 不动(那边没有 ask 工具)。

### 3. 回合终结冻结僵尸卡(`src/renderer/src/features/agent-chat/store.ts`)

`applyEvent` 收到 `turn_completed` / `cancelled` / 终态 `error`(`willRetry` 瞬态错误除外)时,
对该线程(active 视图或 background slice)执行 `expirePendingChoices`:

- pending 卡片 → `status: 'answered'` + `expired: true`(`ChoiceRequestItem` 新增可选字段,
  `src/types/agent-timeline.ts`);
- 同时 resolve 挂着的 `ask()` promise(ABANDONED skip 答案),executor 的 await 不泄漏。

正确性:卡片 pending 时回合必然阻塞在工具调用上,所以「终结事件 + pending 卡」只可能是
孤儿(底层调用已死),冻结永远不会误伤正常流程。

### 4. 过期态展示(`src/renderer/src/features/agent-chat/cards/AskUserCard.tsx`)

`expired` 卡片渲染为只读提示(`data-testid="ask-user-card-expired"`):

> 该提问已过期(本回合已结束)——直接在下方输入框回复即可继续。

不再显示可点的死按钮,并告诉用户正确的恢复路径。`cancel()`/`deleteThread()` 路径复用同一
helper,也会带上 `expired` 标记(语义同样成立:回合没了)。

## 四、修复后行为

| 场景 | 修复前 | 修复后 |
|------|--------|--------|
| ≤33min 内点击 | 正常 | 正常(不变) |
| 33min–6h 后点击 | 答案静默丢弃,假死 | **直接送达,流程继续** |
| >6h 后 | 永远 pending 的死按钮 | ToolRouter 显式超时 → 回合收尾 → 卡片变过期态,指引用输入框继续 |
| 回合中途因错误/取消死亡 | 死按钮 | 卡片立即冻结为过期态 |
| `willRetry` 瞬态流错误 | — | 卡片保持可点(回合还在重试同一请求) |
| 应用重启 | 卡片本就不落库、不恢复 | 同前(不在本次范围,也不产生僵尸按钮) |

## 五、验证

- `ToolRouter.test.ts` 6/6,新增 3 个假时钟用例:普通工具 33min 照常超时;ask_user 熬过
  33min 后迟到点击仍能 resolve;6h 整点后拒绝;
- `store.askUser.test.ts` 新增「turn-terminal expiry」describe 4 用例:active 线程
  turn_completed 冻结+resolve、终态 error 冻结而 willRetry 不冻结、别的线程终结不误伤、
  background slice 冻结;agent-chat 全目录 76 文件 653/653 全绿;
- `codexLaunch.test.ts` 两处断言更新为 `tool_timeout_sec=25000`(HTTP 与 stdio 路径),
  codexLaunch + MCP tools 套件 147/147;
- 触及文件零 lint;`npm run build:vite` 41.7s 通过(仅预存 INEFFECTIVE_DYNAMIC_IMPORT 警告)。

## 六、涉及文件

| 文件 | 改动 |
|------|------|
| `src/main/mcp/ToolRouter.ts` | ask_user 6h 专属超时 + `rendererToolTimeoutMs()` |
| `src/main/agent/codexLaunch.ts` | catimation `tool_timeout_sec` 2000→25000 + 注释重写 |
| `src/renderer/src/features/agent-chat/store.ts` | 终结事件冻结 pending 卡 + `expirePendingChoices` 带 `expired` 标记 |
| `src/renderer/src/features/agent-chat/cards/AskUserCard.tsx` | 过期态只读渲染 |
| `src/types/agent-timeline.ts` | `ChoiceRequestItem.expired?: boolean` |
| `src/main/mcp/tools/videoTools.ts` | 注释同步(引用的 timeout 值) |
| 测试 | `ToolRouter.test.ts` +3、`store.askUser.test.ts` +4、`codexLaunch.test.ts` 断言更新 |
