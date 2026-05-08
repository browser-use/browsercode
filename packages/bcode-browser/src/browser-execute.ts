// browser_execute — single-tool browser interface (decisions.md §3.2).
//
// Executes a JavaScript snippet in-process against a per-opencode-session
// `Session` (the CDP transport from `./cdp/session.ts`). No subprocess, no
// daemon, no Unix socket, no `uv` — we wrap the snippet with
// `new AsyncFunction("session", code)` and run it.
//
// Snippet scope (Phase H hard rule #3 — workspace-as-plain-code):
//   `session`        — the live CDP `Session`, persistent across calls.
//   standard JS globals.
//
// Nothing is auto-loaded. To reuse code from a previous snippet the agent
// writes plain `await import("/abs/path/foo.ts?t=" + Date.now())` against a
// `.ts` file it owns under `<projectDir>/.bcode/agent-workspace/`. Same
// mechanism for a 5-line wrapper and a 500-line scrape script. The Level-2
// wrapper supplies `ctx.workspaceDir` so `.ts` files written under it can be
// addressed by absolute path; this resolver creates the dir on first use.
//
// Output capture: console.log calls inside the snippet stream via a
// monkey-patch around `console.log`/`console.error`/`console.warn`/
// `console.info`. The originals are restored in a `finally` block — even if
// the snippet throws, even on timeout. See
// `memory/browsercode/phase_h_eval_feasibility_findings.md` for the verified
// pattern (compiled-mode `bun build --compile` works on Linux x64; AsyncFunction
// + dynamic import survive bunfs).
//
// Cancellation: JS Promises are not preemptively cancellable. A snippet
// without `await` yield-points (e.g. `for (let i = 0; i < 1e9; i++) {}`)
// runs to completion before our timeout fiber observes it. `Effect.timeoutOrElse`
// fails the surrounding fiber but the orphan Promise keeps running until it
// finishes. This matches the `uv run` subprocess case (SIGTERM only after
// the Python signal handler yields). Document, don't fix.
//
// Level 1 per decisions.md §1c — substantial implementation lives here. The
// Level-2 hook in packages/opencode is a thin adapter.

import fs from "fs/promises"
import { Effect, Schema } from "effect"
import { SessionStore } from "./session-store"
import { Skills } from "./skills"

const DEFAULT_TIMEOUT_MS = 60 * 1000
const MAX_TIMEOUT_MS = 10 * 60 * 1000

export const parameters = Schema.Struct({
  code: Schema.String.annotate({
    description: "JavaScript source. Wrapped in an async function with `session` (CDP Session) bound.",
  }),
  timeout: Schema.optional(Schema.Number).annotate({
    description: `Timeout in milliseconds. Default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}.`,
  }),
})

export type Parameters = Schema.Schema.Type<typeof parameters>

export interface ExecuteContext {
  // Identifies the per-opencode-session CDP Session to bind into the snippet.
  // The same Session is reused across calls — the agent calls
  // `session.connect(...)` in one snippet and subsequent snippets find the
  // already-connected Session.
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

export interface ExecuteResult {
  readonly output: string
  // The snippet's `return` value, JSON-serialized when possible. `undefined`
  // serializes as `null` (JSON has no undefined). Non-serializable values
  // fall back to `String(v)`.
  readonly result: string
}

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
// keyed on `ctx.sessionID`. The agent connects with `await session.connect(...)`
// in one snippet (Way 1 / Way 2 / Way 3 in BROWSER.md); the Session persists
// for follow-up snippets in the same opencode session.
//
// `dataDir` is opencode's XDG_DATA_HOME for bcode (~/.local/share/bcode/ on
// Linux/Mac). Compiled-mode skills are extracted to `<dataDir>/skills/` once
// per build hash; dev mode resolves to the in-tree `packages/bcode-browser/
// skills/` directly. The resolved path is exposed via the returned
// `skillsDir` getter so the Level-2 wrapper can substitute it into the tool
// description at make-time.
export const make = Effect.fn("BrowserExecute.make")(function* (dataDir: string) {
  const skillsDir = yield* Effect.promise(() => Skills.resolveSkillsDir(dataDir))

  const execute = (args: Parameters, ctx: ExecuteContext) =>
    Effect.gen(function* () {
      const session = SessionStore.get(ctx.sessionID)
      yield* Effect.promise(() => fs.mkdir(ctx.workspaceDir, { recursive: true }))

      const wrapped = yield* Effect.try({
        try: () => new AsyncFunction("session", args.code),
        catch: (err) => new Error(`syntax error in browser_execute snippet: ${err}`),
      })

      let output = ""
      const realLog = console.log
      const realErr = console.error
      const realWarn = console.warn
      const realInfo = console.info
      const tee = (...a: unknown[]) => {
        output += a.map((x) => (typeof x === "string" ? x : serialize(x))).join(" ") + "\n"
        if (ctx.onChunk) Effect.runFork(ctx.onChunk(output))
      }
      console.log = tee
      console.error = tee
      console.warn = tee
      console.info = tee

      const ran = yield* Effect.tryPromise({
        try: () => wrapped(session),
        catch: (err) => new Error(`browser_execute snippet threw: ${err instanceof Error ? err.stack ?? err.message : String(err)}`),
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            console.log = realLog
            console.error = realErr
            console.warn = realWarn
            console.info = realInfo
          }),
        ),
      )

      return { output, result: serialize(ran) } satisfies ExecuteResult
    }).pipe(
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: Math.min(args.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
        orElse: () => Effect.fail(new Error("browser_execute timed out")),
      }),
    )

  return { parameters, execute, skillsDir }
})

export * as BrowserExecute from "./browser-execute"
