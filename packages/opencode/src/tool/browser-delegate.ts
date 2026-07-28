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
    delete process.env.BROWSER_USE_DELEGATE_API_KEY
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
            parentSpanContext: serializeTurnSpanContext(ctx.sessionID),
            model: process.env.BROWSER_USE_DELEGATE_MODEL,
          })
          return {
            title: `browser_delegate: ${result.status}`,
            output: JSON.stringify(
              {
                status: result.status,
                summary: result.summary,
                action_digest: result.action_digest,
                done_condition_claimed: result.done_condition_claimed,
                final_url: result.final_url,
                blocker: result.blocker,
                uncertainties: result.uncertainties,
                metrics: result.metrics,
                artifact_directory: result.artifact_directory,
              },
              null,
              2,
            ),
            metadata: result,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
