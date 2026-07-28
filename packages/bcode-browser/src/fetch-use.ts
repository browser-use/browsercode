// FetchUse — Effect service that proxies HTTP through Browser Use's fetch-use
// cloud (Chrome JA4, HTTP/2 header order, session cookies). Decisions §3.3.
// `enabled` is true when either a direct Browser Use API key or a scoped proxy
// token is set; webfetch.ts combines this with the user's
// `experimental.fetch_use` opencode.json setting.

import { Context, Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"

const DEFAULT_ENDPOINT = "https://fetch.browser-use.com/fetch"

export interface FetchResult {
  readonly body: ArrayBuffer
  readonly contentType: string
}

interface FetchUseRaw {
  status_code: number
  headers?: Record<string, string[]>
  body?: string
  body_base64?: string
  is_binary?: boolean
  error?: string
}

export class Service extends Context.Service<Service, {
  readonly enabled: boolean
  readonly fetch: (url: string, opts: { timeoutMs: number }) => Effect.Effect<FetchResult, Error>
}>()("@browser-use/FetchUse") {}

export const makeLayer = (options: { proxyUrl: string; apiKey: string; proxyToken: string }) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      const hasProxySetting = options.proxyUrl.length > 0 || options.proxyToken.length > 0
      const proxyEnabled = options.proxyUrl.length > 0 && options.proxyToken.length > 0
      const directEnabled = !hasProxySetting && options.apiKey.length > 0
      return Service.of({
        enabled: proxyEnabled || directEnabled,
        fetch: (url, { timeoutMs }) =>
          Effect.gen(function* () {
            if (!proxyEnabled && !directEnabled) {
              return yield* Effect.fail(new Error("fetch-use credentials are missing or partially configured"))
            }
            const auth = proxyEnabled
              ? { Authorization: `Bearer ${options.proxyToken}` }
              : { "X-Browser-Use-API-Key": options.apiKey }
            const request = yield* HttpClientRequest.post(proxyEnabled ? options.proxyUrl : DEFAULT_ENDPOINT).pipe(
              HttpClientRequest.setHeaders({ "Content-Type": "application/json", ...auth }),
              HttpClientRequest.bodyJson({ url, timeout_ms: timeoutMs }),
            )
            const response = yield* HttpClient.filterStatusOk(http).execute(request)
            const data = (yield* response.json) as unknown as FetchUseRaw
            if (data.error) return yield* Effect.fail(new Error(`fetch-use: ${data.error}`))
            // Mirror native path's filterStatusOk: surface upstream HTTP errors as failures.
            if (data.status_code >= 400) return yield* Effect.fail(new Error(`fetch-use: HTTP ${data.status_code}`))
            const body =
              data.is_binary && data.body_base64
                ? (new Uint8Array(Buffer.from(data.body_base64, "base64")).buffer as ArrayBuffer)
                : (new TextEncoder().encode(data.body ?? "").buffer as ArrayBuffer)
            const ct =
              Object.entries(data.headers ?? {}).find(([k]) => k.toLowerCase() === "content-type")?.[1]?.[0] ?? ""
            return { body, contentType: ct }
          }).pipe(Effect.mapError((e) => (e instanceof Error ? e : new Error(String(e))))),
      })
    }),
  )

export const layer = makeLayer({
  proxyUrl: process.env.BROWSER_USE_FETCH_URL ?? "",
  apiKey: process.env.BROWSER_USE_API_KEY ?? "",
  proxyToken: process.env.BROWSER_USE_FETCH_TOKEN ?? "",
})

export * as FetchUse from "./fetch-use"
