import { MODE, config } from "../config.js"
import { OllamaLLM } from "./ollama-llm.js"
import { ClaudeLLM } from "./claude-llm.js"
import type { LLMInterface } from "../interfaces/llm.js"

export const llm: LLMInterface =
  MODE === "scale" ? new ClaudeLLM(config.anthropicApiKey) : new OllamaLLM(config.ollamaHost, config.ollamaModel)
