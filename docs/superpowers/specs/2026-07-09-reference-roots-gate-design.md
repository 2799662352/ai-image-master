# Reference roots 白名单补齐 + 陈旧引用降级 — 设计

日期:2026-07-09
状态:已获用户批准(方案 B)

## 背景

用户在聊天点 Send 时报错:

```
Error invoking remote method 'agent:send-message':
Error: Reference path is outside allowed roots:
C:\Users\zhihang\AppData\Roaming\catimation-cyberpunk-master\agent\uploads\8ef44e...
```

调研结论(Context7 `/openai/codex` app-server README + developers.openai.com/codex/app-server + GitHub issues):

- 该错误**不是上游 codex 抛的**。官方 `localImage` 接受任意本地绝对路径,序列化时转 base64
  data URL,无 roots 校验;`writableRoots`/`--add-dir` 只管 agent **写**沙箱(workspace-write
  下 agent 全盘可读)。这道闸是本 app 在 `codexUserInput.ts` 自建的隐私边界。
- 生态惯例(codex-control-plane-mcp)同样对 localImage 做 allowed-roots 校验,但**白名单包含
  自家上传目录**。本 app 的 fs IPC 闸(`fsIpc.resolveAllowedRoots`)也白名单了
  `<userData>/agent/uploads`,唯独 send 闸(`mapReferencesToInputItems` 用
  `AgentManager.allowedRoots`)没有 —— 两道闸白名单不对称。

## 两个缺陷

1. **白名单不对称**:从 ATTACHMENTS 树拖文件进聊天、或引用历史消息里的上传附件
   (canonical uploads-cache 路径),fs 闸放行、预览正常,但 Send 必被拒。
2. **陈旧引用绑架整条消息**:跨机器/被清理的 uploads 路径(如上文 zhihang 账号的路径)
   `fs.realpath` ENOENT,整条 send 硬失败,用户无法发送。

## 方案(B)

### 1. 白名单补齐(主进程)

`AgentManager.assembleTurnInput` 调 `mapReferencesToInputItems` 时传
`[...this.allowedRoots, path.join(this.userDataDir, 'agent', 'uploads')]`,与
`fsIpc.resolveAllowedRoots()` 口径对齐。uploads 目录不存在时由现有的
`realpath().catch(() => undefined)` 过滤,无需额外判断。

### 2. 陈旧引用降级(`codexUserInput.ts`)

`ReferenceInputMapping` 增加 `skippedReferences: string[]`(被跳过引用的 label):

- `fs.realpath` 失败(文件不存在/不可读)→ 跳过该引用,label 记入
  `skippedReferences`,**不再 throw**,消息照发。
- 路径**存在**但解析后在 roots 外 → **仍硬 throw**。这是防"任意本地文件→模型视觉
  输入"的安全边界,保持不变。

### 3. 用户可见提示

`assembleTurnInput` 在 thread 解析后,若 `skippedReferences` 非空,经现有
`notice` 事件通道发 `kind: 'attachmentSkipped'` / `level: 'warning'` 通知:
"已跳过 N 个失效附件引用:…"。renderer 已通用渲染 notice,零改动。
(相比原设计"在 sendMessage 返回值加字段 + store pushNotice",改用现成通道,
改动面更小,UX 相同。)

### 4. 测试与注释

- `codexUserInput.reference.test.ts`:
  - 保留"存在但在 roots 外 → 硬拒"两个用例(路径本就在 uploads 白名单外,不受影响)。
  - 新增"ENOENT 引用跳过 + attachmentSkipped notice 上报"。
  - 新增"uploads 目录下的引用放行为 localImage"。
- `MentionInput.tsx` 917-926 行注释更正:fs 闸与 send 闸白名单对齐后,外部拖入
  不推 reference 的理由仍成立(原始 OS 路径仍在两道闸之外),但不再误述两闸同源。

## 不做的事

- 不动 fsIpc、不动上游 codex 参数(`--add-dir`/`writableRoots` 语义不变)。
- 不撤 reference roots 闸(方案 C 已否决)。
- 不做跨机器路径 rebase:uploads 是 content-addressed,文件不在就是不在,
  降级提示已足够。
