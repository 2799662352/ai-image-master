# 交接：下一轮开工顺序

2026-08-09 凌晨。上一轮上下文耗尽，以下按依赖顺序排列，**第 1 条不做完，第 2、3 条的验证都不算数**。

---

## 1. 先把本地 codex 拉到 0.147（阻塞项）

```
codexCliVersion (package.json)  0.147.0
本地 resources/codex/win32-x64  0.146.0   ← 落后
装机版 4.4.30                   0.147.0   ← 是对的
```

**本地比装机版旧，不是反过来。** 文件大小具有误导性：0.146 是 342MB，0.147 反而只有 284.8MB。

后果：上一轮所有「开发版实测通过」的结论**都建立在错误基线上**——测的是 0.146，用户跑的是 0.147，两个不同的程序。

```bash
pnpm codex:fetch     # 按 package.json 锁定的 0.147
```

做完这步，再回头重验 PR #215 里的两笔改动。

---

## 2. 补 `fetch-codex.ts` 漏掉的二进制

0.147 的 Windows x64 release 有**五个**可执行体，我们只打了三个：

| 资产 | 打了吗 |
|---|---|
| `codex-x86_64-pc-windows-msvc.exe` | ✅ |
| `codex-command-runner-x86_64-pc-windows-msvc.exe` | ✅ |
| `codex-windows-sandbox-setup-x86_64-pc-windows-msvc.exe` | ✅ |
| `codex-code-mode-host-x86_64-pc-windows-msvc.exe` | ❌ |
| `codex-responses-api-proxy-x86_64-pc-windows-msvc.exe` | ❌ |

命名规律与已有两条完全一致（`codex-<name>-<triple>.exe`），照着 `fetch-codex.ts` L113-118 加即可，不用猜。

`codex-code-mode-host` 缺失是装机版报「找不到程序 …\codex-code-mode-host.exe」的直接原因——0.146 不需要它，0.147 需要，所以升级时没暴露。

**顺带查**：`codex-responses-api-proxy` 是干什么的。如果它能替代我们手写的 `responsesCompatibilityProxy.ts`，那 namespace 桥那条线可以整个简化。

**做完加守护**：打包后校验 codex 目录里该有的二进制一个都不少。今晚这个坑本该在升级 CLI 时就被拦住。

---

## 3. IR 加「只占位」条目 + 内容卡硬闸

### 用户诉求

> 我不希望有这样一次会写全部的操作

实际发生的：只想改「480p + 联网 + 智能时长」，agent 却 export 整板 17 张卡再 apply，模型要把 17 段完整提示词读完改完再吐回来。中途 JSON 解析失败重来，最后还得再写一遍恢复顺序。用户全程看着 RUNNING 干等。

### 为什么不能简单加张数闸（重要）

`videoWorkbenchTools.ts` L765-768 已有注释说明：IR 的数组顺序**就是**页内顺序，合并模式下没列出的卡会被追加到列出的卡后面（`workbenchIR.placeExisting`）。限制张数会让「重排一个 20 张卡的页」变成不可能——只列前 5 张就把它们顶到最前、其余全被挤下去。

### 真正的病根

**声明式 + 重排 = 必须携带全部内容。** 重排只需要 id，但协议规定省略字段 = 恢复默认，于是为了挪位置也得把所有提示词搬一遍。

### 方案

给 IR 加一种「只占位」条目：合并模式下，**只有 `id`、没有任何其他字段**的卡 = 「这张卡放在这个位置，内容一个字别动」。

于是：
- 重排 20 张卡 → 20 个纯 id，payload 极小
- 只有真要改内容的卡才带字段
- 然后就能安全加硬闸：**一次 apply 里「带内容的卡」不得超过 N 张**（建议 5，与 `WORKBENCH_MAX_TASKS_PER_CALL` 对齐），重排不受影响

### 风险与做法

改的是写入核心语义。**半套实现会让「只占位」的卡被当成「全部字段恢复默认」，一次 apply 清空整板提示词**——这是唯一会造成不可逆数据损失的改动。

必须：
1. 先写红测（只占位条目不改内容 / 混合条目各行其是 / 超闸被拒且零写入）
2. 再改 `workbenchIR.ts`
3. 现有 apply 测试全绿后才提交

### 已经做了的部分（PR #215 内）

`apply` 的描述已改：不再自称「多卡改动首选」，开头改为三条分流——同规格扫全板走 `set_spec`、单卡走 `update_task`、多卡不同提示词逐卡 `update_task`；并写明「剩给 apply 的只有改变卡片/页面的集合与顺序」。

但**描述是建议，模型可以不听**。用户要的是拦，所以第 3 条仍需做。

---

## 未合并的 PR

- [#214](https://github.com/2799662352/ai-image-master/pull/214) — 开发文档（渐进披露复盘 + 多模态记忆库计划）
- [#215](https://github.com/2799662352/ai-image-master/pull/215) — qwen namespace 桥 + apply 描述分流。**先做第 1 条再验，别急着合**

## 今晚反复犯的一个错

四次把「手头唯一那条线索」当成病因：先怪 skill，再怪 namespace，又怪缺二进制，最后才发现基线本身就是错的。

`unsupported call:` 是**症状**。每次拿到一条新证据就重写结论，而没有先问「这条证据能排除掉什么」。下次遇到多重故障，先列出所有候选，再用证据逐个排除，而不是让最新的证据独占解释权。
