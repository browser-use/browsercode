import { openai } from "@ai-sdk/openai"
import type { Tool } from "ai"

// Hosted execution stays in the executor's Responses turn; no local handler or retrieval model.
export const hostedSearchTools = (input: {
  enabled: boolean
  npm: string
  oauth: boolean
  nativeRuntime: boolean
  tools: Record<string, Tool>
}): Record<string, Tool> => {
  if (!input.enabled) return input.tools
  if (input.npm !== "@ai-sdk/openai" || input.oauth || input.nativeRuntime) {
    throw new Error("Native web search requires the OpenAI Responses API-key AI SDK route")
  }
  return {
    ...input.tools,
    // The pinned ai/OpenAI packages resolve separate schema-symbol type identities.
    // Provider-defined tools use the shared runtime shape; exercised by the live smoke.
    web_search: openai.tools.webSearch({ searchContextSize: "medium", externalWebAccess: true }) as unknown as Tool,
  }
}
