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
       await session.Page.navigate({ url: "data:text/html,<title>bcode-be</title>" })
       await session.waitFor("Page.loadEventFired", undefined, 5000)
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
            code: `await session.Page.enable();
                   await session.Page.navigate({ url: "data:text/html,<title>shot</title><body>hi" });
                   await session.waitFor("Page.loadEventFired", undefined, 5000);
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

  await Promise.all(
    [aWorkspace, bWorkspace, aData, bData].map((d) => fs.rm(d, { recursive: true, force: true })),
  )
})
