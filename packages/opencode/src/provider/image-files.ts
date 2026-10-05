import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider"

type Uploaded = { file_id: string; expires_at: number; signature: string }
type Options = { baseURL: string; apiKey: string; fetch?: typeof fetch; now?: () => number }
type Lease = { keys: Set<string>; files: Set<string> }
type RunCache = {
  leases: Set<Lease>
  lock: Promise<void>
  expiresAt: number
  chain: boolean
  chainKeys: Set<string>
  owners: Set<symbol>
  cache: Map<string, Promise<Uploaded>>
  ready: Map<string, Uploaded>
  busy: boolean
  refreshed: Set<string>
  retired: Uploaded[]
  waiting: Array<() => void>
  active: number
  closed: boolean
}
const runCaches = new Map<string, RunCache>()

export function withImageFiles(model: LanguageModelV3, options: Options) {
  let state: RunCache = {
    leases: new Set(),
    lock: Promise.resolve(),
    expiresAt: 0,
    chain: false,
    chainKeys: new Set(),
    owners: new Set(),
    cache: new Map(),
    ready: new Map(),
    busy: false,
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
  let cacheID: string | undefined
  let scope: string | undefined
  let routeHeaders: Record<string, string> = {}
  const anthropic = /\/anthropic\/v1\/?$/.test(new URL(options.baseURL).pathname)
  const enabled =
    Boolean(options.apiKey) &&
    /^\/(?:_v4\/bcode-relay\/[^/]+\/)?api\/v4\/llm\/(?:openai|anthropic)\/v1\/?$/.test(
      new URL(options.baseURL).pathname,
    )

  async function locked<T>(call: () => Promise<T>): Promise<T> {
    const prior = state.lock
    const next = Promise.withResolvers<void>()
    state.lock = next.promise
    await prior
    state.busy = true
    try {
      return await call()
    } finally {
      state.busy = false
      next.resolve()
    }
  }

  // Retry only explicit transient HTTP failures. A network failure after an upload
  // has an unknown outcome, so blindly retrying it could create orphaned files.
  async function request(url: string, init: RequestInit) {
    for (let attempt = 0; ; attempt++) {
      init.signal?.throwIfAborted()
      const response = await send(url, init)
      if (![429, 502, 503, 504].includes(response.status) || attempt === 2) return response
      await response.body?.cancel()
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer)
          reject(init.signal?.reason)
        }
        const timer = setTimeout(
          () => {
            init.signal?.removeEventListener("abort", abort)
            resolve()
          },
          100 * 2 ** attempt,
        )
        init.signal?.addEventListener("abort", abort, { once: true })
        if (init.signal?.aborted) abort()
      })
    }
  }

  function identity(data: string | Uint8Array | URL, mediaType: string) {
    const raw = data instanceof URL ? data.toString().split(",", 2)[1] : data
    const bytes = typeof raw === "string" ? Buffer.from(raw, "base64") : raw
    if (bytes.byteLength > 5 * 1024 * 1024) throw new Error("Screenshot exceeds upload limit")
    return { bytes, key: `${mediaType}:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}` }
  }

  async function cleanup(signal?: AbortSignal) {
    const pinned = new Set([...state.leases].flatMap((lease) => [...lease.files]))
    if (state.closed) {
      for (const [key, pending] of state.cache) {
        if ([...state.leases].some((lease) => lease.keys.has(key))) continue
        if (state.retired.length >= 300) break
        const file = await pending.catch(() => undefined)
        state.cache.delete(key)
        state.ready.delete(key)
        state.refreshed.delete(key)
        if (file) state.retired.push(file)
      }
    }
    // Cleanup is best effort with one total deadline, including retries. A
    // deletion outage must not hold the request lock for one timeout per file.
    const deadline = AbortSignal.any([AbortSignal.timeout(1000), ...(signal ? [signal] : [])])
    const removed = new Set<Uploaded>()
    let attempted = 0
    for (const file of state.retired) {
      if (pinned.has(file.file_id) || (state.chain && !state.closed)) continue
      if (file.expires_at <= now() / 1000) {
        removed.add(file)
        continue
      }
      if (deadline.aborted || attempted++ >= (state.closed ? 300 : 8)) break
      const response = await request(
        `${endpoint}/${encodeURIComponent(file.file_id)}?model=${encodeURIComponent(model.modelId)}`,
        {
          method: "DELETE",
          headers: { ...routeHeaders, "x-bu-image-scope": scope! },
          signal: deadline,
        },
      ).catch(() => undefined)
      if (!response?.ok && response?.status !== 404) break
      removed.add(file)
    }
    state.retired = state.retired.filter((file) => !removed.has(file))
    if (state.closed && !state.cache.size && !state.retired.length && cacheID && runCaches.get(cacheID) === state)
      runCaches.delete(cacheID)
  }

  async function prepare(params: LanguageModelV3CallOptions, lease: Lease): Promise<LanguageModelV3CallOptions> {
    if (!enabled) return params
    const stateful =
      !anthropic &&
      (typeof params.providerOptions?.openai?.previousResponseId === "string" ||
        params.providerOptions?.openai?.store === true)
    if (stateful) {
      state.chain = true
      for (const key of state.cache.keys()) state.chainKeys.add(key)
    }
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
    const capability = await request(`${endpoint}/capability?model=${encodeURIComponent(model.modelId)}`, {
      headers: currentHeaders,
      signal,
    })
    // Older gateways have no upload contract. Never fall back after selecting reference mode.
    if (capability.status === 404 && !scope) return params
    if (!capability.ok) throw new Error(`Screenshot capability failed (${capability.status})`)
    const route = (await capability.json()) as {
      supported: boolean
      scope?: string
      max_references?: number
      proof_transport?: string
    }
    if (!route.supported && !scope) return params
    if (!route.supported || !route.scope || (scope && scope !== route.scope))
      throw new Error("Screenshot route or account changed; start a new run")
    if (closed || state.closed) throw new Error("Screenshot file cache is closed")
    scope = route.scope
    cacheID = `${endpoint}:${model.modelId}:${scope}`
    for (const [id, cached] of runCaches) {
      if (cached.closed && !cached.leases.size && cached.expiresAt <= now() / 1000) runCaches.delete(id)
    }
    if (!runCaches.has(cacheID) && runCaches.size >= 128) throw new Error("Too many active screenshot caches")
    state = runCaches.get(cacheID) ?? state
    if (state.closed) throw new Error("Screenshot file cache is closing; retry cleanup first")
    if (stateful) {
      state.chain = true
      for (const key of state.cache.keys()) state.chainKeys.add(key)
    }
    state.owners.add(owner)
    runCaches.set(cacheID, state)
    routeHeaders = currentHeaders
    const limit = route.proof_transport === "body" && route.max_references === 300 ? 300 : 64
    const keys = new Set<string>()
    for (const message of params.prompt) {
      if (message.role === "user")
        for (const part of message.content) {
          if (
            part.type === "file" &&
            part.mediaType.startsWith("image/") &&
            (!(part.data instanceof URL) || part.data.protocol === "data:")
          )
            keys.add(identity(part.data, part.mediaType).key)
        }
      if (message.role === "tool")
        for (const part of message.content) {
          if (part.type === "tool-result" && part.output.type === "content")
            for (const item of part.output.value) {
              if (item.type === "image-data") keys.add(identity(item.data, item.mediaType).key)
            }
        }
    }
    const cached = [...keys].every((key) => (state.ready.get(key)?.expires_at ?? 0) > now() / 1000 + 30)
    const work = async () => {
      signal.throwIfAborted()
      if (closed || state.closed) throw new Error("Screenshot file cache is closed")
      if (keys.size > limit)
        throw new Error(
          `Screenshot request needs ${keys.size} distinct images; gateway limit is ${limit}. Compact history before retrying`,
        )
      const pinned = new Set([...state.chainKeys, ...[...state.leases].flatMap((item) => [...item.keys])])
      if (new Set([...pinned, ...keys]).size > 300)
        throw new Error(
          "Screenshot cache has 300 images in active requests or a stateful response chain; finish active requests or start a new chain",
        )
      lease.keys = keys
      state.leases.add(lease)
      if (!cached) await cleanup(signal)
      const missing = [...keys].filter((key) => !state.cache.has(key)).length
      for (const key of state.cache.keys()) {
        if (state.cache.size + missing <= 300) break
        if (keys.has(key) || state.chainKeys.has(key) || [...state.leases].some((item) => item.keys.has(key))) continue
        if (state.retired.length >= 300)
          throw new Error("Screenshot cleanup backlog is full; retry cleanup before uploading")
        state.retired.push(state.ready.get(key)!)
        state.cache.delete(key)
        state.ready.delete(key)
        state.refreshed.delete(key)
      }
      if (state.cache.size + missing > 300)
        throw new Error("Screenshot cache has 300 pinned images; retry after active requests finish")
      // Provider-side previousResponseId history may still depend on omitted
      // files. Keep explicit stateful chains until close; never assume a copy.
      if (state.chain) for (const key of keys) state.chainKeys.add(key)
      lease.keys = keys
      state.leases.add(lease)
      if (!cached) await cleanup(signal)
      const headers = { ...currentHeaders, "x-bu-image-scope": scope! }
      const proofs: Record<string, { expires_at: number; signature: string }> = {}
      async function upload(data: string | Uint8Array | URL, mediaType: string) {
        const { bytes, key } = identity(data, mediaType)
        const ready = state.ready.get(key)
        if (ready && ready.expires_at > now() / 1000 + 30) {
          lease.files.add(ready.file_id)
          proofs[ready.file_id] = { expires_at: ready.expires_at, signature: ready.signature }
          return ready.file_id
        }
        if (state.active >= 2) await new Promise<void>((resolve) => state.waiting.push(resolve))
        else state.active++
        try {
          signal.throwIfAborted()
          if (closed || state.closed) throw new Error("Screenshot file cache is closed")
          let existing = state.cache.get(key)
          if (existing) {
            const file = await existing
            if (state.cache.get(key) !== existing) existing = state.cache.get(key)
            else if (file.expires_at <= now() / 1000 + 30) {
              if (state.refreshed.has(key)) throw new Error("Screenshot reference expired again; start a new run")
              if (state.retired.length >= 300) throw new Error("Screenshot cleanup backlog is full")
              state.refreshed.add(key)
              state.retired.push(file)
              state.ready.delete(key)
              existing = undefined
            }
          }
          const pending =
            existing ??
            (async () => {
              const response = await request(`${endpoint}?model=${encodeURIComponent(model.modelId)}`, {
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
              state.expiresAt = Math.max(state.expiresAt, uploaded.expires_at)
              return uploaded
            })()
          state.cache.set(key, pending)
          const uploaded = await pending.catch((error) => {
            if (state.cache.get(key) === pending) {
              state.cache.delete(key)
              state.ready.delete(key)
              if (!state.refreshed.has(key)) state.chainKeys.delete(key)
              state.refreshed.delete(key)
            }
            throw error
          })
          state.ready.set(key, uploaded)
          if (uploaded.expires_at <= now() / 1000 + 30) throw new Error("Screenshot reference expired; start a new run")
          signal.throwIfAborted()
          if (closed || state.closed) throw new Error("Screenshot file cache is closed")
          lease.files.add(uploaded.file_id)
          proofs[uploaded.file_id] = { expires_at: uploaded.expires_at, signature: uploaded.signature }
          return uploaded.file_id
        } finally {
          const next = state.waiting.shift()
          if (next) next()
          else state.active--
        }
      }
      const prompt = await settled(
        params.prompt.map(async (message) => {
          if (message.role === "tool")
            return {
              ...message,
              content: await settled(
                message.content.map(async (part) => {
                  if (part.type !== "tool-result" || part.output.type !== "content") return part
                  return {
                    ...part,
                    output: {
                      ...part.output,
                      value: await settled(
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
            content: await settled(
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
      const encoded = JSON.stringify(proofs)
      if (route.proof_transport !== "body" && Buffer.byteLength(encoded) > 12 * 1024)
        throw new Error("Screenshot proofs exceed legacy header limit; upgrade the gateway")
      return {
        ...params,
        prompt,
        headers: {
          ...params.headers,
          "x-bu-image-scope": scope!,
          "x-bu-image-proofs": encoded,
          ...(route.proof_transport === "body" ? { "x-bu-image-proof-transport": "body" } : {}),
        },
      }
    }
    return cached ? work() : locked(work)
  }

  async function release(lease: Lease) {
    state.leases.delete(lease)
    // A cache-hit call must not queue its completion behind unrelated uploads.
    // The current lock holder performs deferred cleanup when it releases its lease.
    if (!state.busy) await locked(() => cleanup())
  }

  async function invoke<T>(
    params: LanguageModelV3CallOptions,
    lease: Lease,
    call: (prepared: LanguageModelV3CallOptions) => PromiseLike<T>,
  ): Promise<T> {
    try {
      return await call(await prepare(params, lease))
    } catch (error) {
      const message = error instanceof Error ? error.message : ""
      if (!/file.*(not found|does not exist|expired|deleted)/i.test(message)) throw error
      await locked(async () => {
        const entries = await settled([...state.cache].map(async ([key, pending]) => ({ key, file: await pending })))
        const missing = entries.filter(({ file }) => lease.files.has(file.file_id) && message.includes(file.file_id))
        if (!missing.length || missing.some(({ key }) => state.refreshed.has(key))) throw error
        if (state.retired.length + missing.length > 300) throw error
        for (const { key, file } of missing) {
          state.refreshed.add(key)
          state.retired.push(file)
          state.cache.delete(key)
          state.ready.delete(key)
        }
      })
      return await call(await prepare(params, lease))
    }
  }

  return {
    specificationVersion: model.specificationVersion,
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    async doGenerate(params: LanguageModelV3CallOptions) {
      const lease: Lease = { keys: new Set(), files: new Set() }
      try {
        return await invoke(params, lease, (prepared) => model.doGenerate(prepared))
      } finally {
        await release(lease)
      }
    },
    async doStream(params: LanguageModelV3CallOptions) {
      const lease: Lease = { keys: new Set(), files: new Set() }
      try {
        const result = await invoke(params, lease, (prepared) => model.doStream(prepared))
        const reader = result.stream.getReader()
        let finished = false
        const finish = async () => {
          if (finished) return
          finished = true
          params.abortSignal?.removeEventListener("abort", abort)
          await release(lease)
        }
        const abort = () => {
          void reader
            .cancel(params.abortSignal?.reason)
            .finally(finish)
            .catch(() => {})
        }
        params.abortSignal?.addEventListener("abort", abort, { once: true })
        if (params.abortSignal?.aborted) abort()
        return {
          ...result,
          stream: new ReadableStream({
            async pull(controller) {
              try {
                const item = await reader.read()
                if (item.done) {
                  await finish()
                  controller.close()
                  return
                }
                controller.enqueue(item.value)
              } catch (error) {
                await finish()
                controller.error(error)
              }
            },
            async cancel(reason) {
              try {
                await reader.cancel(reason)
              } finally {
                await finish()
              }
            },
          }),
        }
      } catch (error) {
        await release(lease)
        throw error
      }
    },
    async closeImageFiles() {
      closed = true
      await locked(async () => {
        state.owners.delete(owner)
        if (state.owners.size) return
        state.closed = true
        await cleanup()
      })
    },
  }
}

async function settled<T>(items: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(items)
  const failed = results.find((item) => item.status === "rejected")
  if (failed?.status === "rejected") throw failed.reason
  return results.map((item) => (item as PromiseFulfilledResult<T>).value)
}

// The pinned SDK lacks tool-result file IDs; only small placeholders enter its JSON serializer.
export function imageFileRequest(init?: RequestInit): RequestInit | undefined {
  if (!init || !new Headers(init.headers).has("x-bu-image-scope") || typeof init.body !== "string") return init
  const body = JSON.parse(init.body)
  const headers = new Headers(init.headers)
  if (headers.get("x-bu-image-proof-transport") === "body") {
    const proofs = headers.get("x-bu-image-proofs") ?? "{}"
    if (Buffer.byteLength(proofs) > 128 * 1024 || Object.keys(JSON.parse(proofs)).length > 300)
      throw new Error("Screenshot proof body limit exceeded")
    body._image_file_proofs = JSON.parse(proofs)
    body._image_file_scope = headers.get("x-bu-image-scope")
    headers.delete("x-bu-image-proofs")
  }
  headers.delete("x-bu-image-proof-transport")
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
    headers.set(
      "anthropic-beta",
      [...new Set([...(headers.get("anthropic-beta")?.split(",") ?? []), "files-api-2025-04-14"])].join(","),
    )
    return { ...init, headers, body: JSON.stringify(body) }
  }
  return { ...init, headers, body: JSON.stringify(body) }
}
