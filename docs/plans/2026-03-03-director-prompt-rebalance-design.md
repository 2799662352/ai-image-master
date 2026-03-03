# Director Prompt Rebalance — 演出优先设计

## 背景

队友 FuYuhao 在 28a58e7 和 acb6e1b 中实现了 `sceneDescription` 的优先级提升，将用户输入标记为 HIGHEST PRIORITY / MUST FOLLOW，覆盖场景分析、分镜设计、图像生成三个 pass。

问题：措辞过于强制，把 AI 锁死在用户原文上，压制了导演系统的专业演出能力（镜头语言、构图、光影、叙事节奏）。

## 目标

将用户输入从"最高优先级指令"降级为"创意简报/约束"，让导演 AI 拥有镜头语言的全权自主权。

## 设计决策

**方案 A（已选）：Prompt 措辞降级** — 只改 4 处字符串，不动架构/逻辑。

核心原则：
- 用户输入 = 约束（主题、方向、人物设定）
- 导演演出 = 核心（镜头设计、构图、光影、节奏全由 AI 自主）

## 改动清单

| # | 位置 | 行号 | 当前措辞 | 改为 |
|---|------|------|----------|------|
| 1 | Pass 1 场景分析 user msg | ~350 | "用户意图优先于图片细节" | "图片视觉事实优先，简报提供叙事方向" |
| 2 | Pass 3 分镜 system (userDirective) | ~491 | "HIGHEST PRIORITY — MUST FOLLOW" | "Director's Creative Brief" + AI 全权 |
| 3 | Pass 3 分镜 user msg | ~504 | "最高优先级 — 严格按照" | "创意简报 — 全权决定" |
| 4 | Pass 5 extractVarsForContactSheet | ~179 | "highest priority" | "narrative context" |

## 不改的

- 架构、逻辑、skill 系统、graph 路由 — 全部不动
- 只改 `DirectorPipeline.ts` 中 4 处 prompt 字符串
