// browser_delegate — bounded Browser Use leaf-agent execution.
//
// BrowserCode remains the planner and verifier. This tool starts a short-lived
// Python subprocess that attaches a Browser Use Agent to the same CDP endpoint,
// performs one explicitly bounded browser episode, persists its full history,
// and returns a browser-observed receipt to the parent model.

import fs from "fs/promises"
import path from "path"
import { Effect, Schema } from "effect"

const MAX_STEPS = 25
const MAX_ACTIONS_PER_STEP = 3
const PROCESS_TIMEOUT_MS = 300_000
const SHUTDOWN_GRACE_MS = 5_000

export const enabled = () =>
  Boolean(
    (process.env.BROWSER_USE_DELEGATE_API_KEY ?? process.env.BROWSER_USE_API_KEY) &&
      (process.env.BU_CDP_WS ?? process.env.BU_CDP_URL),
  )

export const parameters = Schema.Struct({
  task: Schema.String.annotate({
    description:
      "One complete, bounded browser episode. Include its start URL, all known values, and the exact data the leaf must return.",
  }),
  done_when: Schema.String.annotate({
    description:
      "The directly observable final browser state and exact result payload required before the leaf may claim success.",
  }),
})

export type Parameters = Schema.Schema.Type<typeof parameters>

const resultSchema = Schema.Struct({
  schema_version: Schema.Literal(1),
  delegation_id: Schema.String,
  status: Schema.Literals(["completed", "gave_up", "timed_out", "failed"]),
  summary: Schema.String,
  action_digest: Schema.Array(Schema.String),
  action_details: Schema.Array(Schema.String),
  extracted_content: Schema.Array(Schema.String),
  done_condition_claimed: Schema.Boolean,
  initial_url: Schema.String,
  initial_title: Schema.String,
  final_url: Schema.String,
  observed_state_after: Schema.NullOr(
    Schema.Struct({
      target_id: Schema.NullOr(Schema.String),
      url: Schema.String,
      title: Schema.String,
      tabs: Schema.Array(
        Schema.Struct({
          target_id: Schema.String,
          url: Schema.String,
          title: Schema.String,
        }),
      ),
      page_excerpt: Schema.String,
      page_excerpt_truncated: Schema.Boolean,
      screenshot_artifact: Schema.NullOr(Schema.String),
      captured_at: Schema.String,
      capture_error: Schema.NullOr(Schema.String),
    }),
  ),
  blocker: Schema.NullOr(Schema.String),
  uncertainties: Schema.Array(Schema.String),
  metrics: Schema.Struct({
    duration_seconds: Schema.Number,
    steps: Schema.Number,
    actions: Schema.Number,
    cost_usd: Schema.Number,
    total_tokens: Schema.Number,
  }),
  artifacts: Schema.Array(Schema.String),
  trace_id: Schema.NullOr(Schema.String),
})

export type Result = Schema.Schema.Type<typeof resultSchema>

export interface ExecuteContext {
  readonly delegationID: string
  readonly parentSessionID: string
  readonly targetID?: string
  readonly artifactRoot: string
  readonly indexPath: string
  readonly apiKey: string
  readonly parentSpanContext?: string
  readonly model?: string
}

export const execute = (args: Parameters, ctx: ExecuteContext) =>
  Effect.tryPromise({
    try: async () => {
      if (!ctx.apiKey) throw new Error("browser_delegate requires BROWSER_USE_DELEGATE_API_KEY")
      const cdpUrl = process.env.BU_CDP_WS ?? process.env.BU_CDP_URL
      if (!cdpUrl) throw new Error("browser_delegate requires BU_CDP_WS or BU_CDP_URL")

      const delegationID = ctx.delegationID.replaceAll(/[^a-zA-Z0-9._-]/g, "_")
      await rejectAfterFailedDelegation(ctx.indexPath, ctx.targetID)
      const directory = path.join(ctx.artifactRoot, delegationID)
      const requestPath = path.join(directory, "request.json")
      const resultPath = path.join(directory, "result.json")
      const stdoutPath = path.join(directory, "stdout.log")
      const stderrPath = path.join(directory, "stderr.log")
      const temporaryDirectory = path.join(directory, "tmp")
      const projectDirectory = path.join(import.meta.dir, "../delegate")
      const runner = process.env.BROWSER_USE_DELEGATE_RUNNER ?? path.join(projectDirectory, "run.py")

      await fs.mkdir(temporaryDirectory, { recursive: true })
      await Bun.write(
        requestPath,
        JSON.stringify(
          {
            schema_version: 1,
            delegation_id: delegationID,
            parent_session_id: ctx.parentSessionID,
            target_id: ctx.targetID ?? null,
            task: args.task,
            done_when: args.done_when,
            limits: {
              max_steps: MAX_STEPS,
              max_actions_per_step: MAX_ACTIONS_PER_STEP,
              timeout_seconds: PROCESS_TIMEOUT_MS / 1000,
            },
          },
          null,
          2,
        ) + "\n",
      )

      const child = Bun.spawn(
        [
          "uv",
          "run",
          "--frozen",
          "--project",
          projectDirectory,
          "python",
          runner,
          "--request",
          requestPath,
          "--result",
          resultPath,
        ],
        {
          cwd: directory,
          env: {
            ...process.env,
            BROWSER_USE_API_KEY: ctx.apiKey,
            BROWSER_USE_DELEGATE_MODEL: ctx.model ?? "bu-2-0",
            BU_CDP_WS: cdpUrl,
            LMNR_SPAN_CONTEXT: ctx.parentSpanContext ?? process.env.LMNR_PARENT_SPAN_CONTEXT ?? "",
            TMPDIR: temporaryDirectory,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
      const outcome = await Promise.race([
        child.exited.then((code) => ({ code, timedOut: false })),
        Bun.sleep(PROCESS_TIMEOUT_MS).then(() => ({ code: -1, timedOut: true })),
      ])

      if (outcome.timedOut) {
        child.kill("SIGTERM")
        const stopped = await Promise.race([
          child.exited.then(() => true),
          Bun.sleep(SHUTDOWN_GRACE_MS).then(() => false),
        ])
        if (!stopped) child.kill("SIGKILL")
        await child.exited
      }

      const [stdout, stderr] = await output
      await Promise.all([Bun.write(stdoutPath, stdout), Bun.write(stderrPath, stderr)])

      if (outcome.timedOut && !(await Bun.file(resultPath).exists())) {
        await Bun.write(
          resultPath,
          JSON.stringify(
            {
              schema_version: 1,
              delegation_id: delegationID,
              status: "timed_out",
              summary: "Browser Use reached the 300 second delegation deadline.",
              action_digest: [],
              action_details: [],
              extracted_content: [],
              done_condition_claimed: false,
              initial_url: "",
              initial_title: "",
              final_url: "",
              observed_state_after: null,
              blocker: "delegation deadline reached",
              uncertainties: [],
              metrics: {
                duration_seconds: PROCESS_TIMEOUT_MS / 1000,
                steps: 0,
                actions: 0,
                cost_usd: 0,
                total_tokens: 0,
              },
              artifacts: ["request.json", "stdout.log", "stderr.log"],
              trace_id: traceID(ctx.parentSpanContext),
            },
            null,
            2,
          ) + "\n",
        )
      }

      if (!(await Bun.file(resultPath).exists())) {
        throw new Error(
          `browser_delegate runner exited with code ${outcome.code} without writing result.json; inspect ${stderrPath}`,
        )
      }

      const result = Schema.decodeUnknownSync(resultSchema)(await Bun.file(resultPath).json())
      await appendIndex(ctx.indexPath, {
        delegation_id: delegationID,
        target_id: result.observed_state_after?.target_id ?? ctx.targetID ?? null,
        task: args.task,
        done_when: args.done_when,
        status: result.status,
        result: path.relative(path.dirname(ctx.indexPath), resultPath),
      })
      return { ...result, artifact_directory: directory }
    },
    catch: (error) => new Error(`browser_delegate failed: ${error instanceof Error ? error.message : String(error)}`),
  })

const appendIndex = async (indexPath: string, entry: Record<string, unknown>) => {
  const file = Bun.file(indexPath)
  const current = (await file.exists()) ? await file.json() : []
  if (!Array.isArray(current)) throw new Error(`${indexPath} must contain a JSON array`)
  await Bun.write(indexPath, JSON.stringify([...current, entry], null, 2) + "\n")
}

const rejectAfterFailedDelegation = async (indexPath: string, targetID: string | undefined) => {
  if (!targetID) return
  const file = Bun.file(indexPath)
  if (!(await file.exists())) return
  const current: unknown = await file.json()
  if (!Array.isArray(current)) throw new Error(`${indexPath} must contain a JSON array`)
  const priorFailure = current.find(
    (entry): entry is Record<string, unknown> =>
      typeof entry === "object" &&
      entry !== null &&
      entry.target_id === targetID &&
      ["gave_up", "timed_out", "failed"].includes(String(entry.status)),
  )
  if (!priorFailure) return
  throw new Error(
    `Browser Use already ${String(priorFailure.status)} on target ${targetID}; BrowserCode must take over this tab`,
  )
}

const traceID = (context: string | undefined): string | null => {
  if (!context) return null
  try {
    const value = JSON.parse(context)
    return typeof value.traceId === "string"
      ? value.traceId
      : typeof value.trace_id === "string"
        ? value.trace_id
        : null
  } catch {
    return null
  }
}

export * as BrowserDelegate from "./browser-delegate"
