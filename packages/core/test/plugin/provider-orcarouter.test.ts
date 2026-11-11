import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Catalog } from "@opencode-ai/core/catalog"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { PluginHost } from "@opencode-ai/core/plugin/host"
import { ProviderPlugins } from "@opencode-ai/core/plugin/provider"
import { OrcaRouterPlugin } from "@opencode-ai/core/plugin/provider/orcarouter"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const addPlugin = Effect.fn(function* () {
  const plugin = yield* PluginV2.Service
  const host = yield* PluginHost.make(plugin)
  yield* OrcaRouterPlugin.effect(host)
})

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value")
  return value
}

const withOrcaRouterProvider = Effect.fn(function* (mutate?: (headers: Record<string, string>) => void) {
  const catalog = yield* Catalog.Service
  yield* catalog.transform((catalog) => {
    catalog.provider.update(ProviderV2.ID.make("orcarouter"), (provider) => {
      provider.api = {
        type: "aisdk",
        package: "@ai-sdk/openai-compatible",
        url: "https://api.orcarouter.ai/v1",
      }
      mutate?.(provider.request.headers)
    })
  })
  return catalog
})

describe("OrcaRouterPlugin", () => {
  it.effect("is registered so attribution headers can be applied", () =>
    Effect.sync(() => expect(ProviderPlugins.map((item) => item.id)).toContain(PluginV2.ID.make("orcarouter"))),
  )

  it.effect("applies the bcode attribution headers", () =>
    Effect.gen(function* () {
      const catalog = yield* withOrcaRouterProvider()
      yield* addPlugin()
      const result = required(yield* catalog.provider.get(ProviderV2.ID.make("orcarouter")))
      expect(result.request.headers).toEqual({ "HTTP-Referer": "https://bcode.sh/", "X-Title": "bcode" })
    }),
  )

  it.effect("merges attribution headers with existing headers", () =>
    Effect.gen(function* () {
      const catalog = yield* withOrcaRouterProvider((headers) => {
        headers.Existing = "value"
      })
      yield* addPlugin()

      expect(required(yield* catalog.provider.get(ProviderV2.ID.make("orcarouter"))).request.headers).toEqual({
        Existing: "value",
        "HTTP-Referer": "https://bcode.sh/",
        "X-Title": "bcode",
      })
    }),
  )

  it.effect("lets configured headers override the defaults", () =>
    Effect.gen(function* () {
      const catalog = yield* withOrcaRouterProvider((headers) => {
        headers["HTTP-Referer"] = "https://example.com/"
        headers["X-Title"] = "custom-title"
      })
      yield* addPlugin()

      expect(required(yield* catalog.provider.get(ProviderV2.ID.make("orcarouter"))).request.headers).toEqual({
        "HTTP-Referer": "https://example.com/",
        "X-Title": "custom-title",
      })
    }),
  )

  it.effect("guards attribution headers to the orcarouter base URL", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* catalog.transform((catalog) => {
        catalog.provider.update(ProviderV2.ID.openrouter, (provider) => {
          provider.request.headers = { "HTTP-Referer": "https://example.com/", "X-Title": "custom-title" }
        })
      })
      yield* addPlugin()

      expect(required(yield* catalog.provider.get(ProviderV2.ID.openrouter)).request.headers).toEqual({
        "HTTP-Referer": "https://example.com/",
        "X-Title": "custom-title",
      })
    }),
  )
})
