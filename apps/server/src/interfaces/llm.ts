// Ollama in demo mode, Claude in scale mode. Just a system+messages ->
// text ask for now; tool-calling is a separate module.
export interface ChatMessage {
  role: "user" | "assistant"
  content: string
}

export interface LLMInterface {
  ask(params: { system: string; messages: ChatMessage[] }): Promise<string>
}
