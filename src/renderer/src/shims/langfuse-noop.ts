/**
 * No-op shim for langfuse-langchain in Electron renderer.
 * Langfuse is a tracing/observability tool that requires Node.js fs module.
 * The storyboard pipeline doesn't need it.
 */
export class CallbackHandler {
  constructor(_opts?: any) {}
  handleLLMStart() {}
  handleLLMEnd() {}
  handleChainStart() {}
  handleChainEnd() {}
  handleToolStart() {}
  handleToolEnd() {}
  handleLLMError() {}
  handleChainError() {}
  handleToolError() {}
}
export default CallbackHandler
