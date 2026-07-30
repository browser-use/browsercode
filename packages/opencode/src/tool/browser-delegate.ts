// browser_delegate — Level-2 adapter for the bounded Browser Use leaf agent.

import path from "path"
import { Effect, Schema } from "effect"
import { BrowserDelegate } from "@browser-use/bcode-browser/browser-delegate"
import { SessionStore } from "@browser-use/bcode-browser/session-store"
import { serializeSpawningToolSpanContext } from "@browser-use/bcode-laminar/span"
import { InstanceState } from "@/effect/instance-state"
import * as Tool from "./tool"
import DESCRIPTION from "./browser-delegate.txt"

export const BrowserDelegateTool = Tool.define(
  "browser_delegate",
  Effect.gen(function* () {
    const apiKey = process.env.BROWSER_USE_DELEGATE_API_KEY ?? process.env.BROWSER_USE_API_KEY ?? ""
    return {
      description: DESCRIPTION,
      parameters: BrowserDelegate.parameters,
      execute: (args: Schema.Schema.Type<typeof BrowserDelegate.parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "browser_delegate",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })
          const instance = yield* InstanceState.context
          const defaultRoot = path.join(instance.directory, ".bcode", "delegations")
          const delegationID = ctx.callID ?? crypto.randomUUID()
          const result = yield* BrowserDelegate.execute(args, {
            delegationID,
            parentSessionID: ctx.sessionID,
            targetID: SessionStore.get(ctx.sessionID).getActiveTarget(),
            artifactRoot: process.env.BROWSER_DELEGATION_ROOT ?? defaultRoot,
            indexPath: process.env.BROWSER_DELEGATION_INDEX ?? path.join(defaultRoot, "delegations.json"),
            apiKey,
            originalTask: currentUserRequest(ctx),
            parentSpanContext: serializeSpawningToolSpanContext(delegationID, ctx.sessionID),
            model: process.env.BROWSER_USE_DELEGATE_MODEL,
          })
          const finalTargetID = result.observed_state_after?.target_id
          if (finalTargetID && result.lease.state_disposition !== "restored") {
            yield* Effect.promise(async () => {
              try {
                const session = SessionStore.get(ctx.sessionID)
                if (!session.isConnected()) await session.connect()
                if (session.getActiveTarget() !== finalTargetID) await session.use(finalTargetID)
              } catch {
                // The receipt still contains the exact observed target. A later
                // browser_execute call can reconnect if deterministic handoff fails.
              }
            })
          }
          const resultArtifact =
            result.result_artifact && path.basename(result.result_artifact) === result.result_artifact
              ? path.join(result.artifact_directory, result.result_artifact)
              : null
          const attemptedState = result.observed_state_after
            ? {
                url: result.observed_state_after.url,
                title: result.observed_state_after.title,
                page_excerpt:
                  result.status === "completed"
                    ? undefined
                    : compactText(result.observed_state_after.page_excerpt, 1_200),
              }
            : null
          const parentFacingStatus = result.status === "completed" ? "claimed_complete" : result.status
          const receiptGuidance =
            result.status === "completed"
              ? "DONE_WHEN was claimed complete. Treat this episode as finished when the exact result satisfies the contract; do not replay it."
              : "DONE_WHEN was not satisfied. BrowserCode owns all remaining work, and Browser Use is disabled for the rest of this task."
          return {
            title: `browser_delegate: ${parentFacingStatus}`,
            output: JSON.stringify(
              {
                status: parentFacingStatus,
                episode_type: result.episode_type,
                completion_contract: {
                  done_when: result.done_when,
                  child_claimed_success: result.done_condition_claimed,
                },
                receipt_guidance: receiptGuidance,
                result: compactText(result.summary, 4_000),
                browser_lease: {
                  execution_mode: result.lease.execution_mode,
                  state_disposition: result.lease.state_disposition,
                  resumed_state:
                    result.lease.state_disposition === "restored"
                      ? { url: result.initial_url, title: result.initial_title }
                      : attemptedState,
                  attempted_state: attemptedState,
                },
                blocker: result.status === "completed" ? null : compactText(result.blocker ?? result.summary, 1_500),
                full_result_artifact: resultArtifact,
                artifact_directory: result.artifact_directory,
                metrics: result.metrics,
              },
              null,
              2,
            ),
            metadata: result,
            attachments: [],
          }
        }).pipe(Effect.orDie),
    }
  }),
)

const currentUserRequest = (ctx: Tool.Context) => {
  const assistant = ctx.messages.find((message) => message.info.id === ctx.messageID)
  const user = (() => {
    if (assistant && assistant.info.role === "assistant") {
      const parentID = assistant.info.parentID
      return ctx.messages.find((message) => message.info.id === parentID)
    }
    return ctx.messages.findLast((message) => message.info.role === "user")
  })()
  if (!user || user.info.role !== "user") return ""
  return user.parts
    .flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text.trim()] : []))
    .filter(Boolean)
    .join("\n\n")
}

const compactText = (value: string, limit: number) => {
  if (value.length <= limit) return value
  const half = Math.floor((limit - 70) / 2)
  return (
    value.slice(0, half) +
    "\n\n... receipt content truncated; full value saved in artifacts ...\n\n" +
    value.slice(-half)
  )
}
