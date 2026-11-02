// Ollama in demo mode, Claude in scale mode (DESIGN_DISCUSSION.md
// section 1, STACK_AND_SCHEMA.md 1.10). Deliberately simple for this
// slice - just a system+messages -> text ask, no tool-calling yet.
// Porting the old demo's tool-use loop (price-finding, web_search,
// record_* tools - server/ai.js) for real chat (API.md 2.4b) is its own
// module, built separately per the "modules split so they can be built
// in parallel" plan.
export interface ChatMessage {
  role: "user" | "assistant"
  content: string
}

export interface LLMInterface {
  ask(params: { system: string; messages: ChatMessage[] }): Promise<string>
}
