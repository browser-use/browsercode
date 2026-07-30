import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionStore } from "@browser-use/bcode-browser/session-store"
import { Effect, Schema } from "effect"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { MessageID } from "@/session/schema"
import type { TaskPromptOps } from "./task"
import { Tool } from "./tool"
import DESCRIPTION from "./ask-expert.txt"

const EXPERT_CONTEXT_LIMIT = 24_000
const REQUIREMENTS_LIMIT = 12_000
const DRAFT_LIMIT = 5_000
const FAILURE_LIMIT = 3_000
const BROWSER_TEXT_LIMIT = 4_000

type BrowserState = {
  url: string
  title: string
  text: string
}

export const Parameters = Schema.Struct({
  request: Schema.String.annotate({
    description:
      "The immediate obstacle or audit question for the expert. Original requirements and live state are transferred automatically.",
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
          const model = Provider.parseModel(configuredModel)
          const existing = (yield* sessions.children(ctx.sessionID)).find(
            (child) =>
              child.metadata?.browserExpert === true &&
              child.model?.providerID === model.providerID &&
              child.model.id === model.modelID,
          )
          const expert =
            existing ??
            (yield* sessions.create({
              parentID: ctx.sessionID,
              title: `Browser expert (${configuredModel})`,
              agent: "build",
              model: {
                providerID: ProviderV2.ID.make(model.providerID),
                id: ModelV2.ID.make(model.modelID),
              },
              metadata: { browserExpert: true },
              permission: [
                ...(parent.permission ?? []),
                { permission: "ask_expert", pattern: "*", action: "deny" },
                { permission: "task", pattern: "*", action: "deny" },
                { permission: "question", pattern: "*", action: "deny" },
              ],
            }))
          SessionStore.share(ctx.sessionID, expert.id)
          const finalAudit = args.request.startsWith("Finalization gate:")
          const parentMessages = yield* sessions.messages({ sessionID: ctx.sessionID })
          const expertMessagesBefore = yield* sessions.messages({ sessionID: expert.id })
          const browserStateBefore = yield* readBrowserState(ctx.sessionID)

          yield* ctx.metadata({
            title: existing ? "Resume expert" : "Start expert",
            metadata: {
              parentSessionId: ctx.sessionID,
              expertSessionId: expert.id,
              model,
              finalAudit,
              reused: Boolean(existing),
              browserStateBefore,
            },
          })

          const ops = ctx.extra?.promptOps
          if (!isTaskPromptOps(ops))
            return yield* Effect.fail(new Error("AskExpertTool requires promptOps in ctx.extra"))

          const parts = yield* ops.resolvePromptParts(
            [
              existing
                ? "You are resuming your prior work as the expert subagent for this task."
                : "You are the expert subagent for a browser task. A compact handoff follows; the full parent transcript was intentionally not copied.",
              "You share its exact live browser session and workspace. Inspect before acting; do not merely give advice when a direct intervention is needed.",
              "The CDP session is already connected and preserves the parent's active target. Check session.isConnected() and do not reconnect when it is true.",
              finalAudit
                ? "This is the finalization audit. Compare every original requirement with the proposed answer, current browser, and existing artifacts. If they already provide explicit support, return a no_change receipt immediately without using tools, re-browsing, or improving correct work. Use tools only for a concrete gap or contradiction, then repair exactly that issue. For any 'all', exhaustive, or 'up to N' collection, require explicit pagination, scrolling, or API coverage and matching saved row counts; never treat the first visible page as complete."
                : "This is a mid-task handoff. Make the smallest sufficient intervention that unblocks the primary agent, leave the browser in a clear resumable state, and hand back immediately. Do not complete the remaining task, extraction, or artifact even if the request is phrased too broadly.",
              "Do not call ask_expert, task, or question. Stop as soon as the issue is resolved, no change is needed, or you have a concrete external blocker.",
              "Do not emit progress or commentary. Respond once with a compact final handback receipt containing: status (resolved, blocked, or no_change), what you changed, evidence/artifacts, and any remaining issue.",
              "",
              existing
                ? buildStateDelta(parentMessages, ctx.messageID, browserStateBefore)
                : buildBootstrap(parentMessages, ctx.messageID, browserStateBefore),
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
            .pipe(Effect.onInterrupt(() => ops.cancel(expert.id)))
          const receipt = result.parts.findLast((part) => part.type === "text")?.text ?? ""
          const browserStateAfter = yield* readBrowserState(ctx.sessionID)
          const expertUsage = usageDelta(expertMessagesBefore, yield* sessions.messages({ sessionID: expert.id }))
          const browser = SessionStore.get(ctx.sessionID)
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
            title: "Expert intervention complete",
            output: [
              `<expert_handoff session_id="${expert.id}" model="${configuredModel}" reused="${Boolean(existing)}">`,
              receipt || "The expert returned without a textual receipt; inspect its nested trace.",
              browserStateAfter
                ? [
                    "",
                    "<browser_state_after>",
                    `URL: ${browserStateAfter.url}`,
                    `Title: ${browserStateAfter.title}`,
                    browserStateAfter.text,
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
              finalAudit,
              reused: Boolean(existing),
              browserStateBefore,
              browserStateAfter,
              expertUsage,
            },
            attachments,
          }
        }).pipe(Effect.orDie),
    }
  }),
)

function buildBootstrap(
  messages: SessionV1.WithParts[],
  currentMessageID: string,
  browserState: BrowserState | undefined,
) {
  return limit(
    [
      "<original_requirements>",
      limit(
        messages
          .filter((message) => message.info.role === "user")
          .flatMap((message) =>
            message.parts
              .filter((part): part is SessionV1.TextPart => part.type === "text" && !part.synthetic && !part.ignored)
              .map((part) => part.text.trim()),
          )
          .filter(Boolean)
          .join("\n\n"),
        REQUIREMENTS_LIMIT,
      ),
      "</original_requirements>",
      currentDraft(messages, currentMessageID),
      failures(messages),
      browserStateText(browserState),
    ]
      .filter(Boolean)
      .join("\n\n"),
    EXPERT_CONTEXT_LIMIT,
  )
}

function buildStateDelta(
  messages: SessionV1.WithParts[],
  currentMessageID: string,
  browserState: BrowserState | undefined,
) {
  return limit(
    [
      "<state_delta>",
      currentDraft(messages, currentMessageID),
      failures(messages),
      browserStateText(browserState),
      "</state_delta>",
    ]
      .filter(Boolean)
      .join("\n\n"),
    EXPERT_CONTEXT_LIMIT,
  )
}

function currentDraft(messages: SessionV1.WithParts[], currentMessageID: string) {
  const text = messages
    .find((message) => message.info.id === currentMessageID)
    ?.parts.filter((part): part is SessionV1.TextPart => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n")
  if (!text) return ""
  return `<current_parent_draft>\n${limit(text, DRAFT_LIMIT)}\n</current_parent_draft>`
}

function failures(messages: SessionV1.WithParts[]) {
  const text = messages
    .flatMap((message) => message.parts)
    .flatMap((part) =>
      part.type === "tool" && part.state.status === "error" ? [`${part.tool}: ${part.state.error}`] : [],
    )
    .slice(-3)
    .join("\n\n")
  if (!text) return ""
  return `<recent_failures>\n${limit(text, FAILURE_LIMIT)}\n</recent_failures>`
}

function browserStateText(browserState: BrowserState | undefined) {
  if (!browserState) return "<current_browser>Not connected.</current_browser>"
  return [
    "<current_browser>",
    `URL: ${browserState.url}`,
    `Title: ${browserState.title}`,
    limit(browserState.text, BROWSER_TEXT_LIMIT),
    "</current_browser>",
  ].join("\n")
}

function limit(text: string, max: number) {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n[truncated ${text.length - max} characters]`
}

function readBrowserState(sessionID: string) {
  const browser = SessionStore.get(sessionID)
  if (!browser.isConnected()) return Effect.succeed(undefined)
  return Effect.promise(async () => {
    const evaluated = await browser.domains.Runtime.evaluate({
      expression: `({url:location.href,title:document.title,text:(document.body?.innerText||'').slice(0,${BROWSER_TEXT_LIMIT})})`,
      returnByValue: true,
    })
    const value = evaluated.result.value
    if (!value || typeof value !== "object") return undefined
    return {
      url: "url" in value && typeof value.url === "string" ? value.url : "",
      title: "title" in value && typeof value.title === "string" ? value.title : "",
      text: "text" in value && typeof value.text === "string" ? value.text : "",
    }
  }).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
}

function isTaskPromptOps(value: unknown): value is TaskPromptOps {
  if (!value || typeof value !== "object") return false
  return (
    "cancel" in value &&
    typeof value.cancel === "function" &&
    "resolvePromptParts" in value &&
    typeof value.resolvePromptParts === "function" &&
    "prompt" in value &&
    typeof value.prompt === "function"
  )
}

function usageDelta(before: SessionV1.WithParts[], after: SessionV1.WithParts[]) {
  const total = (messages: SessionV1.WithParts[]) =>
    messages
      .filter(
        (message): message is SessionV1.WithParts & { info: SessionV1.Assistant } => message.info.role === "assistant",
      )
      .reduce(
        (sum, message) => ({
          costUsd: sum.costUsd + message.info.cost,
          modelCalls: sum.modelCalls + 1,
          totalTokens:
            sum.totalTokens + message.info.tokens.input + message.info.tokens.output + message.info.tokens.reasoning,
          inputTokens: sum.inputTokens + message.info.tokens.input,
          outputTokens: sum.outputTokens + message.info.tokens.output,
          reasoningTokens: sum.reasoningTokens + message.info.tokens.reasoning,
          cacheReadTokens: sum.cacheReadTokens + message.info.tokens.cache.read,
          cacheWriteTokens: sum.cacheWriteTokens + message.info.tokens.cache.write,
        }),
        {
          costUsd: 0,
          modelCalls: 0,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      )
  const previous = total(before)
  const current = total(after)
  return {
    costUsd: current.costUsd - previous.costUsd,
    modelCalls: current.modelCalls - previous.modelCalls,
    totalTokens: current.totalTokens - previous.totalTokens,
    inputTokens: current.inputTokens - previous.inputTokens,
    outputTokens: current.outputTokens - previous.outputTokens,
    reasoningTokens: current.reasoningTokens - previous.reasoningTokens,
    cacheReadTokens: current.cacheReadTokens - previous.cacheReadTokens,
    cacheWriteTokens: current.cacheWriteTokens - previous.cacheWriteTokens,
  }
}
