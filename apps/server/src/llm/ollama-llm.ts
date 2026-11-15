import { Ollama } from "ollama"
import type { Message, Tool } from "ollama"
import type { LLMInterface, ChatMessage, ToolDef, AgentTurnResult } from "../interfaces/llm.js"
import { INTERCEPTED_TOOL_NAMES, runIntercepted } from "./tools.js"

function toOllamaTool(tool: ToolDef): Tool {
  return { type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }
}

export class OllamaLLM implements LLMInterface {
  private client: Ollama
  private model: string

  constructor(host: string, model: string) {
    this.client = new Ollama({ host })
    this.model = model
  }

  async ask({ system, messages }: { system: string; messages: ChatMessage[] }): Promise<string> {
    const response = await this.client.chat({
      model: this.model,
      messages: [{ role: "system", content: system }, ...messages],
    })
    return response.message.content
  }

  // A Chromium-launching tool call can starve the next ollama.chat() on a small machine - one retry.
  private async chatWithRetry(convo: Message[], ollamaTools: Tool[]) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await this.client.chat({ model: this.model, messages: convo, ...(ollamaTools.length ? { tools: ollamaTools } : {}) })
      } catch (e) {
        console.error(`Ollama chat call failed (attempt ${attempt}/2):`, (e as Error).message)
        if (attempt === 2) throw e
        await new Promise((r) => setTimeout(r, 3000))
      }
    }
    throw new Error("unreachable")
  }

  async runAgentTurn({
    system,
    tools,
    messages,
  }: {
    system: string
    tools: ToolDef[]
    messages: ChatMessage[]
  }): Promise<AgentTurnResult> {
    const ollamaTools = tools.map(toOllamaTool)
    let convo: Message[] = [{ role: "system", content: system }, ...messages]

    for (let round = 0; round < 4; round++) {
      const response = await this.chatWithRetry(convo, ollamaTools)
      const calls = response.message.tool_calls || []
      const otherCalls = calls.filter((c) => !INTERCEPTED_TOOL_NAMES.has(c.function.name))
      const interceptedCalls = calls.filter((c) => INTERCEPTED_TOOL_NAMES.has(c.function.name))

      if (calls.length === 0 || otherCalls.length > 0) {
        return {
          text: response.message.content || "",
          toolUses: otherCalls.map((c) => ({ name: c.function.name, input: c.function.arguments })),
        }
      }

      convo = [...convo, { role: "assistant", content: response.message.content || "", tool_calls: calls }]
      for (const call of interceptedCalls) {
        const result = await runIntercepted(call.function.name, call.function.arguments)
        convo = [...convo, { role: "tool", content: JSON.stringify(result) }]
      }
    }
    return { text: "", toolUses: [] }
  }
}
