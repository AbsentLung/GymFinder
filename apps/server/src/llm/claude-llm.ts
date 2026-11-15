import Anthropic from "@anthropic-ai/sdk"
import type { LLMInterface, ChatMessage, ToolDef, AgentTurnResult } from "../interfaces/llm.js"
import { INTERCEPTED_TOOL_NAMES, runIntercepted } from "./tools.js"

const MAX_TOKENS = 500

function extractText(content: { type: string; text?: string }[]): string {
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
}

export class ClaudeLLM implements LLMInterface {
  private client: Anthropic
  private model: string

  // Haiku, not a bigger model - runs on every chat message, so cost per
  // call matters.
  constructor(apiKey: string, model = "claude-haiku-4-5-20251001") {
    this.client = new Anthropic({ apiKey })
    this.model = model
  }

  async ask({ system, messages }: { system: string; messages: ChatMessage[] }): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: MAX_TOKENS,
      system,
      messages,
    })
    return extractText(response.content)
  }

  // Loops to run any intercepted tool call ourselves and feed the result back; stops on a real finding.
  async runAgentTurn({
    system,
    tools,
    messages,
  }: {
    system: string
    tools: ToolDef[]
    messages: ChatMessage[]
  }): Promise<AgentTurnResult> {
    // Cast: every real inputSchema here already has `type: "object"`, satisfying Anthropic's stricter type.
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
        max_tokens: MAX_TOKENS,
        system,
        ...(anthropicTools.length ? { tools: anthropicTools } : {}),
        messages: convo,
      })
      const text = extractText(response.content)
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
