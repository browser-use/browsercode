import { describe, expect } from "bun:test"
import { ConfigProvider, Effect, Schema } from "effect"
import { HttpClientRequest } from "effect/unstable/http"
import { LLM } from "../../src"
import { LLMClient } from "../../src/route"
import * as NearAI from "../../src/providers/nearai"
import { it } from "../lib/effect"
import { dynamicResponse } from "../lib/http"
import { sseEvents } from "../lib/sse"

const Json = Schema.fromJsonString(Schema.Unknown)
const decodeJson = Schema.decodeUnknownSync(Json)

const chunk = (delta: object, finishReason: string | null = null) => ({
  id: "chatcmpl_nearai_fixture",
  choices: [{ delta, finish_reason: finishReason }],
  usage: null,
})

const usage = (tokens: object) => ({
  id: "chatcmpl_nearai_fixture",
  choices: [],
  usage: tokens,
})

const withEnv = (env: Record<string, string>) => Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })))

describe("NEAR AI provider", () => {
  it.effect("prepares OpenAI-compatible chat requests", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          id: "req_nearai_prepare",
          model: NearAI.model("nearai-test", {
            apiKey: "test-key",
            baseURL: "https://custom.near.test/v1",
          }),
          system: "You are concise.",
          prompt: "Say hello.",
          generation: { maxTokens: 32, temperature: 0 },
        }),
      )

      expect(prepared.route).toBe("openai-compatible-chat")
      expect(prepared.model).toMatchObject({
        id: "nearai-test",
        provider: "nearai",
        route: "openai-compatible-chat",
        baseURL: "https://custom.near.test/v1",
      })
      expect(prepared.body).toEqual({
        model: "nearai-test",
        messages: [
          { role: "system", content: "You are concise." },
          { role: "user", content: "Say hello." },
        ],
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 32,
        temperature: 0,
      })
    }),
  )

  it.effect("uses NEARAI_API_KEY as bearer auth", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(
        LLM.request({
          id: "req_nearai_env",
          model: NearAI.model("nearai-test"),
          prompt: "Say hello.",
        }),
      ).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
              expect(web.url).toBe("https://cloud-api.near.ai/v1/chat/completions")
              expect(web.headers.get("authorization")).toBe("Bearer env-key")
              expect(decodeJson(input.text)).toMatchObject({
                model: "nearai-test",
                stream: true,
                messages: [{ role: "user", content: "Say hello." }],
              })
              return input.respond(
                sseEvents(
                  chunk({ role: "assistant", content: "Hello" }),
                  chunk({ content: "." }),
                  chunk({}, "stop"),
                  usage({ prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }),
                ),
                { headers: { "content-type": "text/event-stream" } },
              )
            }),
          ),
        ),
        withEnv({ NEARAI_API_KEY: "env-key" }),
      )

      expect(response.text).toBe("Hello.")
      expect(response.usage).toMatchObject({ inputTokens: 4, outputTokens: 2, totalTokens: 6 })
    }),
  )
})
