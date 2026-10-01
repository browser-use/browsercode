import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider"

type Uploaded = { file_id: string; expires_at: number; signature: string }
type Options = { baseURL: string; apiKey: string; fetch?: typeof fetch; now?: () => number }
type RunCache = {
  owners: Set<symbol>
  cache: Map<string, Promise<Uploaded>>
  refreshed: Set<string>
  retired: Uploaded[]
  waiting: Array<() => void>
  active: number
  closed: boolean
}
const runCaches = new Map<string, RunCache>()

export function withImageFiles(model: LanguageModelV3, options: Options) {
  let state: RunCache = {
    owners: new Set(),
    cache: new Map(),
    refreshed: new Set(),
    retired: [],
    waiting: [],
    active: 0,
    closed: false,
  }
  const owner = Symbol()
  let closed = false
  const now = options.now ?? Date.now
  const endpoint = options.baseURL.replace(/\/$/, "") + "/image-files"
  const send = options.fetch ?? fetch
  let scope: string | undefined
  let routeHeaders: Record<string, string> = {}
  const anthropic = /\/anthropic\/v1\/?$/.test(new URL(options.baseURL).pathname)
  const enabled =
    Boolean(options.apiKey) &&
    /^\/(?:_v4\/bcode-relay\/[^/]+\/)?api\/v4\/llm\/(?:openai|anthropic)\/v1\/?$/.test(
      new URL(options.baseURL).pathname,
    )

  async function prepare(params: LanguageModelV3CallOptions): Promise<LanguageModelV3CallOptions> {
    if (!enabled) return params
    const hasImages = params.prompt.some(
      (message) =>
        (message.role === "user" &&
          message.content.some(
            (part) =>
              part.type === "file" &&
              part.mediaType.startsWith("image/") &&
              (!(part.data instanceof URL) || part.data.protocol === "data:"),
          )) ||
        (message.role === "tool" &&
          message.content.some(
            (part) =>
              part.type === "tool-result" &&
              part.output.type === "content" &&
              part.output.value.some((item) => item.type === "image-data"),
          )),
    )
    if (!hasImages) return params
    if (closed || state.closed) throw new Error("Screenshot file cache is closed")
    const previous = params.providerOptions?.openai?.previousResponseId
    const legacy = params.prompt.some(
      (message) =>
        message.role === "assistant" &&
        message.content.some(
          (part) =>
            part.type === "reasoning" &&
            String(part.providerOptions?.openai?.reasoningEncryptedContent ?? "").startsWith("gAAAAA"),
        ),
    )
    const currentHeaders = {
      Authorization: `Bearer ${options.apiKey}`,
      ...(typeof previous === "string" ? { "x-bu-previous-response-id": previous } : {}),
      ...(legacy ? { "x-bu-openai-reasoning": "1" } : {}),
    }
    const signal = AbortSignal.any([...(params.abortSignal ? [params.abortSignal] : []), AbortSignal.timeout(30_000)])
    const capability = await send(`${endpoint}/capability?model=${encodeURIComponent(model.modelId)}`, {
      headers: currentHeaders,
      signal,
    })
    // Older gateways have no upload contract. Never fall back after selecting reference mode.
    if (capability.status === 404 && !scope) return params
    if (!capability.ok) throw new Error(`Screenshot capability failed (${capability.status})`)
    const route = (await capability.json()) as { supported: boolean; scope?: string }
    if (!route.supported && !scope) return params
    if (!route.supported || !route.scope || (scope && scope !== route.scope))
      throw new Error("Screenshot route or account changed; start a new run")
    if (closed || state.closed) throw new Error("Screenshot file cache is closed")
    scope = route.scope
    if (!runCaches.has(scope) && runCaches.size >= 128) throw new Error("Too many active screenshot caches")
    state = runCaches.get(scope) ?? state
    state.owners.add(owner)
    runCaches.set(scope, state)
    routeHeaders = currentHeaders
    const headers = { ...currentHeaders, "x-bu-image-scope": scope }
    const proofs: Record<string, { expires_at: number; signature: string }> = {}
    async function upload(data: string | Uint8Array | URL, mediaType: string) {
      if (state.active >= 2) await new Promise<void>((resolve) => state.waiting.push(resolve))
      else state.active++
      try {
        signal.throwIfAborted()
        if (closed || state.closed) throw new Error("Screenshot file cache is closed")
        const raw = data instanceof URL ? data.toString().split(",", 2)[1] : data
        const bytes = typeof raw === "string" ? Buffer.from(raw, "base64") : raw
        if (bytes.byteLength > 5 * 1024 * 1024) throw new Error("Screenshot exceeds upload limit")
        const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
        const key = `${scope}:${mediaType}:${hash}`
        let existing = state.cache.get(key)
        if (existing) {
          const file = await existing
          if (state.cache.get(key) !== existing) existing = state.cache.get(key)
          else if (file.expires_at <= now() / 1000 + 30) {
            if (state.refreshed.has(key)) throw new Error("Screenshot reference expired again; start a new run")
            state.refreshed.add(key)
            state.retired.push(file)
            existing = undefined
          }
        }
        if (!existing && !state.cache.has(key) && state.cache.size >= 64)
          throw new Error("Screenshot file limit reached; start a new run")
        const pending =
          existing ??
          (async () => {
            const response = await send(`${endpoint}?model=${encodeURIComponent(model.modelId)}`, {
              method: "POST",
              headers: { ...headers, "content-type": mediaType },
              body: new Uint8Array(bytes),
              signal,
            })
            if (!response.ok) throw new Error(`Screenshot upload failed (${response.status})`)
            const uploaded = (await response.json()) as Uploaded
            if (!uploaded.file_id?.startsWith(anthropic ? "file_" : "file-"))
              throw new Error("Invalid screenshot file ID")
            if (!(uploaded.expires_at > now() / 1000 + 30)) throw new Error("Screenshot reference expired")
            return uploaded
          })()
        state.cache.set(key, pending)
        const uploaded = await pending.catch((error) => {
          if (state.cache.get(key) === pending) state.cache.delete(key)
          throw error
        })
        if (uploaded.expires_at <= now() / 1000 + 30) throw new Error("Screenshot reference expired; start a new run")
        signal.throwIfAborted()
        if (closed || state.closed) throw new Error("Screenshot file cache is closed")
        proofs[uploaded.file_id] = { expires_at: uploaded.expires_at, signature: uploaded.signature }
        return uploaded.file_id
      } finally {
        const next = state.waiting.shift()
        if (next) next()
        else state.active--
      }
    }
    const prompt = await Promise.all(
      params.prompt.map(async (message) => {
        if (message.role === "tool")
          return {
            ...message,
            content: await Promise.all(
              message.content.map(async (part) => {
                if (part.type !== "tool-result" || part.output.type !== "content") return part
                return {
                  ...part,
                  output: {
                    ...part.output,
                    value: await Promise.all(
                      part.output.value.map(async (item) => {
                        if (item.type !== "image-data") return item
                        return {
                          type: "image-url" as const,
                          url: `bu-${anthropic ? "anthropic" : "openai"}-file:${await upload(item.data, item.mediaType)}`,
                          providerOptions: item.providerOptions,
                        }
                      }),
                    ),
                  },
                }
              }),
            ),
          }
        if (message.role !== "user") return message
        return {
          ...message,
          content: await Promise.all(
            message.content.map(async (part) => {
              if (
                part.type !== "file" ||
                !part.mediaType.startsWith("image/") ||
                (part.data instanceof URL && part.data.protocol !== "data:")
              )
                return part
              const id = await upload(part.data, part.mediaType)
              return { ...part, data: anthropic ? new URL(`bu-anthropic-file:${id}`) : id }
            }),
          ),
        }
      }),
    )
    return {
      ...params,
      prompt,
      headers: { ...params.headers, "x-bu-image-scope": scope, "x-bu-image-proofs": JSON.stringify(proofs) },
    }
  }

  async function invoke<T>(
    params: LanguageModelV3CallOptions,
    call: (prepared: LanguageModelV3CallOptions) => PromiseLike<T>,
  ): Promise<T> {
    try {
      return await call(await prepare(params))
    } catch (error) {
      const message = error instanceof Error ? error.message : ""
      if (!/file.*(not found|does not exist|expired|deleted)/i.test(message)) throw error
      const entries = await Promise.all([...state.cache].map(async ([key, pending]) => ({ key, file: await pending })))
      const missing = entries.filter(({ file }) => message.includes(file.file_id))
      if (!missing.length || missing.some(({ key }) => state.refreshed.has(key))) throw error
      for (const { key, file } of missing) {
        state.refreshed.add(key)
        state.retired.push(file)
        state.cache.delete(key)
      }
      return await call(await prepare(params))
    }
  }

  return {
    specificationVersion: model.specificationVersion,
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    async doGenerate(params: LanguageModelV3CallOptions) {
      return invoke(params, (prepared) => model.doGenerate(prepared))
    },
    async doStream(params: LanguageModelV3CallOptions) {
      return invoke(params, (prepared) => model.doStream(prepared))
    },
    async closeImageFiles() {
      if (closed) return
      closed = true
      state.owners.delete(owner)
      if (state.owners.size) return
      state.closed = true
      if (scope && runCaches.get(scope) === state) runCaches.delete(scope)
      const entries = await Promise.allSettled([
        ...state.cache.values(),
        ...state.retired.map((file) => Promise.resolve(file)),
      ])
      await Promise.allSettled(
        entries
          .filter((entry) => entry.status === "fulfilled")
          .map((entry) =>
            send(`${endpoint}/${encodeURIComponent(entry.value.file_id)}?model=${encodeURIComponent(model.modelId)}`, {
              method: "DELETE",
              headers: { ...routeHeaders, "x-bu-image-scope": scope! },
              signal: AbortSignal.timeout(10_000),
            }),
          ),
      )
      state.cache.clear()
    },
  }
}

// The pinned SDK lacks tool-result file IDs; only small placeholders enter its JSON serializer.
export function imageFileRequest(init?: RequestInit): RequestInit | undefined {
  if (!init || !new Headers(init.headers).has("x-bu-image-scope") || typeof init.body !== "string") return init
  const body = JSON.parse(init.body)
  if (Array.isArray(body.input))
    body.input = body.input.map((item: Record<string, unknown>) => {
      if (!item || typeof item !== "object") return item
      const field =
        item.type === "function_call_output" || item.type === "custom_tool_call_output" ? "output" : "content"
      if (!Array.isArray(item[field])) return item
      return {
        ...item,
        [field]: item[field].map((part: Record<string, unknown>) => {
          if (
            part?.type !== "input_image" ||
            typeof part.image_url !== "string" ||
            !part.image_url.startsWith("bu-openai-file:file-")
          )
            return part
          const { image_url, ...rest } = part
          return { ...rest, file_id: image_url.slice("bu-openai-file:".length) }
        }),
      }
    })
  if (Array.isArray(body.messages)) {
    const rewrite = (content: Array<Record<string, unknown>>): Array<Record<string, unknown>> =>
      content.map((part) => {
        if (part?.type === "tool_result" && Array.isArray(part.content))
          return { ...part, content: rewrite(part.content) }
        const source = part?.source as { type?: string; url?: string } | undefined
        if (part?.type !== "image" || source?.type !== "url" || !source.url?.startsWith("bu-anthropic-file:file_"))
          return part
        return { ...part, source: { type: "file", file_id: source.url.slice("bu-anthropic-file:".length) } }
      })
    body.messages = body.messages.map((message: Record<string, unknown>) =>
      Array.isArray(message.content) ? { ...message, content: rewrite(message.content) } : message,
    )
    const headers = new Headers(init.headers)
    headers.set(
      "anthropic-beta",
      [...new Set([...(headers.get("anthropic-beta")?.split(",") ?? []), "files-api-2025-04-14"])].join(","),
    )
    return { ...init, headers, body: JSON.stringify(body) }
  }
  return { ...init, body: JSON.stringify(body) }
}
