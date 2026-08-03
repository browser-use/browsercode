// browser_execute — single-tool browser interface (decisions.md §3.2).
//
// Executes a JavaScript snippet in-process against a per-opencode-session
// `Session` (the CDP transport from `./cdp/session.ts`). No subprocess, no
// daemon, no Unix socket, no `uv` — we wrap the snippet with
// `new AsyncFunction("session", "console", code)` and run it.
//
// Snippet scope (Phase H hard rule #3 — workspace-as-plain-code):
//   `session`        — the live CDP `Session`, persistent across calls.
//   `console`        — per-call capture object shadowing the global. Same
//                      `{log, error, warn, info}` API as the real console.
//   standard JS globals.
//
// When BU_CDP_WS or BU_CDP_URL binds the process to a provisioned browser,
// the tool connects and attaches its existing page before running a snippet.
// Local sessions keep explicit connection behavior. To reuse code from a
// previous snippet the agent writes plain
// `await import("/abs/path/foo.ts?t=" + Date.now())` against a `.ts` file it
// owns under `<projectDir>/.bcode/agent-workspace/`. Same mechanism for a
// 5-line wrapper and a 500-line scrape script. The Level-2 wrapper supplies
// `ctx.workspaceDir` so `.ts` files written under it can be addressed by
// absolute path; this resolver creates the dir on first use.
//
// Output capture: a per-call `console` object (`{log, error, warn, info}`)
// is bound into the snippet's lexical scope as the second AsyncFunction
// argument. JavaScript's scope chain resolves `console.log(...)` to the
// function parameter before reaching the global, so existing snippets keep
// working byte-identically while the global `console` stays untouched.
// This is concurrency-safe: two overlapping `execute` calls (different
// opencode sessions in the same process, parallel tool calls within one
// session, etc.) each get their own capture buffer with no global state to
// clobber. See `memory/browsercode/phase_h_eval_feasibility_findings.md`
// for the verified eval pattern (compiled-mode `bun build --compile` works
// on Linux x64; AsyncFunction + dynamic import survive bunfs).
//
// Cancellation: JS Promises are not preemptively cancellable. A snippet
// without `await` yield-points (e.g. `for (let i = 0; i < 1e9; i++) {}`)
// runs to completion before our timeout fiber observes it. A yielding snippet
// keeps running as an orphan after timeout, so each call receives a scoped
// Session view. The view rejects methods after its deadline while the real
// Session and its tabs remain available to the next call.
//
// Level 1 per decisions.md §1c — substantial implementation lives here. The
// Level-2 hook in packages/opencode is a thin adapter.

import fs from "fs/promises"
import path from "path"
import { Effect, Schema } from "effect"
import { withSessionExecution } from "./cdp/session"
import { SessionStore } from "./session-store"
import { Skills } from "./skills"

const DEFAULT_TIMEOUT_MS = 60 * 1000
const MAX_TIMEOUT_MS = 10 * 60 * 1000
const MAX_TIMEOUT_OUTPUT_BYTES = 8 * 1024
const TIMEOUT_OUTPUT_TRUNCATED = "[partial console output truncated; showing final bytes]\n"
const v4Connections = new Map<string, Promise<void>>()
const v4Bootstrapped = new Set<string>()

// Tail-cap the captured output for the timeout error: last 8 KiB, snapped
// forward to a UTF-8 sequence start so multibyte characters survive the cut.
const timeoutOutput = (output: string) => {
  const bytes = Buffer.from(output, "utf8")
  if (bytes.length <= MAX_TIMEOUT_OUTPUT_BYTES) return output
  let start = bytes.length - (MAX_TIMEOUT_OUTPUT_BYTES - Buffer.byteLength(TIMEOUT_OUTPUT_TRUNCATED))
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++
  return TIMEOUT_OUTPUT_TRUNCATED + bytes.subarray(start).toString("utf8")
}

// Field order matters: providers stream tool-call args in schema-declared
// order, so the model commits to whichever field comes first. `code` is the
// substantive output; `description` is a summary written after the code
// exists, mirroring the shell tool's `command` → ... → `description` shape.
export const parameters = Schema.Struct({
  code: Schema.String.annotate({
    description:
      "The JavaScript snippet to execute. `session` (CDP Session) and `console` are in scope; see the `browser-execute` skill for the snippet model.",
  }),
  timeout: Schema.optional(Schema.Number).annotate({
    description: `Optional timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS})`,
  }),
  description: Schema.String.annotate({
    description:
      "Clear, concise description of what this snippet does in 3-7 words. Examples:\nInput: code that connects to local Chrome\nOutput: Connect to local Chrome\n\nInput: scrape product titles from current page\nOutput: Scrape product titles\n\nInput: capture a screenshot of the homepage\nOutput: Screenshot homepage",
  }),
})

export type Parameters = Schema.Schema.Type<typeof parameters>

export interface ExecuteContext {
  // Identifies the per-opencode-session CDP Session to bind into the snippet.
  // Provisioned endpoints auto-connect and attach; local sessions connect explicitly.
  readonly sessionID: string
  // Per-project workspace dir: <projectDir>/.bcode/agent-workspace/. Created
  // on first call. The agent reads/writes/edits .ts files here via the
  // standard read/write/edit tools and imports them at runtime via
  // `await import("<absPath>?t=" + Date.now())`. Resolved by the Level-2
  // wrapper from opencode's project-detection (Instance.directory).
  readonly workspaceDir: string
  // Optional progress callback invoked per output chunk (combined console
  // streams). Receives the fully accumulated output so far, not just the
  // delta — simpler for consumers that just want to set "current output".
  readonly onChunk?: (output: string) => Effect.Effect<void>
}

// One screenshot collected during an execute() call. Drained into the
// Level-2 wrapper's `attachments[]` so the agent sees the image inline on the
// next assistant turn — no decode/write/read dance from inside the snippet.
export interface CollectedScreenshot {
  readonly mime: "image/png" | "image/jpeg" | "image/webp"
  readonly base64: string
}

export interface ExecuteResult {
  readonly output: string
  // The snippet's `return` value, JSON-serialized when possible. `undefined`
  // serializes as `null` (JSON has no undefined). Non-serializable values
  // fall back to `String(v)`.
  readonly result: string
  // Every successful `Page.captureScreenshot` made by the snippet, in the
  // order the CDP responses came back. Empty when the snippet didn't take
  // any screenshots.
  readonly screenshots: readonly CollectedScreenshot[]
}

const SCREENSHOT_FORMAT_TO_MIME: Record<string, CollectedScreenshot["mime"]> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
}

const SCREENSHOT_FORMAT_TO_EXT: Record<string, string> = {
  png: "png",
  jpeg: "jpg",
  webp: "webp",
}

const screenshotMime = (format: unknown): CollectedScreenshot["mime"] =>
  SCREENSHOT_FORMAT_TO_MIME[typeof format === "string" ? format : "png"] ?? "image/png"

const screenshotExt = (format: unknown): string =>
  SCREENSHOT_FORMAT_TO_EXT[typeof format === "string" ? format : "png"] ?? "png"

// AsyncFunction is not a global — pull it off an async arrow's constructor.
const AsyncFunction = (async () => {}).constructor as new (
  ...args: string[]
) => (...injected: unknown[]) => Promise<unknown>

const serialize = (v: unknown): string => {
  if (v === undefined) return "null"
  try {
    return JSON.stringify(
      v,
      (_k, val) => (typeof val === "bigint" ? val.toString() : val),
      2,
    ) ?? "null"
  } catch {
    return JSON.stringify(String(v))
  }
}

// Snippet executor. The CDP Session is resolved per-call from `SessionStore`
// keyed on `ctx.sessionID`. Provisioned endpoints auto-connect and attach
// before the snippet; local sessions connect explicitly.
//
// `dataDir` is opencode's XDG_DATA_HOME for bcode (~/.local/share/bcode/ on
// Linux/Mac). Compiled-mode skills are extracted to `<dataDir>/skills/` once
// per build hash; dev mode resolves to the in-tree `packages/bcode-browser/
// skills/` directly. The resolved path is exposed via the returned
// `skillsDir` getter so the Level-2 wrapper can substitute it into the tool
// description at make-time.
export const make = Effect.fn("BrowserExecute.make")(function* (dataDir: string) {
  const skillsDir = yield* Effect.promise(() => Skills.resolveSkillsDir(dataDir))

  // Effect values are re-runnable, so per-run state lives inside the suspend
  // thunk: each run gets its own execution scope and capture buffer. A re-run
  // after a timeout must not inherit an inactive scope or frozen capture.
  const execute = (args: Parameters, ctx: ExecuteContext) =>
    Effect.suspend(() => {
    const session = SessionStore.get(ctx.sessionID)
    const captured = { active: true, output: "" }
    const sessionExecution = { active: true }
    const timeout = Math.min(args.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
    return Effect.gen(function* () {
      yield* Effect.promise(() => fs.mkdir(ctx.workspaceDir, { recursive: true }))

      const wrapped = yield* Effect.try({
        try: () => new AsyncFunction("session", "console", args.code),
        catch: (err) => new Error(`syntax error in browser_execute snippet: ${err}`),
      })

      yield* Effect.tryPromise({
        try: () => ensureCloudConnected(ctx.sessionID, session),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      })

      const tee = (...a: unknown[]) => {
        if (!captured.active) return
        captured.output += a.map((x) => (typeof x === "string" ? x : serialize(x))).join(" ") + "\n"
        if (ctx.onChunk) Effect.runFork(ctx.onChunk(captured.output))
      }
      // Prototype-chain to the real `console` so uncommon methods (`debug`,
      // `dir`, `trace`, `table`, `group`, …) don't throw when a snippet calls
      // them. The five "log line" methods are tee'd into our capture; anything
      // else falls through to the real console — written but not captured.
      const snippetConsole = Object.assign(Object.create(console), {
        log: tee,
        error: tee,
        warn: tee,
        info: tee,
        debug: tee,
      })

      // Screenshot tap. Subscribes to the Session's call-result stream for
      // the duration of this execute() call; every successful
      // `Page.captureScreenshot` is collected (drained into `attachments[]`
      // by the Level-2 wrapper so the agent sees the image inline) and,
      // when `BCODE_SCREENSHOT_DIR` is set, also written to disk for
      // eval-judge consumption. Two consumers of one tap.
      //
      // Concurrency note: parallel execute() calls against the same Session
      // (rare but possible — different sessionIDs share no Session, but a
      // single sessionID with two in-flight tool calls would) each subscribe
      // independently and would each see all screenshots produced during
      // their lifetime. Acceptable for v1; opencode tool calls within one
      // assistant message are serialized anyway.
      const screenshots: CollectedScreenshot[] = []
      const dumpDir = process.env.BCODE_SCREENSHOT_DIR
      const startedAt = Date.now()
      let seq = 0
      const unsubscribe = session.onCallResult((method, params, result) => {
        if (method !== "Page.captureScreenshot") return
        const r = result as { data?: unknown }
        if (typeof r?.data !== "string") return
        const p = (params ?? {}) as { format?: unknown }
        const mime = screenshotMime(p.format)
        const ext = screenshotExt(p.format)
        const idx = seq++
        screenshots.push({ mime, base64: r.data })
        if (dumpDir) {
          const filename = `${ctx.sessionID}-${startedAt}-${String(idx).padStart(3, "0")}.${ext}`
          fs.mkdir(dumpDir, { recursive: true })
            .then(() => fs.writeFile(path.join(dumpDir, filename), Buffer.from(r.data as string, "base64")))
            .catch(() => { /* eval-side dump is best-effort */ })
        }
      })

      const ran = yield* Effect.tryPromise({
        try: () => withSessionExecution(sessionExecution, () => wrapped(session, snippetConsole)),
        catch: (err) => new Error(`browser_execute snippet threw: ${err instanceof Error ? err.stack ?? err.message : String(err)}`),
      }).pipe(Effect.ensuring(Effect.sync(() => unsubscribe())))

      return { output: captured.output, result: serialize(ran), screenshots } satisfies ExecuteResult
    }).pipe(
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () =>
          Effect.suspend(() => {
            captured.active = false
            sessionExecution.active = false
            const output = timeoutOutput(captured.output)
            const error = new Error(
              [
                `browser_execute timed out after ${timeout} ms; this invocation can no longer issue CDP commands, but the timeout did not close the CDP session`,
                output.trim() ? `Partial console output before timeout:\n${output.trimEnd()}` : "",
              ]
                .filter(Boolean)
                .join("\n\n"),
            )
            return Effect.fail(error)
          }),
      }),
    )
  })

  return { parameters, execute, skillsDir }
})

async function ensureCloudConnected(sessionID: string, session: ReturnType<typeof SessionStore.get>) {
  if (!process.env.V4_RUN_ID || (!process.env.BU_CDP_WS && !process.env.BU_CDP_URL)) return
  if (v4Bootstrapped.has(sessionID)) return

  const existing = v4Connections.get(sessionID)
  if (existing) return existing

  const connecting = (async () => {
    if (!session.isConnected()) await session.connect()
    if (session.getActiveSession()) return
    const page = (await session.domains.Target.getTargets({})).targetInfos.find(
      (target) => target.type === "page" && !target.url.startsWith("chrome://"),
    )
    if (page) await session.use(page.targetId)
  })()
  v4Connections.set(sessionID, connecting)
  try {
    await connecting
  } finally {
    // One automatic attempt per logical BrowserCode session. A later disconnect
    // must be surfaced: BU_CDP_WS is the browser selected at run start, not
    // necessarily a newer browser the agent explicitly switched to during this run.
    v4Bootstrapped.add(sessionID)
    if (v4Connections.get(sessionID) === connecting) v4Connections.delete(sessionID)
  }
}

export * as BrowserExecute from "./browser-execute"
