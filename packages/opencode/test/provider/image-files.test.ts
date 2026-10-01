import { expect, test } from "bun:test"
import { generateText } from "ai"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Provider } from "../../src/provider/provider"
import { MessageV2 } from "../../src/session/message-v2"
import { createOpenAI } from "@ai-sdk/openai"
import { imageFileRequest, withImageFiles } from "../../src/provider/image-files"

const screenshot = Buffer.alloc(1024 * 1024, 42)
const prompt = [
  {
    role: "user" as const,
    content: [
      { type: "text" as const, text: "Read this screenshot" },
      {
        type: "file" as const,
        mediaType: "image/png",
        data: screenshot,
        providerOptions: { openai: { imageDetail: "high" } },
      },
    ],
  },
  {
    role: "assistant" as const,
    content: [{ type: "tool-call" as const, toolCallId: "call_1", toolName: "browse", input: {} }],
  },
  {
    role: "tool" as const,
    content: [
      {
        type: "tool-result" as const,
        toolCallId: "call_1",
        toolName: "browse",
        output: { type: "text" as const, value: "done" },
      },
    ],
  },
]

test("one screenshot reused in three turns is uploaded once before gateway JSON", async () => {
  const requests: Array<{ input: Array<Record<string, unknown>> }> = []
  let uploads = 0
  const testScope = crypto.randomUUID()
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname
      if (path.endsWith("/image-files/capability")) return Response.json({ supported: true, scope: testScope })
      if (path.endsWith("/image-files")) {
        expect(req.headers.get("content-type")).toBe("image/png")
        expect(Buffer.from(await req.arrayBuffer()).equals(screenshot)).toBe(true)
        uploads++
        return Response.json({ file_id: "file-screenshot", signature: "proof", expires_at: Date.now() / 1000 + 3600 })
      }
      requests.push(await req.json())
      return Response.json({
        id: "resp_test",
        object: "response",
        created_at: 1,
        model: "gpt-test",
        output: [
          {
            type: "message",
            id: "msg_1",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "ok", annotations: [] }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        status: "completed",
      })
    },
  })
  try {
    const baseURL = `${server.url}api/v4/llm/openai/v1`
    const native = createOpenAI({
      baseURL,
      apiKey: "v4rt_test",
      fetch: Object.assign((url: RequestInfo | URL, init?: RequestInit) => fetch(url, imageFileRequest(init)), {
        preconnect: fetch.preconnect,
      }),
    }).responses("gpt-test")
    const model = process.env.IMAGE_FILES_BASELINE ? native : withImageFiles(native, { baseURL, apiKey: "v4rt_test" })
    for (let i = 0; i < 3; i++)
      await model.doGenerate({ prompt: [...prompt, { role: "user", content: [{ type: "text", text: `turn ${i}` }] }] })
    if (process.env.IMAGE_FILES_EVIDENCE)
      await Bun.write(
        process.env.IMAGE_FILES_EVIDENCE,
        JSON.stringify({
          uploads,
          bodies: requests,
          originalHistoryIntact: JSON.stringify(prompt).includes(JSON.stringify(screenshot)),
        }),
      )
    expect(uploads).toBe(1)
    expect(requests).toHaveLength(3)
    for (const body of requests) {
      expect(JSON.stringify(body)).not.toContain(screenshot.toString("base64"))
      expect(body.input[0].content).toEqual([
        { type: "input_text", text: "Read this screenshot" },
        { type: "input_image", file_id: "file-screenshot", detail: "high" },
      ])
      expect(body.input[1]).toMatchObject({ type: "function_call", call_id: "call_1", name: "browse", arguments: "{}" })
      expect(body.input[2]).toMatchObject({ type: "function_call_output", call_id: "call_1", output: "done" })
    }
    expect(prompt[0].content[1]).toMatchObject({ data: screenshot })
  } finally {
    server.stop(true)
  }
})

test("actual BrowserCode screenshot history is externalized without changing persisted history", async () => {
  const history = [
    {
      info: {
        id: "msg-a",
        parentID: "msg-u",
        sessionID: "session",
        role: "assistant",
        modelID: "gpt-test",
        providerID: "openai",
        time: { created: 0 },
      },
      parts: [
        {
          id: "part",
          sessionID: "session",
          messageID: "msg-a",
          type: "tool",
          tool: "browser_execute",
          callID: "call-1",
          state: {
            status: "completed",
            input: { code: "screenshot()" },
            output: "Captured",
            title: "Screenshot",
            metadata: {},
            time: { start: 0, end: 1 },
            attachments: [
              {
                id: "file",
                sessionID: "session",
                messageID: "msg-a",
                type: "file",
                mime: "image/png",
                url: `data:image/png;base64,${screenshot.toString("base64")}`,
              },
            ],
          },
        },
      ],
    },
  ] as unknown as SessionV1.WithParts[]
  const original = JSON.stringify(history)
  const spec = {
    id: "gpt-test",
    providerID: "openai",
    api: { id: "gpt-test", npm: "@ai-sdk/openai" },
    capabilities: { input: { image: true } },
  } as Provider.Model
  let uploads = 0
  const bodies: Record<string, unknown>[] = []
  const testScope = crypto.randomUUID()
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.url.includes("/capability")) return Response.json({ supported: true, scope: testScope })
      if (req.url.includes("/image-files")) {
        uploads++
        return Response.json({ file_id: "file-image", signature: "proof", expires_at: Date.now() / 1000 + 3600 })
      }
      bodies.push(await req.json())
      return Response.json({
        id: "resp_a",
        created_at: 1,
        model: "gpt-test",
        output: [
          {
            type: "message",
            id: "msg-a",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "ok", annotations: [] }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        status: "completed",
      })
    },
  })
  try {
    const baseURL = `${server.url}api/v4/llm/openai/v1`
    const native = createOpenAI({
      baseURL,
      apiKey: "v4rt_test",
      fetch: Object.assign((url: RequestInfo | URL, init?: RequestInit) => fetch(url, imageFileRequest(init)), {
        preconnect: fetch.preconnect,
      }),
    }).responses("gpt-test")
    const model = process.env.IMAGE_FILES_BASELINE ? native : withImageFiles(native, { baseURL, apiKey: "v4rt_test" })
    for (let turn = 0; turn < 3; turn++)
      await generateText({
        model,
        messages: [...(await MessageV2.toModelMessages(history, spec)), { role: "user", content: `turn ${turn}` }],
        maxRetries: 0,
      })
    expect(uploads).toBe(1)
    for (const body of bodies) {
      const input = body.input as Array<Record<string, unknown>>
      expect(input[0]).toMatchObject({ type: "function_call", call_id: "call-1", name: "browser_execute" })
      expect(input[1]).toMatchObject({
        type: "function_call_output",
        call_id: "call-1",
        output: [
          { type: "input_text", text: "Captured" },
          { type: "input_image", file_id: "file-image" },
        ],
      })
      expect(JSON.stringify(body)).toContain('"file_id":"file-image"')
      expect(JSON.stringify(body)).not.toContain(screenshot.toString("base64"))
    }
    expect(JSON.stringify(history)).toBe(original)
  } finally {
    server.stop(true)
  }
})

function fixture(
  options: { supported?: boolean; missing?: number; uploadDelay?: number; uploadStatus?: number; relay?: boolean } = {},
) {
  const state = {
    uploads: 0,
    responses: 0,
    deletes: 0,
    scope: String(crypto.randomUUID()),
    now: Date.now(),
    active: 0,
    peak: 0,
    bodies: [] as string[],
  }
  const testScope = crypto.randomUUID()
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.url.includes("/capability"))
        return Response.json({ supported: options.supported ?? true, scope: state.scope })
      if (req.method === "DELETE") {
        state.deletes++
        return Response.json({ deleted: true })
      }
      if (req.url.includes("/image-files")) {
        state.uploads++
        state.active++
        state.peak = Math.max(state.peak, state.active)
        if (options.uploadDelay) await Bun.sleep(options.uploadDelay)
        state.active--
        if (options.uploadStatus) return new Response("failed", { status: options.uploadStatus })
        return Response.json({
          file_id: `file-${state.uploads}`,
          expires_at: Math.floor(state.now / 1000) + 3600,
          signature: "proof",
        })
      }
      state.responses++
      const body = await req.text()
      state.bodies.push(body)
      if (state.responses <= (options.missing ?? 0))
        return Response.json(
          {
            error: {
              message: `File file-${state.uploads} not found`,
              type: "invalid_request_error",
              code: "invalid_image",
            },
          },
          { status: 400 },
        )
      return Response.json({
        id: "resp_a",
        created_at: 1,
        model: "gpt-test",
        output: [
          {
            type: "message",
            id: "msg-a",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "ok", annotations: [] }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        status: "completed",
      })
    },
  })
  const baseURL = `${server.url}${options.relay ? "_v4/bcode-relay/relay-123/" : ""}api/v4/llm/openai/v1`
  const native = createOpenAI({
    baseURL,
    apiKey: "v4rt_test",
    fetch: Object.assign((url: RequestInfo | URL, init?: RequestInit) => fetch(url, imageFileRequest(init)), {
      preconnect: fetch.preconnect,
    }),
  }).responses("gpt-test")
  const model = withImageFiles(native, { baseURL, apiKey: "v4rt_test", now: () => state.now })
  return { state, model, stop: () => server.stop(true) }
}

test("unsupported actual route keeps inline behavior", async () => {
  const f = fixture({ supported: false })
  try {
    await f.model.doGenerate({ prompt })
    expect(f.state.uploads).toBe(0)
    expect(f.state.bodies[0]).toContain(screenshot.toString("base64"))
  } finally {
    f.stop()
  }
})

test("concurrent repeated screenshot has one upload and cleanup deletes it", async () => {
  const f = fixture({ uploadDelay: 30 })
  try {
    await Promise.all([f.model.doGenerate({ prompt }), f.model.doGenerate({ prompt }), f.model.doGenerate({ prompt })])
    expect(f.state.uploads).toBe(1)
    await f.model.closeImageFiles()
    expect(f.state.deletes).toBe(1)
  } finally {
    f.stop()
  }
})

test("deleted reference recovers once with original previous_response_id and no inline retry", async () => {
  const f = fixture({ missing: 1 })
  try {
    await f.model.doGenerate({ prompt, providerOptions: { openai: { previousResponseId: "resp_prior", store: true } } })
    expect(f.state.uploads).toBe(2)
    expect(f.state.responses).toBe(2)
    for (const body of f.state.bodies) {
      expect(body).not.toContain(screenshot.toString("base64"))
      expect(JSON.parse(body).previous_response_id).toBe("resp_prior")
    }
  } finally {
    f.stop()
  }
})

test("repeated invalid references and failed upload stay bounded", async () => {
  const f = fixture({ missing: 10 })
  try {
    await expect(f.model.doGenerate({ prompt })).rejects.toThrow("not found")
    expect(f.state.uploads).toBe(2)
    expect(f.state.responses).toBe(2)
    await expect(f.model.doGenerate({ prompt })).rejects.toThrow("not found")
    expect(f.state.uploads).toBe(2)
  } finally {
    f.stop()
  }
  const failed = fixture({ uploadStatus: 503 })
  try {
    await expect(failed.model.doGenerate({ prompt })).rejects.toThrow("upload failed")
    expect(failed.state.responses).toBe(0)
    expect(failed.state.uploads).toBe(1)
  } finally {
    failed.stop()
  }
})

test("account rotation fails before forwarding any inline screenshot", async () => {
  const f = fixture()
  try {
    await f.model.doGenerate({ prompt })
    f.state.scope = "another-account"
    await expect(f.model.doGenerate({ prompt })).rejects.toThrow("account changed")
    expect(f.state.uploads).toBe(1)
    expect(f.state.responses).toBe(1)
  } finally {
    f.stop()
  }
})

test("producer bounds concurrent image uploads", async () => {
  const f = fixture({ uploadDelay: 10 })
  try {
    await f.model.doGenerate({
      prompt: [
        {
          role: "user",
          content: Array.from({ length: 6 }, (_, i) => ({
            type: "file",
            mediaType: "image/png",
            data: Buffer.alloc(1024, i),
          })),
        },
      ],
    })
    expect(f.state.uploads).toBe(6)
    expect(f.state.peak).toBeLessThanOrEqual(2)
  } finally {
    f.stop()
  }
})

test("aborted upload never falls back to a large request", async () => {
  const f = fixture({ uploadDelay: 100 })
  try {
    const abort = new AbortController()
    const pending = f.model.doGenerate({ prompt, abortSignal: abort.signal })
    await Bun.sleep(20)
    abort.abort()
    await expect(pending).rejects.toThrow()
    expect(f.state.responses).toBe(0)
  } finally {
    f.stop()
  }
})

test("placeholder conversion only changes image parts in native input arrays", () => {
  const unrelated = { type: "input_image", image_url: "bu-openai-file:file-meta" }
  const result = imageFileRequest({
    headers: { "x-bu-image-scope": "run" },
    body: JSON.stringify({
      metadata: unrelated,
      input: [
        {
          type: "function_call_output",
          output: [
            { type: "input_image", image_url: "bu-openai-file:file-a", detail: "high" },
            { type: "input_text", text: "bu-openai-file:file-a" },
          ],
        },
      ],
    }),
  })
  expect(JSON.parse(result!.body as string)).toEqual({
    metadata: unrelated,
    input: [
      {
        type: "function_call_output",
        output: [
          { type: "input_image", file_id: "file-a", detail: "high" },
          { type: "input_text", text: "bu-openai-file:file-a" },
        ],
      },
    ],
  })
})

test("reusable worker relay URL uses upload references", async () => {
  const f = fixture({ relay: true })
  try {
    await f.model.doGenerate({ prompt })
    expect(f.state.uploads).toBe(1)
    expect(f.state.bodies[0]).not.toContain(screenshot.toString("base64"))
  } finally {
    f.stop()
  }
})

test("expired duplicate references coalesce even with a full 64-image run cache", async () => {
  const f = fixture()
  try {
    const images = Array.from({ length: 64 }, (_, i) => ({
      type: "file" as const,
      mediaType: "image/png",
      data: Buffer.alloc(1024, i),
    }))
    await f.model.doGenerate({ prompt: [{ role: "user", content: images }] })
    expect(f.state.uploads).toBe(64)
    f.state.now += 3600_000
    await f.model.doGenerate({ prompt: [{ role: "user", content: [images[0], images[0]] }] })
    expect(f.state.uploads).toBe(65)
    f.state.now += 3600_000
    await expect(f.model.doGenerate({ prompt: [{ role: "user", content: [images[0]] }] })).rejects.toThrow(
      "expired again",
    )
    expect(f.state.uploads).toBe(65)
  } finally {
    f.stop()
  }
})
