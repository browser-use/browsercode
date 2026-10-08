import { expect, test } from "bun:test"
import { hostedSearchTools } from "../../src/session/llm/hosted-search"

test("hosted web search is opt-in, keeps local browser tools and has no local executor", () => {
  const tools = {}
  const options = { enabled: false, npm: "@ai-sdk/openai", oauth: false, nativeRuntime: false, tools }
  expect(hostedSearchTools(options)).toBe(tools)
  const result = hostedSearchTools({ ...options, enabled: true })
  expect(result.web_search.type).toBe("provider")
  expect(result.web_search.execute).toBeUndefined()
  expect(result.web_search).toMatchObject({ id: "openai.web_search", args: { searchContextSize: "medium", externalWebAccess: true } })
})

test("unsupported routes fail explicitly instead of silently substituting retrieval", () => {
  const options = { enabled: true, npm: "@ai-sdk/openai", oauth: false, nativeRuntime: false, tools: {} }
  for (const change of [{ oauth: true }, { nativeRuntime: true }, { npm: "@ai-sdk/openai-compatible" }]) {
    expect(() => hostedSearchTools({ ...options, ...change })).toThrow("Responses")
  }
})
