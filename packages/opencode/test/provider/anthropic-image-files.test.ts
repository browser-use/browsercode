import { expect, test } from "bun:test"
import { createAnthropic } from "@ai-sdk/anthropic"
import { generateText } from "ai"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Provider } from "../../src/provider/provider"
import { MessageV2 } from "../../src/session/message-v2"
import { imageFileRequest, withImageFiles } from "../../src/provider/image-files"

const screenshot = Buffer.alloc(1024 * 1024, 42)
const history = [
  {
    info: {
      id: "msg-a",
      parentID: "msg-u",
      sessionID: "session",
      role: "assistant",
      modelID: "claude-test",
      providerID: "anthropic",
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
const spec = {
  id: "claude-test",
  providerID: "anthropic",
  api: { id: "claude-test", npm: "@ai-sdk/anthropic" },
  capabilities: { input: { image: true } },
} as Provider.Model
function fixture(options: { relay?: boolean; supported?: boolean; missing?: number; uploadStatus?: number } = {}) {
  const state = {
    uploads: 0,
    deletes: 0,
    calls: 0,
    scope: crypto.randomUUID() as string,
    bodies: [] as Array<{ messages: Array<{ content: Array<Record<string, unknown>> }> }>,
    headers: [] as Headers[],
  }
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
        expect(req.headers.get("content-type")).toBe("image/png")
        expect(Buffer.from(await req.arrayBuffer()).equals(screenshot)).toBe(true)
        state.uploads++
        if (options.uploadStatus) return new Response("failed", { status: options.uploadStatus })
        return Response.json({
          file_id: `file_${state.uploads}`,
          signature: "proof",
          expires_at: Date.now() / 1000 + 3600,
        })
      }
      state.calls++
      state.bodies.push(await req.json())
      state.headers.push(req.headers)
      if (state.calls <= (options.missing ?? 0))
        return Response.json(
          { type: "error", error: { type: "not_found_error", message: `File file_${state.uploads} not found` } },
          { status: 404 },
        )
      return Response.json({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-test",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    },
  })
  const baseURL = `${server.url}${options.relay ? "_v4/bcode-relay/worker-1/" : ""}api/v4/llm/anthropic/v1`
  const native = createAnthropic({
    baseURL,
    apiKey: "v4rt_test",
    headers: { "anthropic-beta": "interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14" },
    fetch: Object.assign((url: RequestInfo | URL, init?: RequestInit) => fetch(url, imageFileRequest(init)), {
      preconnect: fetch.preconnect,
    }),
  }).languageModel("claude-test")
  const adapted = withImageFiles(native, { baseURL, apiKey: "v4rt_test" })
  const model = process.env.ANTHROPIC_FILES_BASELINE ? native : adapted
  return {
    state,
    model,
    async close() {
      await adapted.closeImageFiles()
      server.stop(true)
    },
  }
}
const prompt = [
  {
    role: "user" as const,
    content: [
      { type: "text" as const, text: "Read screenshot" },
      {
        type: "file" as const,
        mediaType: "image/png",
        data: screenshot,
        providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
      },
    ],
  },
]
for (const relay of [false, true])
  test(`actual BrowserCode Anthropic screenshot history three turns (relay=${relay})`, async () => {
    const f = fixture({ relay })
    const original = JSON.stringify(history)
    try {
      for (let turn = 0; turn < 3; turn++)
        await generateText({
          model: f.model,
          messages: [...(await MessageV2.toModelMessages(history, spec)), { role: "user", content: `turn ${turn}` }],
          maxRetries: 0,
        })
      if (process.env.ANTHROPIC_FILES_EVIDENCE)
        await Bun.write(
          process.env.ANTHROPIC_FILES_EVIDENCE + (relay ? "-relay" : ""),
          JSON.stringify({
            uploads: f.state.uploads,
            bodies: f.state.bodies,
            historyIntact: JSON.stringify(history) === original,
          }),
        )
      expect(f.state.uploads).toBe(1)
      expect(f.state.bodies).toHaveLength(3)
      for (const body of f.state.bodies) {
        expect(body.messages[0].content).toEqual([
          { type: "tool_use", id: "call-1", name: "browser_execute", input: { code: "screenshot()" } },
        ])
        expect(body.messages[1].content[0]).toEqual({
          type: "tool_result",
          tool_use_id: "call-1",
          content: [
            { type: "text", text: "Captured" },
            { type: "image", source: { type: "file", file_id: "file_1" } },
          ],
        })
        expect(JSON.stringify(body)).not.toContain(screenshot.toString("base64"))
        expect(JSON.stringify(body)).not.toContain("bu-anthropic-file:")
      }
      expect(JSON.stringify(history)).toBe(original)
      expect(f.state.headers[0].get("anthropic-beta")).toContain("files-api-2025-04-14")
      expect(f.state.headers[0].get("anthropic-beta")).toContain("interleaved-thinking-2025-05-14")
      expect(f.state.headers[0].get("anthropic-beta")).toContain("fine-grained-tool-streaming-2025-05-14")
    } finally {
      await f.close()
    }
  })
test("Anthropic user images preserve cache control and source history", async () => {
  const f = fixture()
  try {
    await f.model.doGenerate({ prompt })
    expect(f.state.uploads).toBe(1)
    expect(f.state.bodies[0].messages[0].content[1]).toEqual({
      type: "image",
      source: { type: "file", file_id: "file_1" },
      cache_control: { type: "ephemeral" },
    })
    expect(prompt[0].content[1]).toMatchObject({ data: screenshot })
  } finally {
    await f.close()
  }
})
test("unsupported Anthropic routes retain legacy behavior before selection", async () => {
  const f = fixture({ supported: false })
  try {
    await f.model.doGenerate({ prompt })
    expect(f.state.uploads).toBe(0)
    expect(f.state.bodies[0].messages[0].content[1]).toMatchObject({ source: { type: "base64" } })
  } finally {
    await f.close()
  }
})
test("Anthropic upload failure never silently falls back", async () => {
  const f = fixture({ uploadStatus: 503 })
  try {
    await expect(f.model.doGenerate({ prompt })).rejects.toThrow("upload failed")
    expect(f.state.calls).toBe(0)
  } finally {
    await f.close()
  }
})
test("Anthropic scope rotation fails before another inference", async () => {
  const f = fixture()
  try {
    await f.model.doGenerate({ prompt })
    f.state.scope = "rotated"
    await expect(f.model.doGenerate({ prompt })).rejects.toThrow("account changed")
    expect(f.state.calls).toBe(1)
  } finally {
    await f.close()
  }
})
for (const missing of [1, 2])
  test(`Anthropic missing file gets one bounded refresh (${missing})`, async () => {
    const f = fixture({ missing })
    try {
      if (missing === 1) await f.model.doGenerate({ prompt })
      else await expect(f.model.doGenerate({ prompt })).rejects.toThrow()
      expect(f.state.uploads).toBe(2)
      expect(f.state.calls).toBe(2)
    } finally {
      await f.close()
    }
  })
