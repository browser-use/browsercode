import { describe, expect, test } from "bun:test"
import { ProviderTransform } from "@/provider/transform"

// Regression coverage for the DashScope (Alibaba Cloud Model Studio / Bailian
// / Tongyi) prompt-cache path.
//
// The catalog wires `alibaba`, `alibaba-cn`, `alibaba-coding-plan(-cn)`
// through `@ai-sdk/openai-compatible` pointing at
// `https://dashscope[-intl].aliyuncs.com/compatible-mode/v1`. Prior to this
// patch, `ProviderTransform.message` skipped `applyCaching` for those models
// — even though the upstream service speaks the same cache_control protocol
// `@ai-sdk/alibaba` does
// (https://www.alibabacloud.com/help/zh/model-studio/context-cache). Browser
// agent loops therefore re-sent the full conversation every turn at full
// price, making qwen3-max look more expensive than Opus 4.7.
//
// These tests pin three properties:
//   1. The gate fires for every DashScope-routed providerID.
//   2. `cache_control` lands on a content *block*, not on the message
//      envelope — Bailian rejects it at message level.
//   3. System messages, which arrive as plain strings from `session/llm.ts`,
//      get lifted into a single-block array so the block-level path applies.

type AnyModel = Parameters<typeof ProviderTransform.message>[1]

const dashscopeOpenAICompatibleModel = (overrides: Partial<any> = {}): AnyModel =>
  ({
    id: "alibaba-cn/qwen3-max",
    providerID: "alibaba-cn",
    api: {
      id: "qwen3-max",
      url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      npm: "@ai-sdk/openai-compatible",
    },
    name: "Qwen3 Max",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 1.2, output: 6 },
    limit: { context: 262144, output: 65536 },
    status: "active",
    options: {},
    headers: {},
    ...overrides,
  }) as any

describe("ProviderTransform.message - DashScope (alibaba-*) cache_control", () => {
  test("alibaba-cn via openai-compatible: cache_control lands on the last content block of system+last messages", () => {
    const model = dashscopeOpenAICompatibleModel()
    const msgs = [
      { role: "system", content: "You are a helpful browser agent." },
      { role: "system", content: "Tools: browser_execute, search." },
      { role: "user", content: "Find flights from NYC to SF tomorrow." },
      { role: "assistant", content: [{ type: "text", text: "I'll start by searching." }] },
    ] as any[]

    const result = ProviderTransform.message(msgs, model, {}) as any[]

    // System messages were lifted from string → array so cache_control can
    // ride on a content block.
    expect(Array.isArray(result[0].content)).toBe(true)
    expect(Array.isArray(result[1].content)).toBe(true)

    // The wire-relevant marker for DashScope is `openaiCompatible.cache_control`
    // (snake_case) — the SDK spreads this onto the content block; the other
    // namespaces stay attached so the same loop output can switch providers
    // without remarking. Allow extra namespaces (anthropic/openrouter/etc.)
    // since they are documented dead weight when the wire goes via OAI-compat.
    for (const i of [0, 1, 2, 3]) {
      const lastBlock = result[i].content[result[i].content.length - 1]
      expect(lastBlock.providerOptions.openaiCompatible.cache_control).toEqual({
        type: "ephemeral",
      })
      // The Alibaba SDK namespace must also be set for the case where a user
      // pins `@ai-sdk/alibaba` instead of openai-compatible — same one-pass
      // marking, no second transform needed.
      expect(lastBlock.providerOptions.alibaba.cacheControl).toEqual({
        type: "ephemeral",
      })
      // Cache_control must NOT leak onto the message envelope; Bailian will
      // not look there and would still create a fresh prefix every turn.
      expect(result[i].providerOptions?.openaiCompatible?.cache_control).toBeUndefined()
    }
  })

  test("alibaba (intl) is treated the same as alibaba-cn", () => {
    const model = dashscopeOpenAICompatibleModel({
      providerID: "alibaba",
      api: {
        id: "qwen3-max",
        url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        npm: "@ai-sdk/openai-compatible",
      },
    })
    const msgs = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "user message" },
    ] as any[]

    const result = ProviderTransform.message(msgs, model, {}) as any[]

    expect(Array.isArray(result[0].content)).toBe(true)
    expect(result[0].content[0].providerOptions.openaiCompatible.cache_control).toEqual({
      type: "ephemeral",
    })
  })

  test("alibaba-coding-plan-cn (subscription tier) also gets cache_control", () => {
    const model = dashscopeOpenAICompatibleModel({
      providerID: "alibaba-coding-plan-cn",
      id: "alibaba-coding-plan-cn/qwen3-coder-plus",
      api: {
        id: "qwen3-coder-plus",
        url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        npm: "@ai-sdk/openai-compatible",
      },
    })
    const msgs = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "user message" },
    ] as any[]

    const result = ProviderTransform.message(msgs, model, {}) as any[]

    const block = result[0].content[0]
    expect(block.providerOptions.openaiCompatible.cache_control).toEqual({ type: "ephemeral" })
  })

  test("at most 4 markers — first 2 system + last 2 non-system (matches Bailian's 4-breakpoint cap)", () => {
    const model = dashscopeOpenAICompatibleModel()
    const msgs = [
      { role: "system", content: "sys A (marked)" },
      { role: "system", content: "sys B (marked)" },
      { role: "system", content: "sys C (NOT marked)" }, // beyond first 2
      { role: "user", content: "u1 (NOT marked)" },
      { role: "assistant", content: [{ type: "text", text: "a1 (NOT marked)" }] },
      { role: "user", content: "u2 (marked - second to last)" },
      { role: "assistant", content: [{ type: "text", text: "a2 (marked - last)" }] },
    ] as any[]

    const result = ProviderTransform.message(msgs, model, {}) as any[]

    const hasMarker = (m: any) => {
      if (Array.isArray(m.content) && m.content.length > 0) {
        const last = m.content[m.content.length - 1]
        return last?.providerOptions?.openaiCompatible?.cache_control != null
      }
      return m.providerOptions?.openaiCompatible?.cache_control != null
    }

    expect(hasMarker(result[0])).toBe(true) // sys A
    expect(hasMarker(result[1])).toBe(true) // sys B
    expect(hasMarker(result[2])).toBe(false) // sys C — beyond the first 2 system slots
    expect(hasMarker(result[3])).toBe(false) // u1 — not in the last 2
    expect(hasMarker(result[4])).toBe(false) // a1 — not in the last 2
    expect(hasMarker(result[5])).toBe(true) // u2 — second-to-last non-system
    expect(hasMarker(result[6])).toBe(true) // a2 — last non-system
  })

  test("string system content survives sanitization and gets a real text block", () => {
    const model = dashscopeOpenAICompatibleModel()
    const msgs = [{ role: "system", content: "hello world" }, { role: "user", content: "hi" }] as any[]

    const result = ProviderTransform.message(msgs, model, {}) as any[]

    expect(result[0].content).toEqual([
      {
        type: "text",
        text: "hello world",
        providerOptions: expect.objectContaining({
          openaiCompatible: { cache_control: { type: "ephemeral" } },
          alibaba: { cacheControl: { type: "ephemeral" } },
        }),
      },
    ])
  })

  test("empty system content is left alone (no spurious empty block, no marker)", () => {
    const model = dashscopeOpenAICompatibleModel()
    // sanitizeSurrogates collapses to "" then the system stays as empty
    // string; we should not generate a `[{ type: "text", text: "" }]` block.
    const msgs = [{ role: "system", content: "" }, { role: "user", content: "hi" }] as any[]

    const result = ProviderTransform.message(msgs, model, {}) as any[]

    expect(result[0].content).toBe("")
  })

  test("@ai-sdk/alibaba SDK path still works (defense in depth)", () => {
    const model = dashscopeOpenAICompatibleModel({
      api: {
        id: "qwen3-max",
        url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        npm: "@ai-sdk/alibaba",
      },
    })
    const msgs = [
      { role: "system", content: "sys" },
      { role: "user", content: [{ type: "text", text: "u" }] },
    ] as any[]

    const result = ProviderTransform.message(msgs, model, {}) as any[]

    expect(result[0].content[0].providerOptions.alibaba.cacheControl).toEqual({
      type: "ephemeral",
    })
    expect(result[1].content[0].providerOptions.alibaba.cacheControl).toEqual({
      type: "ephemeral",
    })
  })

  test("gateway-routed alibaba is excluded (gateway handles caching itself)", () => {
    const model = dashscopeOpenAICompatibleModel({
      providerID: "vercel",
      api: {
        id: "alibaba/qwen3-max",
        url: "https://ai-gateway.vercel.sh/v3/ai",
        npm: "@ai-sdk/gateway",
      },
    })
    const msgs = [
      { role: "system", content: "sys" },
      { role: "user", content: "u" },
    ] as any[]

    const result = ProviderTransform.message(msgs, model, {}) as any[]

    // Gateway path must NOT inject cache_control — the gateway provider does
    // its own caching via `gateway: { caching: "auto" }` set in
    // ProviderTransform.options. Double-marking would risk double-billing.
    expect(result[0].content).toBe("sys")
    expect(result[0].providerOptions).toBeUndefined()
  })

  test("non-DashScope openai-compatible provider (e.g. deepseek direct) is still excluded", () => {
    const model = dashscopeOpenAICompatibleModel({
      providerID: "deepseek",
      id: "deepseek/deepseek-chat",
      api: {
        id: "deepseek-chat",
        url: "https://api.deepseek.com/v1",
        npm: "@ai-sdk/openai-compatible",
      },
    })
    const msgs = [
      { role: "system", content: "sys" },
      { role: "user", content: "u" },
    ] as any[]

    const result = ProviderTransform.message(msgs, model, {}) as any[]

    // DeepSeek's direct API uses implicit caching — no per-message
    // cache_control to set. Keep the current no-op behaviour for it; if
    // someone routes deepseek through DashScope's alibaba-cn provider, that
    // model's providerID will be "alibaba-cn" and the gate above fires.
    expect(result[0].content).toBe("sys")
    expect(result[0].providerOptions).toBeUndefined()
  })
})

describe("ProviderTransform.message - providerOptions key remap for @ai-sdk/alibaba", () => {
  test("stored providerID 'alibaba-cn' remaps to SDK key 'alibaba' when api.npm is @ai-sdk/alibaba", () => {
    // Sessions that were originally written with providerID `alibaba-cn`
    // persist providerOptions under that exact key. When the SDK switches
    // to `@ai-sdk/alibaba`, sdkKey() must remap to "alibaba" so the
    // serialized options reach the provider plugin.
    const model = dashscopeOpenAICompatibleModel({
      api: {
        id: "qwen3-max",
        url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        npm: "@ai-sdk/alibaba",
      },
    })
    const msgs = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "hello",
            providerOptions: {
              "alibaba-cn": { cacheControl: { type: "ephemeral" } },
            },
          },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, model, {}) as any[]
    const block = result[0].content[0]
    expect(block.providerOptions.alibaba?.cacheControl).toEqual({ type: "ephemeral" })
    expect(block.providerOptions["alibaba-cn"]).toBeUndefined()
  })
})
