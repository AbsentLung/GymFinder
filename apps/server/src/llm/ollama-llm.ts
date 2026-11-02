import { Ollama } from "ollama"
import type { LLMInterface, ChatMessage } from "../interfaces/llm.js"

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
}
