// browser_execute end-to-end against headless Chrome. Same env-gate as
// cdp-smoke.test.ts (BCODE_SMOKE_CHROME=1 + BCODE_SMOKE_PROFILE_DIR).
//
// Verifies: AsyncFunction snippet wrapping, console.log capture, return-
// value serialization, multi-call session reuse via SessionStore, workspace
// dynamic-import inside a snippet.

import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect } from "effect"
import { BrowserExecute } from "../src/browser-execute"
import { SessionStore } from "../src/session-store"

const profileDir = process.env.BCODE_SMOKE_PROFILE_DIR
const enabled = process.env.BCODE_SMOKE_CHROME === "1" && profileDir

const sessionID = "test-" + Math.random().toString(36).slice(2, 8)
let workspaceDir: string
let dataDir: string

beforeAll(async () => {
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "bcode-be-"))
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bcode-data-"))
})

afterAll(async () => {
  await SessionStore.evict(sessionID)
  await fs.rm(workspaceDir, { recursive: true, force: true })
  await fs.rm(dataDir, { recursive: true, force: true })
})

test.skipIf(!enabled)("connect + console.log + return value", async () => {
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const impl = yield* BrowserExecute.make(dataDir)
        return yield* impl.execute(
          {
            description: "Connect to local Chrome",
            code: `await session.connect({ profileDir: ${JSON.stringify(profileDir!)}, timeoutMs: 5000 });
                   console.log("connected", session.isConnected());
                   return { ok: session.isConnected() };`,
          },
          { sessionID, workspaceDir },
        )
      }),
    ),
  )
  expect(result.output).toContain("connected true")
  expect(JSON.parse(result.result)).toEqual({ ok: true })
})

test.skipIf(!enabled)("Session is reused across calls (SessionStore)", async () => {
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const impl = yield* BrowserExecute.make(dataDir)
        return yield* impl.execute(
          {
            description: "Verify session reuse",
            code: `// connect was called in the previous test on the same sessionID.
                   console.log("still connected:", session.isConnected());
                   return session.isConnected();`,
          },
          { sessionID, workspaceDir },
        )
      }),
    ),
  )
  expect(result.output).toContain("still connected: true")
  expect(JSON.parse(result.result)).toBe(true)
})

test("state persists across calls for one BrowserCode session", async () => {
  const impl = await Effect.runPromise(Effect.scoped(BrowserExecute.make(dataDir)))
  await Effect.runPromise(
    impl.execute(
      {
        description: "Checkpoint records",
        code: `state.records = [{ id: "first" }]; return state.records.length;`,
      },
      { sessionID, workspaceDir },
    ),
  )
  const result = await Effect.runPromise(
    impl.execute(
      {
        description: "Reuse checkpointed records",
        code: `state.records.push({ id: "second" }); return state.records;`,
      },
      { sessionID, workspaceDir },
    ),
  )
  expect(JSON.parse(result.result)).toEqual([{ id: "first" }, { id: "second" }])
})

test.skipIf(!enabled)("workspace import inside a snippet", async () => {
  const file = path.join(workspaceDir, "title.ts")
  await fs.writeFile(
    file,
    `export const run = async (session) => {
       const targets = (await session.Target.getTargets({})).targetInfos
       const page = targets.find((t) => t.type === "page")
       if (!page) {
         const created = await session.Target.createTarget({ url: "about:blank" })
         await session.use(created.targetId)
       } else {
         await session.use(page.targetId)
       }
       await session.Page.enable()
       const loaded = session.waitFor("Page.loadEventFired", { timeoutMs: 5000 })
       await session.Page.navigate({ url: "data:text/html,<title>bcode-be</title>" })
       await loaded
       const r = await session.Runtime.evaluate({ expression: "document.title", returnByValue: true })
       return r.result.value
     }`,
    "utf8",
  )

  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const impl = yield* BrowserExecute.make(dataDir)
        return yield* impl.execute(
          {
            description: "Import workspace module",
            code: `const m = await import(${JSON.stringify(file)} + "?t=" + Date.now());
                   const t = await m.run(session);
                   console.log("title:", t);
                   return t;`,
          },
          { sessionID, workspaceDir },
        )
      }),
    ),
  )
  expect(result.output).toContain("title: bcode-be")
  expect(JSON.parse(result.result)).toBe("bcode-be")
})

test.skipIf(!enabled)("Page.captureScreenshot is collected into result.screenshots", async () => {
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const impl = yield* BrowserExecute.make(dataDir)
        return yield* impl.execute(
          {
            description: "Capture two screenshots",
            code: `await session.Page.enable();
                   const loaded = session.waitFor("Page.loadEventFired", { timeoutMs: 5000 });
                   await session.Page.navigate({ url: "data:text/html,<title>shot</title><body>hi" });
                   await loaded;
                   const a = await session.Page.captureScreenshot({ format: "png" });
                   const b = await session.Page.captureScreenshot({ format: "jpeg", quality: 50 });
                   return { aLen: a.data.length, bLen: b.data.length };`,
          },
          { sessionID, workspaceDir },
        )
      }),
    ),
  )
  expect(result.screenshots).toHaveLength(2)
  expect(result.screenshots[0]!.mime).toBe("image/png")
  expect(result.screenshots[1]!.mime).toBe("image/jpeg")
  // base64 must round-trip back to non-empty bytes for both shots.
  expect(Buffer.from(result.screenshots[0]!.base64, "base64").length).toBeGreaterThan(0)
  expect(Buffer.from(result.screenshots[1]!.base64, "base64").length).toBeGreaterThan(0)
})

test.skipIf(!enabled)("BCODE_SCREENSHOT_DIR dumps screenshots to disk", async () => {
  const dump = await fs.mkdtemp(path.join(os.tmpdir(), "bcode-shotdump-"))
  const prev = process.env.BCODE_SCREENSHOT_DIR
  process.env.BCODE_SCREENSHOT_DIR = dump
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const impl = yield* BrowserExecute.make(dataDir)
          return yield* impl.execute(
            {
              description: "Dump screenshot to disk",
              code: `await session.Page.captureScreenshot({ format: "png" });`,
            },
            { sessionID, workspaceDir },
          )
        }),
      ),
    )
    // Disk dump is fire-and-forget; give it a tick to land.
    await new Promise((r) => setTimeout(r, 150))
    const files = await fs.readdir(dump)
    expect(files.length).toBeGreaterThan(0)
    expect(files.every((f) => f.endsWith(".png"))).toBe(true)
  } finally {
    if (prev === undefined) delete process.env.BCODE_SCREENSHOT_DIR
    else process.env.BCODE_SCREENSHOT_DIR = prev
    await fs.rm(dump, { recursive: true, force: true })
  }
})

test.skipIf(!enabled)("syntax error in snippet surfaces a clean failure", async () => {
  await expect(
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const impl = yield* BrowserExecute.make(dataDir)
          return yield* impl.execute(
            {
              description: "Trigger syntax error",
              code: `const x = (`,
            },
            { sessionID, workspaceDir },
          )
        }),
      ),
    ),
  ).rejects.toThrow(/syntax error/)
})

// `console.debug` is captured (tee'd) and uncommon `console.*` methods
// (`table`, `dir`, `trace`, …) fall through to the real console without
// throwing. No Chrome required.
test("console.debug is captured; uncommon methods fall through without throwing", async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "bcode-debug-"))
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "bcode-debug-ws-"))
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const impl = yield* BrowserExecute.make(data)
        return yield* impl.execute(
          {
            description: "Exercise console methods",
            code: `console.debug("captured-debug");
                   console.table([{a: 1}]);
                   console.trace("trace-call");
                   return "ok";`,
          },
          { sessionID: "console-debug-test", workspaceDir: ws },
        )
      }),
    ),
  )
  expect(result.output).toContain("captured-debug")
  expect(JSON.parse(result.result)).toBe("ok")
  await Promise.all([data, ws].map((d) => fs.rm(d, { recursive: true, force: true })))
})

// Timeout isolation: a timed-out snippet keeps running as an orphan (JS
// Promises are not preemptible), so its scoped Session view must stop working
// while the persistent Session remains available to the next call. Browser
// behavior is covered by browser-auto-connect; these snippets need no Chrome.
const runTimeout = async (id: string, code: string, timeout: number, onChunk?: (o: string) => Effect.Effect<void>) => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "bcode-to-"))
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "bcode-to-ws-"))
  const err = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const impl = yield* BrowserExecute.make(data)
        return yield* impl.execute(
          { description: "timeout test", code, timeout },
          { sessionID: id, workspaceDir: ws, onChunk },
        )
      }),
    ),
  ).then(
    () => {
      throw new Error("expected timeout")
    },
    (e: unknown) => String(e),
  )
  await Promise.all([data, ws].map((d) => fs.rm(d, { recursive: true, force: true })))
  return err
}

test("timeout returns partial output and preserves the session", async () => {
  const id = "timeout-isolation-test"
  const before = SessionStore.get(id)
  const err = await runTimeout(
    id,
    `console.log("progress-marker");
     await new Promise((r) => setTimeout(r, 60_000));`,
    100,
  )
  expect(err).toContain("timed out after 100 ms")
  expect(err).toContain("Partial console output before timeout:")
  expect(err).toContain("progress-marker")
  // The next call gets the exact same persistent Session. The orphan only had
  // a scoped view, whose post-timeout CDP behavior is covered by the V4 test.
  expect(before.isConnected()).toBe(false)
  expect(SessionStore.get(id)).toBe(before)
  await SessionStore.evict(id)
})

test("console capture and onChunk stop after timeout", async () => {
  const chunks: string[] = []
  const err = await runTimeout(
    "timeout-capture-test",
    `console.log("early");
     await new Promise((r) => setTimeout(r, 250));
     console.log("late");`,
    100,
    (o) =>
      Effect.sync(() => {
        chunks.push(o)
      }),
  )
  expect(err).toContain("early")
  // Let the orphan's late log fire, then confirm it was not captured.
  await new Promise((r) => setTimeout(r, 400))
  expect(chunks.some((c) => c.includes("early"))).toBe(true)
  expect(chunks.some((c) => c.includes("late"))).toBe(false)
  await SessionStore.evict("timeout-capture-test")
})

test("re-running the execute effect after a timeout gets fresh state", async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "bcode-rerun-"))
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "bcode-rerun-ws-"))
  const impl = await Effect.runPromise(BrowserExecute.make(data))
  // One Effect value, run twice. Each run must resolve its own Session and
  // capture buffer — the second run's error must carry its own partial
  // output, not inherit the first run's frozen capture or scoped view.
  // onChunk deliveries discriminate: a run that inherited a frozen capture
  // buffer never tees, so it produces zero chunks (the frozen buffer still
  // *contains* run 1's text, which is why asserting on the error message
  // alone cannot catch this).
  const chunks: string[] = []
  const eff = impl.execute(
    {
      description: "rerun test",
      code: `console.log("progress-marker");
             await new Promise((r) => setTimeout(r, 60_000));`,
      timeout: 100,
    },
    {
      sessionID: "rerun-test",
      workspaceDir: ws,
      onChunk: (o) =>
        Effect.sync(() => {
          chunks.push(o)
        }),
    },
  )
  const run = () =>
    Effect.runPromise(eff).then(
      () => "resolved",
      (e: unknown) => String(e),
    )
  const first = await run()
  const afterFirst = chunks.length
  const second = await run()
  expect(first).toContain("progress-marker")
  expect(second).toContain("progress-marker")
  expect(afterFirst).toBeGreaterThan(0)
  expect(chunks.length).toBeGreaterThan(afterFirst)
  await SessionStore.evict("rerun-test")
  await Promise.all([data, ws].map((d) => fs.rm(d, { recursive: true, force: true })))
})

test("invalidate retires the expected Session even after replacement", async () => {
  const id = "invalidate-replaced-test"
  const s1 = SessionStore.get(id)
  await SessionStore.evict(id)
  const s2 = SessionStore.get(id)
  SessionStore.invalidate(id, s1, new Error("retired stale session"))
  // The successor entry is untouched, but the stale object is still dead.
  expect(SessionStore.get(id)).toBe(s2)
  await expect(s1.connect({ wsUrl: "ws://127.0.0.1:9/nope" })).rejects.toThrow(/retired stale session/)
  await SessionStore.evict(id)
})

test("timeout output is tail-capped to valid UTF-8", async () => {
  // ~25 KiB of multibyte lines, all logged before the sleep.
  const err = await runTimeout(
    "timeout-truncate-test",
    `for (let i = 0; i < 300; i++) console.log("é".repeat(40) + "-line-" + i);
     await new Promise((r) => setTimeout(r, 60_000));`,
    100,
  )
  expect(err).toContain("[partial console output truncated; showing final bytes]")
  expect(err).toContain("-line-299")
  expect(err).not.toContain("-line-0\n")
  expect(err).not.toContain("\uFFFD")
  await SessionStore.evict("timeout-truncate-test")
})

// Concurrency safety: two overlapping execute() calls (different sessionIDs)
// must each capture their own console output without leaking into each other
// or into the real global console. No Chrome required — the snippets never
// touch `session`. Regression guard for the global-monkey-patch bug fixed
// by the per-call `console` argument shadowing the global.
test("overlapping execute calls do not clobber each other's console capture", async () => {
  const realLogBefore = console.log
  const aWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "bcode-conc-a-"))
  const bWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "bcode-conc-b-"))
  const aData = await fs.mkdtemp(path.join(os.tmpdir(), "bcode-data-a-"))
  const bData = await fs.mkdtemp(path.join(os.tmpdir(), "bcode-data-b-"))

  const run = (label: string, dataDirX: string, workspace: string) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const impl = yield* BrowserExecute.make(dataDirX)
          return yield* impl.execute(
            {
              description: `Concurrent snippet ${label}`,
              // Yield once so both snippets' bodies are mid-execution at the same
              // time; under the old global-patch impl, B's tee would shadow A's
              // and the `finally` chain would corrupt both captures + the global.
              code: `await new Promise((r) => setTimeout(r, 50));
                     console.log("hello from ${label}");
                     await new Promise((r) => setTimeout(r, 50));
                     console.log("bye from ${label}");
                     return ${JSON.stringify(label)};`,
            },
            { sessionID: `concurrency-${label}`, workspaceDir: workspace },
          )
        }),
      ),
    )

  const [a, b] = await Promise.all([run("A", aData, aWorkspace), run("B", bData, bWorkspace)])

  expect(a.output).toBe("hello from A\nbye from A\n")
  expect(b.output).toBe("hello from B\nbye from B\n")
  expect(JSON.parse(a.result)).toBe("A")
  expect(JSON.parse(b.result)).toBe("B")
  // Global console must be untouched.
  expect(console.log).toBe(realLogBefore)

  await Promise.all([aWorkspace, bWorkspace, aData, bData].map((d) => fs.rm(d, { recursive: true, force: true })))
})
