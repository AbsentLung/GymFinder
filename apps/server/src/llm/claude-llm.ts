import Anthropic from "@anthropic-ai/sdk"
import type { LLMInterface, ChatMessage } from "../interfaces/llm.js"

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
      max_tokens: 500,
      system,
      messages,
    })
    return response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
  }
}
