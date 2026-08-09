import { createAgentLogStream } from '../agent/logger'
import type { ToolCallRecord } from './toolTelemetry'

/**
 * 工具调用埋点的落盘端:一行一条 JSON,写进 `<userData>/logs/tool-calls-<日期>.log`。
 *
 * 复用 `createAgentLogStream` 而不是自己开文件 —— 按天轮转、目录创建那些它已经做了。
 * JSONL 而不是数据库:这份数据是**追加即写、离线才读**的,用 `Select-String` / `jq`
 * 就能出「哪个工具调用最多、p95 多久、错误率多少」,不值得为它引一个 schema。
 *
 * 单独成文件是因为它 import 了 electron(经 logger),而 `toolTelemetry` 与
 * `ToolRouter` 必须保持零 electron 依赖,否则它们的单测就得每个都 mock 一遍。
 */
export function createToolCallTelemetrySink(): (record: ToolCallRecord) => void {
  let stream: ReturnType<typeof createAgentLogStream> | null | undefined

  return (record) => {
    if (stream === undefined) {
      try {
        stream = createAgentLogStream('tool-calls')
      } catch {
        // 目录不可写等等:记为「这次会话不记录」,别每条都重试一遍。
        stream = null
      }
    }
    stream?.write(`${JSON.stringify(record)}\n`)
  }
}
