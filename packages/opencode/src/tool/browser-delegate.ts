// browser_delegate — Level-2 adapter for the bounded Browser Use leaf agent.

import path from "path"
import { Effect, Schema } from "effect"
import { BrowserDelegate } from "@browser-use/bcode-browser/browser-delegate"
import { SessionStore } from "@browser-use/bcode-browser/session-store"
import { serializeTurnSpanContext } from "@browser-use/bcode-laminar/span"
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
          const result = yield* BrowserDelegate.execute(args, {
            delegationID: ctx.callID ?? crypto.randomUUID(),
            parentSessionID: ctx.sessionID,
            targetID: SessionStore.get(ctx.sessionID).getActiveTarget(),
            artifactRoot: process.env.BROWSER_DELEGATION_ROOT ?? defaultRoot,
            indexPath: process.env.BROWSER_DELEGATION_INDEX ?? path.join(defaultRoot, "delegations.json"),
            apiKey,
            originalTask: currentUserRequest(ctx),
            parentSpanContext: serializeTurnSpanContext(ctx.sessionID),
            model: process.env.BROWSER_USE_DELEGATE_MODEL,
          })
          const finalTargetID = result.observed_state_after?.target_id
          if (finalTargetID) {
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
          const screenshotArtifact = result.observed_state_after?.screenshot_artifact
          const screenshotPath =
            screenshotArtifact && path.basename(screenshotArtifact) === screenshotArtifact
              ? path.join(result.artifact_directory, screenshotArtifact)
              : undefined
          const screenshotFile = screenshotPath ? Bun.file(screenshotPath) : undefined
          const resultArtifact =
            result.result_artifact && path.basename(result.result_artifact) === result.result_artifact
              ? path.join(result.artifact_directory, result.result_artifact)
              : null
          const finalState = result.observed_state_after
            ? {
                url: result.observed_state_after.url,
                title: result.observed_state_after.title,
                page_excerpt: compactText(result.observed_state_after.page_excerpt),
                page_excerpt_truncated:
                  result.observed_state_after.page_excerpt_truncated ||
                  result.observed_state_after.page_excerpt.length > 4_000,
                screenshot_artifact: result.observed_state_after.screenshot_artifact,
                capture_error: result.observed_state_after.capture_error,
              }
            : null
          const attachments =
            screenshotFile && (yield* Effect.promise(() => screenshotFile.exists()))
              ? [
                  {
                    type: "file" as const,
                    mime: "image/png",
                    url: `data:image/png;base64,${Buffer.from(
                      yield* Effect.promise(() => screenshotFile.arrayBuffer()),
                    ).toString("base64")}`,
                  },
                ]
              : []
          return {
            title: `browser_delegate: ${result.status}`,
            output: [
              JSON.stringify(
                {
                  status: result.status,
                  completion_contract: {
                    done_when: result.done_when,
                    child_claimed_success: result.done_condition_claimed,
                    parent_must_verify: true,
                  },
                  result: result.summary,
                  result_truncated: result.result_truncated,
                  full_result_artifact: resultArtifact,
                  observed_values: result.extracted_content,
                  actions: result.action_digest,
                  initial_state: {
                    url: result.initial_url,
                    title: result.initial_title,
                  },
                  final_state: finalState,
                  unresolved: [result.blocker, ...result.uncertainties].filter(
                    (value): value is string => Boolean(value),
                  ),
                  metrics: result.metrics,
                  artifact_directory: result.artifact_directory,
                },
                null,
                2,
              ),
              attachments.length > 0 ? "(browser-observed post-action screenshot attached)" : "",
            ]
              .filter(Boolean)
              .join("\n\n"),
            metadata: result,
            attachments,
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

const compactText = (value: string) => {
  if (value.length <= 4_000) return value
  return value.slice(0, 1_965) + "\n\n... final state excerpt truncated ...\n\n" + value.slice(-1_965)
}
