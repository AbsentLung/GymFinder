// Ollama in demo mode, Claude in scale mode. `ask` is a plain
// system+messages -> text call; `runAgentTurn` is the tool-calling loop
// bot-review verification needs, shared with chat/sweeps regardless of mode.
export interface ChatMessage {
  role: "user" | "assistant"
  content: string
}

// Same shape as Anthropic's own tool defs (camelCase inputSchema) -
// translated to Ollama's function-calling shape internally.
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
  // Resolves intercepted tool calls itself until a real finding or none
  // at all. Capped at 4 rounds.
  runAgentTurn(params: { system: string; tools: ToolDef[]; messages: ChatMessage[] }): Promise<AgentTurnResult>
}
