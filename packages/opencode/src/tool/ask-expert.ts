import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionStore } from "@browser-use/bcode-browser/session-store"
import { Effect, Schema } from "effect"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { MessageID } from "@/session/schema"
import type { TaskPromptOps } from "./task"
import * as Tool from "./tool"
import DESCRIPTION from "./ask-expert.txt"

export const Parameters = Schema.Struct({
  request: Schema.String.annotate({
    description:
      "What the expert should resolve or audit now. Do not repeat the original task or conversation; they are inherited automatically.",
  }),
})

export const AskExpertTool = Tool.define(
  "ask_expert",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const configuredModel = process.env.BROWSER_EXPERT_MODEL
    if (!configuredModel) throw new Error("AskExpertTool requires BROWSER_EXPERT_MODEL")

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (args: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "ask_expert",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })

          const parent = yield* sessions.get(ctx.sessionID)
          const expert = yield* sessions.fork({
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
          })
          const model = Provider.parseModel(configuredModel)
          yield* sessions.setPermission({
            sessionID: expert.id,
            permission: [...(parent.permission ?? []), { permission: "ask_expert", pattern: "*", action: "deny" }],
          })
          SessionStore.share(ctx.sessionID, expert.id)

          yield* ctx.metadata({
            title: "Expert takeover",
            metadata: {
              parentSessionId: ctx.sessionID,
              expertSessionId: expert.id,
              model,
            },
          })

          const ops = ctx.extra?.promptOps as TaskPromptOps
          if (!ops) return yield* Effect.fail(new Error("AskExpertTool requires promptOps in ctx.extra"))

          const parts = yield* ops.resolvePromptParts(
            [
              "You are the expert continuation of the agent whose complete context you inherited.",
              "You share its exact live browser session and workspace. Inspect before acting, then resolve the current uncertainty or finish the missing work yourself; do not merely give advice when you can act.",
              "The CDP session is already connected and preserves the parent's active target. Check session.isConnected() and do not reconnect when it is true.",
              "Audit every original requirement, requested source, record identity, field, coverage claim, calculation, artifact, and evidence before handing back.",
              "Do not call ask_expert. Stop as soon as the issue is genuinely resolved or you have a concrete external blocker.",
              "End with a compact handback receipt containing: status (resolved or blocked), what you changed, evidence/artifacts, and any remaining issue.",
              "",
              `<handoff_request>${args.request}</handoff_request>`,
            ].join("\n"),
          )

          const result = yield* ops
            .prompt({
              messageID: MessageID.ascending(),
              sessionID: expert.id,
              model: {
                providerID: ProviderV2.ID.make(model.providerID),
                modelID: ModelV2.ID.make(model.modelID),
              },
              agent: "build",
              parts,
            })
            .pipe(
              Effect.onInterrupt(() => ops.cancel(expert.id)),
              Effect.ensuring(Effect.sync(() => SessionStore.forget(expert.id))),
            )
          const receipt = result.parts.findLast((part) => part.type === "text")?.text ?? ""
          const browser = SessionStore.get(ctx.sessionID)
          const browserState = browser.isConnected()
            ? yield* Effect.promise(async () => {
                const evaluated = await browser.domains.Runtime.evaluate({
                  expression:
                    "({url:location.href,title:document.title,text:(document.body?.innerText||'').slice(0,4000)})",
                  returnByValue: true,
                })
                const value = evaluated.result.value
                if (!value || typeof value !== "object") return
                const record = value as Record<string, unknown>
                return {
                  url: typeof record.url === "string" ? record.url : "",
                  title: typeof record.title === "string" ? record.title : "",
                  text: typeof record.text === "string" ? record.text : "",
                }
              }).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
            : undefined
          const screenshot = browser.isConnected()
            ? yield* Effect.promise(() => browser.domains.Page.captureScreenshot({ format: "png" })).pipe(
                Effect.map((captured) => captured.data),
                Effect.catchCause(() => Effect.succeed(undefined)),
              )
            : undefined
          const attachments =
            typeof screenshot === "string"
              ? [
                  {
                    type: "file" as const,
                    mime: "image/png",
                    url: `data:image/png;base64,${screenshot}`,
                  },
                ]
              : []

          return {
            title: "Expert takeover complete",
            output: [
              `<expert_handoff session_id="${expert.id}" model="${configuredModel}">`,
              receipt || "The expert returned without a textual receipt; inspect its nested trace.",
              browserState
                ? [
                    "",
                    "<browser_state_after>",
                    `URL: ${browserState.url}`,
                    `Title: ${browserState.title}`,
                    browserState.text,
                    "</browser_state_after>",
                  ].join("\n")
                : "",
              "</expert_handoff>",
            ]
              .filter(Boolean)
              .join("\n"),
            metadata: {
              parentSessionId: ctx.sessionID,
              expertSessionId: expert.id,
              model,
              browserState,
            },
            attachments,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
