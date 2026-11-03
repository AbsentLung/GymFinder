import Anthropic from "@anthropic-ai/sdk"
import type { LLMInterface, ChatMessage, ToolDef, AgentTurnResult } from "../interfaces/llm.js"
import { INTERCEPTED_TOOL_NAMES, runIntercepted } from "./tools.js"

export class ClaudeLLM implements LLMInterface {
  private client: Anthropic
  private model: string

  // Haiku, not a bigger model - same choice the old demo code made
  // (server/ai.js's ANTHROPIC_MODEL): this runs on every chat message,
  // so cost per call matters more than it would for a one-off task.
  constructor(apiKey: string, model = "claude-haiku-4-5-20251001") {
    this.client = new Anthropic({ apiKey })
    this.model = model
  }

  async ask({ system, messages }: { system: string; messages: ChatMessage[] }): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 500,
      system,
      messages,
    })
    return response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
  }

  // Ported from server/ai.js's runAnthropicTurn. Loops because fetch_url
  // (and web_search, on this path) needs a real round trip: call the
  // model, run whichever intercepted tool it asked for ourselves, feed
  // the result back, let it continue. Stops as soon as the model
  // produces any NON-intercepted tool call (a real finding for the
  // caller) or no tool call at all.
  async runAgentTurn({
    system,
    tools,
    messages,
  }: {
    system: string
    tools: ToolDef[]
    messages: ChatMessage[]
  }): Promise<AgentTurnResult> {
    // Cast: ToolDef.inputSchema is a plain JSON-schema object (so the
    // Ollama path - src/llm/ollama-llm.ts - can take the same ToolDef
    // unchanged); every real inputSchema this app defines already has
    // `type: "object"`, satisfying Anthropic's stricter InputSchema type
    // at runtime even though the generic Record type doesn't prove it.
    const anthropicTools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as { type: "object"; properties?: unknown; required?: string[] },
    }))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let convo: any[] = messages

    for (let round = 0; round < 4; round++) {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 500,
        system,
        ...(anthropicTools.length ? { tools: anthropicTools } : {}),
        messages: convo,
      })
      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("")
      const toolUseBlocks = response.content.filter((b) => b.type === "tool_use")
      const otherUses = toolUseBlocks.filter((b) => !INTERCEPTED_TOOL_NAMES.has(b.name))
      const interceptedUses = toolUseBlocks.filter((b) => INTERCEPTED_TOOL_NAMES.has(b.name))

      if (otherUses.length > 0) {
        return { text, toolUses: otherUses.map((b) => ({ name: b.name, input: b.input as Record<string, unknown> })) }
      }
      if (interceptedUses.length === 0) return { text, toolUses: [] }

      const toolResults = []
      for (const toolUse of interceptedUses) {
        const result = await runIntercepted(toolUse.name, toolUse.input as Record<string, unknown>)
        toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: JSON.stringify(result) })
      }
      convo = [...convo, { role: "assistant", content: response.content }, { role: "user", content: toolResults }]
    }
    return { text: "", toolUses: [] }
  }
}
