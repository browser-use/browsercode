import { expect, test } from "bun:test"
import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { imageFileRequest, withImageFiles } from "../../src/provider/image-files"

function images(start: number, count: number): LanguageModelV3CallOptions {
  return {
    prompt: [
      {
        role: "user",
        content: Array.from({ length: count }, (_, i) => ({
          type: "file",
          mediaType: "image/png",
          data: Buffer.from(`screenshot-${start + i}`),
        })),
      },
    ],
  }
}
function fixture(options: { legacy?: boolean; anthropic?: boolean } = {}) {
  const state = {
    now: Date.now(),
    scope: crypto.randomUUID(),
    deleteStatus: 0,
    deleteGate: undefined as Promise<void> | undefined,
    deleteStarted: 0,
    deleteDelay: 0,
    deleteActive: 0,
    deletePeak: 0,
    uploadDelay: 0,
    hangDeletes: false,
    uploadGate: undefined as Promise<void> | undefined,
    uploads: 0,
    capabilities: 0,
    uploadFailures: 0,
    capabilityFailures: 0,
    deleteFailures: 0,
    calls: [] as LanguageModelV3CallOptions[],
    deleted: [] as string[],
    live: new Set<string>(),
    gate: undefined as Promise<void> | undefined,
    stream: undefined as ReadableStreamDefaultController<LanguageModelV3StreamPart> | undefined,
  }
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.url.includes("/capability")) {
        state.capabilities++
        if (state.capabilityFailures-- > 0) return new Response("unavailable", { status: 503 })
        return Response.json({
          supported: true,
          scope: state.scope,
          ...(options.legacy ? {} : { max_references: 300, proof_transport: "body" }),
        })
      }
      if (req.method === "DELETE") {
        state.deleteStarted++
        state.deleteActive++
        state.deletePeak = Math.max(state.deletePeak, state.deleteActive)
        try {
          await Bun.sleep(state.deleteDelay)
          await state.deleteGate
          if (state.hangDeletes) return new Promise<Response>(() => {})
          if (state.deleteStatus) return new Response("failed", { status: state.deleteStatus })
          if (state.deleteFailures-- > 0) return new Response("unavailable", { status: 503 })
          const id = new URL(req.url).pathname.split("/").at(-1)!
          state.deleted.push(id)
          state.live.delete(id)
          return Response.json({ deleted: true })
        } finally {
          state.deleteActive--
        }
      }
      state.uploads++
      const upload = state.uploads
      await Bun.sleep(state.uploadDelay)
      await state.uploadGate
      if (state.uploadFailures-- > 0) return new Response("unavailable", { status: 503 })
      const id = `${options.anthropic ? "file_" : "file-"}${upload}`
      state.live.add(id)
      return Response.json({ file_id: id, expires_at: Math.floor(state.now / 1000) + 3600, signature: "a".repeat(64) })
    },
  })
  const native: LanguageModelV3 = {
    specificationVersion: "v3",
    provider: options.anthropic ? "anthropic" : "openai",
    modelId: "test",
    supportedUrls: {},
    async doGenerate(params) {
      state.calls.push(params)
      await state.gate
      return {
        content: [],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 0, text: 0, reasoning: 0 },
        },
        warnings: [],
      }
    },
    async doStream(params) {
      state.calls.push(params)
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            state.stream = controller
          },
        }),
        warnings: [],
      }
    },
  }
  const baseURL = `${server.url}api/v4/llm/${native.provider}/v1`
  const wrap = (modelId = native.modelId) =>
    withImageFiles({ ...native, modelId }, { baseURL, apiKey: "test", now: () => state.now })
  const model = wrap()
  return {
    state,
    model,
    wrap,
    async close() {
      await model.closeImageFiles()
      server.stop(true)
    },
  }
}

for (const anthropic of [false, true]) {
  test(`200 distinct screenshots and retained history upload once (anthropic=${anthropic})`, async () => {
    const f = fixture({ anthropic })
    try {
      await f.model.doGenerate(images(0, 200))
      await f.model.doGenerate(images(0, 201))
      expect(f.state.uploads).toBe(201)
      expect(f.state.calls[1].prompt[0].content).toHaveLength(201)
      expect(JSON.stringify(f.state.calls)).not.toContain(Buffer.from("screenshot-0").toString("base64"))
    } finally {
      await f.close()
    }
  })
}
test("more than 300 lifetime images with bounded history evict only unused files", async () => {
  const f = fixture()
  try {
    await f.model.doGenerate(images(0, 300))
    const message = f.state.calls[0].prompt[0]
    if (message.role !== "user") throw new Error("Expected user images")
    const ids = message.content.map((part) => (part.type === "file" ? String(part.data) : ""))
    await f.model.doGenerate(images(1, 300))
    expect(f.state.uploads).toBe(301)
    expect(f.state.deleted).toEqual([ids[0]])
    expect(f.state.live.size).toBe(300)
    await f.model.doGenerate(images(2, 300))
    expect(f.state.uploads).toBe(302)
    expect(f.state.deleted).toEqual([ids[0], ids[1]])
  } finally {
    await f.close()
  }
})
test("301 simultaneous images fail before any upload without discarding content", async () => {
  const f = fixture({ anthropic: true })
  try {
    await expect(f.model.doGenerate(images(0, 301))).rejects.toThrow("300")
    expect(f.state.uploads).toBe(0)
    expect(f.state.calls).toHaveLength(0)
  } finally {
    await f.close()
  }
})
test("in-flight generation pins its files against eviction and close", async () => {
  const f = fixture()
  try {
    await f.model.doGenerate(images(0, 300))
    const gate = Promise.withResolvers<void>()
    f.state.gate = gate.promise
    const pending = f.model.doGenerate(images(0, 1))
    while (f.state.calls.length < 2) await Bun.sleep(1)
    const part = f.state.calls[1].prompt[0].content[0]
    const pinned = typeof part !== "string" && part.type === "file" ? String(part.data) : "missing"
    f.state.gate = undefined
    await f.model.doGenerate(images(300, 1))
    expect(f.state.deleted).not.toContain(pinned)
    await f.model.closeImageFiles()
    expect(f.state.deleted).not.toContain(pinned)
    gate.resolve()
    await pending
    await f.model.closeImageFiles()
    expect(f.state.live.size).toBe(0)
  } finally {
    await f.close()
  }
})
test("stream retains references until cancellation then permits cleanup", async () => {
  const f = fixture()
  try {
    const result = await f.model.doStream(images(0, 1))
    await f.model.closeImageFiles()
    expect(f.state.deleted).toEqual([])
    await result.stream.cancel()
    await f.model.closeImageFiles()
    expect(f.state.live.size).toBe(0)
  } finally {
    await f.close()
  }
})
test("transient capability and upload failures retry within one call", async () => {
  const f = fixture()
  try {
    f.state.capabilityFailures = 1
    f.state.uploadFailures = 1
    await f.model.doGenerate(images(0, 1))
    expect(f.state.capabilities).toBe(2)
    expect(f.state.uploads).toBe(2)
    expect(f.state.calls).toHaveLength(1)
  } finally {
    await f.close()
  }
})
test("failed uploads and cleanup can recover on explicit retry", async () => {
  const f = fixture()
  try {
    f.state.uploadFailures = 10
    await expect(f.model.doGenerate(images(0, 1))).rejects.toThrow("upload failed")
    expect(f.state.uploads).toBe(3)
    f.state.uploadFailures = 0
    await f.model.doGenerate(images(0, 1))
    f.state.deleteFailures = 10
    await f.model.closeImageFiles()
    expect(f.state.live.size).toBe(1)
    f.state.deleteFailures = 0
    await f.model.closeImageFiles()
    expect(f.state.live.size).toBe(0)
  } finally {
    await f.close()
  }
})
test("negotiated 300 proofs move into bounded body metadata before HTTP", async () => {
  const f = fixture()
  try {
    await f.model.doGenerate(images(0, 300))
    const result = imageFileRequest({
      headers: f.state.calls[0].headers as Record<string, string>,
      body: JSON.stringify({ input: [] }),
    })!
    const headers = new Headers(result.headers)
    const body = JSON.parse(result.body as string)
    expect(headers.has("x-bu-image-proofs")).toBe(false)
    expect(Object.keys(body._image_file_proofs)).toHaveLength(300)
    expect(JSON.stringify([...headers]).length).toBeLessThan(1024)
  } finally {
    await f.close()
  }
})

test("legacy gateway keeps 64-reference contract and header proofs", async () => {
  const f = fixture({ legacy: true })
  try {
    await f.model.doGenerate(images(0, 64))
    const result = imageFileRequest({
      headers: f.state.calls[0].headers as Record<string, string>,
      body: JSON.stringify({ input: [] }),
    })!
    expect(new Headers(result.headers).has("x-bu-image-proofs")).toBe(true)
    expect(JSON.parse(result.body as string)._image_file_proofs).toBeUndefined()
    await expect(f.model.doGenerate(images(0, 65))).rejects.toThrow("64")
    expect(f.state.uploads).toBe(64)
  } finally {
    await f.close()
  }
})
for (const ending of ["complete", "error", "abort"] as const) {
  test(`stream ${ending} releases pins after close`, async () => {
    const f = fixture()
    try {
      const abort = new AbortController()
      const result = await f.model.doStream({ ...images(0, 1), abortSignal: abort.signal })
      const reader = result.stream.getReader()
      await f.model.closeImageFiles()
      expect(f.state.deleted).toEqual([])
      if (ending === "complete") f.state.stream!.close()
      if (ending === "error") f.state.stream!.error(new Error("stream failed"))
      if (ending === "abort") abort.abort()
      if (ending === "error") await expect(reader.read()).rejects.toThrow("stream failed")
      else expect((await reader.read()).done).toBe(true)
      await f.model.closeImageFiles()
      expect(f.state.live.size).toBe(0)
    } finally {
      await f.close()
    }
  })
}
test("overlapping active requests cannot evict each other's full working set", async () => {
  const f = fixture()
  const gate = Promise.withResolvers<void>()
  try {
    f.state.gate = gate.promise
    const pending = f.model.doGenerate(images(0, 300))
    while (!f.state.calls.length) await Bun.sleep(1)
    await expect(f.model.doGenerate(images(300, 1))).rejects.toThrow("active requests")
    expect(f.state.deleted).toEqual([])
    f.state.gate = undefined
    gate.resolve()
    await pending
    await f.model.doGenerate(images(300, 1))
    expect(f.state.uploads).toBe(301)
  } finally {
    gate.resolve()
    await f.close()
  }
})
test("abort during transient retry stops uploading and leaves later call usable", async () => {
  const f = fixture()
  try {
    f.state.uploadFailures = 10
    const abort = new AbortController()
    const pending = f.model.doGenerate({ ...images(0, 1), abortSignal: abort.signal })
    while (!f.state.uploads) await Bun.sleep(1)
    abort.abort()
    await expect(pending).rejects.toThrow()
    expect(f.state.uploads).toBe(1)
    expect(f.state.calls).toHaveLength(0)
    f.state.uploadFailures = 0
    await f.model.doGenerate(images(0, 1))
    expect(f.state.uploads).toBe(2)
  } finally {
    await f.close()
  }
})

test("hung deletes have a total cleanup deadline and remain retryable", async () => {
  const f = fixture()
  try {
    await f.model.doGenerate(images(0, 20))
    f.state.hangDeletes = true
    const started = performance.now()
    await f.model.closeImageFiles()
    expect(performance.now() - started).toBeLessThan(2500)
    expect(f.state.live.size).toBe(20)
    f.state.hangDeletes = false
    await f.model.closeImageFiles()
    expect(f.state.live.size).toBe(0)
  } finally {
    await f.close()
  }
})
test("expired closed caches cannot exhaust the global run slots after failed deletes", async () => {
  const f = fixture()
  try {
    f.state.deleteStatus = 400
    for (let i = 0; i < 130; i++) {
      f.state.scope = crypto.randomUUID()
      const model = f.wrap()
      await model.doGenerate(images(i, 1))
      await model.closeImageFiles()
      f.state.now += 3601_000
    }
    expect(f.state.calls).toHaveLength(130)
  } finally {
    await f.close()
  }
})
test("delete outage bounds retired files and permits recovery without losing pins", async () => {
  const f = fixture()
  try {
    f.state.deleteStatus = 400
    await f.model.doGenerate(images(0, 300))
    await f.model.doGenerate(images(300, 300))
    expect(f.state.live.size).toBe(600)
    await expect(f.model.doGenerate(images(600, 1))).rejects.toThrow("cleanup backlog")
    expect(f.state.uploads).toBe(600)
    f.state.deleteStatus = 0
    await f.model.doGenerate(images(600, 1))
    expect(f.state.uploads).toBe(601)
    await f.model.closeImageFiles()
    await f.model.closeImageFiles()
    expect(f.state.live.size).toBe(0)
  } finally {
    await f.close()
  }
})

test("different models never share uploaded files even with an identical gateway scope", async () => {
  const f = fixture()
  const sibling = f.wrap("another-model")
  try {
    await f.model.doGenerate(images(0, 1))
    await sibling.doGenerate(images(0, 1))
    expect(f.state.uploads).toBe(2)
    await f.model.closeImageFiles()
    expect(f.state.live.size).toBe(1)
    await sibling.closeImageFiles()
    expect(f.state.live.size).toBe(0)
  } finally {
    await sibling.closeImageFiles()
    await f.close()
  }
})

for (const store of [false, true]) {
  test(`stateful Responses keep omitted files until close (explicit store=${store})`, async () => {
    const f = fixture()
    try {
      await f.model.doGenerate({
        ...images(0, 300),
        ...(store ? { providerOptions: { openai: { store: true } } } : {}),
      })
      await f.model.doGenerate({ prompt: [], providerOptions: { openai: { previousResponseId: "resp-prior" } } })
      await expect(f.model.doGenerate(images(300, 1))).rejects.toThrow("stateful response chain")
      expect(f.state.uploads).toBe(300)
      expect(f.state.deleted).toEqual([])
      await f.model.closeImageFiles()
      expect(f.state.live.size).toBe(0)
    } finally {
      await f.close()
    }
  })
}

test("cached image requests do not wait behind unrelated slow uploads", async () => {
  const f = fixture()
  const gate = Promise.withResolvers<void>()
  try {
    await f.model.doGenerate(images(0, 1))
    f.state.uploadGate = gate.promise
    const uploading = f.model.doGenerate(images(1, 1))
    while (f.state.uploads < 2) await Bun.sleep(1)
    await Promise.race([
      f.model.doGenerate(images(0, 1)),
      Bun.sleep(500).then(() => {
        throw new Error("cached request blocked by upload")
      }),
    ])
    gate.resolve()
    await uploading
    expect(f.state.uploads).toBe(2)
  } finally {
    gate.resolve()
    await f.close()
  }
})

test("fresh wrapper retries cleanup left by a closed owner", async () => {
  const f = fixture()
  const sibling = f.wrap()
  try {
    await f.model.doGenerate(images(0, 1))
    f.state.deleteStatus = 400
    await f.model.closeImageFiles()
    await expect(sibling.doGenerate(images(0, 1))).rejects.toThrow("closing")
    f.state.deleteStatus = 0
    await sibling.doGenerate(images(0, 1))
    expect(f.state.uploads).toBe(2)
    expect(f.state.deleted).toHaveLength(1)
  } finally {
    await sibling.closeImageFiles()
    await f.close()
  }
})

test("last stream ending during close cleanup schedules a final cleanup pass", async () => {
  const f = fixture()
  const gate = Promise.withResolvers<void>()
  try {
    const result = await f.model.doStream(images(0, 1))
    await f.model.doGenerate(images(1, 1))
    f.state.deleteGate = gate.promise
    const closing = f.model.closeImageFiles()
    while (!f.state.deleteStarted) await Bun.sleep(1)
    await result.stream.cancel()
    gate.resolve()
    await closing
    for (let i = 0; i < 100 && f.state.live.size; i++) await Bun.sleep(5)
    expect(f.state.live.size).toBe(0)
  } finally {
    gate.resolve()
    await f.close()
  }
})

for (const latency of [false, true]) {
  test(`healthy cleanup keeps up with 1000 lifetime images and 100 active (latency=${latency})`, async () => {
    const f = fixture()
    f.state.deleteDelay = latency ? 200 : 0
    f.state.uploadDelay = latency ? 20 : 0
    try {
      for (let turn = 0; turn < 10; turn++) {
        await f.model.doGenerate(images(turn * 100, 100))
        expect(f.state.live.size).toBeLessThanOrEqual(600)
        if (latency) await Bun.sleep(50)
      }
      expect(f.state.uploads).toBe(1000)
      expect(f.state.calls).toHaveLength(10)
      await f.model.closeImageFiles()
      const deadline = Date.now() + 6000
      while (f.state.live.size && Date.now() < deadline) await Bun.sleep(10)
      expect(f.state.live.size).toBe(0)
      expect(f.state.deleted).toHaveLength(1000)
      expect(new Set(f.state.deleted).size).toBe(1000)
      expect(f.state.deletePeak).toBeLessThanOrEqual(16)
    } finally {
      await f.close()
    }
  }, 30000)
}

test("preparation shares one second of cleanup wait across eviction passes", async () => {
  const f = fixture()
  try {
    await f.model.doGenerate(images(0, 300))
    f.state.deleteStatus = 400
    await f.model.doGenerate(images(300, 100))
    f.state.deleteStatus = 0
    f.state.deleteDelay = 200
    const started = performance.now()
    const result = await f.model.doStream(images(400, 100))
    expect(performance.now() - started).toBeLessThan(1900)
    expect(f.state.uploads).toBe(500)
    expect(f.state.deletePeak).toBeLessThanOrEqual(16)
    await result.stream.cancel()
    await f.model.closeImageFiles()
    const deadline = Date.now() + 7000
    while (f.state.live.size && Date.now() < deadline) await Bun.sleep(10)
    expect(f.state.live.size).toBe(0)
  } finally {
    await f.close()
  }
}, 15000)

test("background cleanup stops on failure and keeps tombstones for explicit recovery", async () => {
  const f = fixture()
  try {
    await f.model.doGenerate(images(0, 100))
    f.state.deleteStatus = 400
    await f.model.closeImageFiles()
    const attempts = f.state.deleteStarted
    expect(attempts).toBeGreaterThan(0)
    expect(attempts).toBeLessThanOrEqual(16)
    await Bun.sleep(100)
    expect(f.state.deleteStarted).toBe(attempts)
    expect(f.state.live.size).toBe(100)
    f.state.deleteStatus = 0
    await f.model.closeImageFiles()
    expect(f.state.live.size).toBe(0)
  } finally {
    await f.close()
  }
})
