// FetchUse smoke tests.
//
// Unit: layer is constructible, `enabled` reflects direct and proxy credentials.
// Live: when the key is set, end-to-end POST to fetch.browser-use.com returns
//       body bytes + content-type. Skipped without the key. Config-based
//       opt-in (experimental.fetch_use=true) is enforced in webfetch.ts,
//       not here.

import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { FetchUse } from "../src/fetch-use"

const haveCredential = !!process.env.BROWSER_USE_API_KEY || !!process.env.BROWSER_USE_FETCH_TOKEN

test("layer constructs and exposes `enabled` reflecting env", async () => {
  const enabled = await Effect.gen(function* () {
    return (yield* FetchUse.Service).enabled
  }).pipe(Effect.provide(FetchUse.layer.pipe(Layer.provide(FetchHttpClient.layer))), Effect.runPromise)
  expect(enabled).toBe(haveCredential)
})

test.skipIf(!process.env.BROWSER_USE_API_KEY)("live: fetches httpbin and returns body + content-type", async () => {
  const result = await Effect.gen(function* () {
    return yield* (yield* FetchUse.Service).fetch("https://httpbin.org/get", { timeoutMs: 30_000 })
  }).pipe(Effect.provide(FetchUse.layer.pipe(Layer.provide(FetchHttpClient.layer))), Effect.runPromise)

  expect(result.contentType).toContain("application/json")
  expect(JSON.parse(new TextDecoder().decode(result.body)).url).toBe("https://httpbin.org/get")
})

test("scoped proxy token uses bearer auth instead of the API-key header", async () => {
  const request = { authorization: "", apiKey: "", body: {} as Record<string, unknown> }
  const server = Bun.serve({
    port: 0,
    fetch: async (incoming) => {
      request.authorization = incoming.headers.get("authorization") ?? ""
      request.apiKey = incoming.headers.get("x-browser-use-api-key") ?? ""
      request.body = (await incoming.json()) as Record<string, unknown>
      return Response.json({
        status_code: 200,
        headers: { "content-type": ["text/plain"] },
        body: "proxied",
      })
    },
  })

  try {
    const result = await Effect.gen(function* () {
      const service = yield* FetchUse.Service
      expect(service.enabled).toBe(true)
      return yield* service.fetch("https://example.com/page", { timeoutMs: 12_345 })
    }).pipe(
      Effect.provide(
        FetchUse.makeLayer({
          proxyUrl: server.url.toString(),
          apiKey: "",
          proxyToken: "v4rt_test",
        }).pipe(Layer.provide(FetchHttpClient.layer)),
      ),
      Effect.runPromise,
    )

    expect(request.authorization).toBe("Bearer v4rt_test")
    expect(request.apiKey).toBe("")
    expect(request.body).toEqual({ url: "https://example.com/page", timeout_ms: 12_345 })
    expect(new TextDecoder().decode(result.body)).toBe("proxied")
  } finally {
    server.stop(true)
  }
})

test.each([
  { proxyUrl: "https://proxy.example/fetch", proxyToken: "", apiKey: "bu_secret" },
  { proxyUrl: "", proxyToken: "v4rt_secret", apiKey: "bu_secret" },
])("partial proxy configuration fails closed", async (options) => {
  const result = await Effect.gen(function* () {
    const service = yield* FetchUse.Service
    expect(service.enabled).toBe(false)
    return yield* Effect.flip(service.fetch("https://example.com", { timeoutMs: 1_000 }))
  }).pipe(
    Effect.provide(FetchUse.makeLayer(options).pipe(Layer.provide(FetchHttpClient.layer))),
    Effect.runPromise,
  )

  expect(result.message).toContain("partially configured")
})
