// Ollama in demo mode, Claude in scale mode (DESIGN_DISCUSSION.md
// section 1, STACK_AND_SCHEMA.md 1.10). `ask` is the simple system+
// messages -> text call (real chat, API.md 2.4b, will use this).
// `runAgentTurn` is the tool-calling loop bot-review verification needs
// (src/jobs/bot-review.ts) - ported from the old demo's runAgentTurn
// (server/ai.js), generalized behind this interface so chat, bot-review
// and sweeps can all share it regardless of AI_PROVIDER/MODE.
export interface ChatMessage {
  role: "user" | "assistant"
  content: string
}

// Same shape Anthropic's own tool defs use (`input_schema` renamed to
// `inputSchema` for camelCase consistency with the rest of this
// codebase) - translated to Ollama's OpenAI-style function-calling shape
// internally by each implementation.
export interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface ToolUse {
  name: string
  input: Record<string, unknown>
}

export interface AgentTurnResult {
  text: string
  toolUses: ToolUse[]
}

export interface LLMInterface {
  ask(params: { system: string; messages: ChatMessage[] }): Promise<string>
  // Loops internally, resolving any INTERCEPTED_TOOL_NAMES tool call
  // (src/llm/tools.ts) itself and feeding the result back, until the
  // model produces a non-intercepted tool call (a real finding for the
  // caller) or no tool call at all. Capped at 4 rounds.
  runAgentTurn(params: { system: string; tools: ToolDef[]; messages: ChatMessage[] }): Promise<AgentTurnResult>
}
