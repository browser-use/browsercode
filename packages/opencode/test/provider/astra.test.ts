import { describe, expect, test } from "bun:test"
import { createOpenAI } from "@ai-sdk/openai"
import { generateText, jsonSchema, stepCountIs, tool } from "ai"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Provider } from "../../src/provider/provider"
import { ProviderTransform } from "../../src/provider/transform"

const model: Provider.Model = {
  id: ModelV2.ID.make("astra-alias"),
  providerID: ProviderV2.ID.make("openai"),
  api: { id: "gpt-6-astra", url: "https://api.openai.test/v1", npm: "@ai-sdk/openai" },
  name: "Astra",
  capabilities: {
    temperature: false,
    reasoning: true,
    attachment: true,
    toolcall: true,
    interleaved: false,
    input: { text: true, image: true, audio: false, video: false, pdf: false },
    output: { text: true, image: false, audio: false, video: false, pdf: false },
  },
  cost: { input: 10, output: 50, cache: { read: 1, write: 12.5 } },
  limit: { context: 1050000, input: 922000, output: 128000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "",
}

describe("GPT-6 Astra", () => {
  test("uses the API ID for the five supported variants and valid defaults", () => {
    const variants = ProviderTransform.variants(model)
    expect(Object.keys(variants)).toEqual(["low", "medium", "high", "xhigh", "max"])
    expect(ProviderTransform.options({ model, sessionID: "test", providerOptions: {} })).toMatchObject({
      store: false,
      reasoningEffort: "medium",
      reasoningSummary: "auto",
      include: ["reasoning.encrypted_content"],
    })
    expect(ProviderTransform.smallOptions({ ...model, variants })).toMatchObject({ reasoningEffort: "low" })
  })

  for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
    test(`${effort} reaches Responses and replays encrypted reasoning through a tool round trip`, async () => {
      const requests: Array<{ url: string; body: Record<string, unknown> }> = []
      const sdk = createOpenAI({
        apiKey: "offline-test-key",
        baseURL: model.api.url,
        fetch: Object.assign(
          async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
            requests.push({ url: String(url), body: JSON.parse(String(init?.body)) })
            return Response.json({
              id: `resp_${requests.length}`,
              created_at: 0,
              model: model.api.id,
              output:
                requests.length === 1
                  ? [
                      {
                        type: "reasoning",
                        id: "rs_1",
                        summary: [{ type: "summary_text", text: "Checking." }],
                        encrypted_content: "test-encrypted-state",
                      },
                      { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "{}" },
                    ]
                  : [
                      {
                        type: "message",
                        id: "msg_1",
                        role: "assistant",
                        content: [{ type: "output_text", text: "Done.", annotations: [] }],
                      },
                    ],
              usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
            })
          },
          { preconnect() {} },
        ),
      })
      const defaults = ProviderTransform.options({ model, sessionID: "test", providerOptions: {} })
      const result = await generateText({
        model: sdk.responses(model.api.id),
        prompt: "Call lookup.",
        tools: {
          lookup: tool({
            inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
            execute: async () => "found",
          }),
        },
        stopWhen: stepCountIs(2),
        maxRetries: 0,
        // Even explicitly configured sampling settings must not reach Astra.
        temperature: 0.5,
        topP: 0.9,
        providerOptions: ProviderTransform.providerOptions(model, {
          ...defaults,
          ...ProviderTransform.variants(model)[effort],
        }),
      })
      expect(result.text).toBe("Done.")
      expect(requests).toHaveLength(2)
      for (const request of requests) {
        expect(request.url).toBe("https://api.openai.test/v1/responses")
        expect(request.body).toMatchObject({
          model: "gpt-6-astra",
          store: false,
          reasoning: { effort, summary: "auto" },
          include: ["reasoning.encrypted_content"],
        })
        expect(request.body).not.toHaveProperty("temperature")
        expect(request.body).not.toHaveProperty("top_p")
      }
      expect(requests[1].body.input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "reasoning", encrypted_content: "test-encrypted-state" }),
          expect.objectContaining({ type: "function_call", call_id: "call_1", name: "lookup" }),
          expect.objectContaining({ type: "function_call_output", call_id: "call_1", output: "found" }),
        ]),
      )
    })
  }
})
