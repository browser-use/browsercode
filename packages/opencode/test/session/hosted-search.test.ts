import { expect, test } from "bun:test"
import { createOpenAI } from "@ai-sdk/openai"
import { generateText } from "ai"
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


test("SDK lowers the hosted tool and automatically requests sources", async () => {
  const requests: Record<string, unknown>[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push(await request.json())
      return Response.json({
        id: "resp_test", object: "response", created_at: 1, model: "gpt-6-luna",
        output: [{ type: "message", id: "msg_test", role: "assistant", content: [{ type: "output_text", text: "ok", annotations: [] }] }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      })
    },
  })
  try {
    const result = await generateText({
      model: createOpenAI({ apiKey: "fixture-only", baseURL: `http://localhost:${server.port}/v1` }).responses("gpt-6-luna"),
      tools: hostedSearchTools({ enabled: true, npm: "@ai-sdk/openai", oauth: false, nativeRuntime: false, tools: {} }),
      prompt: "Search the web", maxRetries: 0,
    })
    expect(result.text).toBe("ok")
    expect(requests).toHaveLength(1)
    expect(requests[0].tools).toEqual([{ type: "web_search", search_context_size: "medium", external_web_access: true }])
    expect(requests[0].include).toContain("web_search_call.action.sources")
  } finally {
    server.stop(true)
  }
})
