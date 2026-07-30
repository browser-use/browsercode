import { afterEach, describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionStore } from "@browser-use/bcode-browser/session-store"
import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import type { SessionPrompt } from "@/session/prompt"
import { MessageID, PartID } from "@/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { AskExpertTool } from "@/tool/ask-expert"
import type { TaskPromptOps } from "@/tool/task"
import { Truncate } from "@/tool/truncate"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const EXPERT_MODEL = "openai/gpt-5.5"
const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const layer = () =>
  Layer.mergeAll(
    Agent.defaultLayer,
    BackgroundJob.defaultLayer,
    EventV2Bridge.defaultLayer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    SessionRunState.defaultLayer,
    SessionStatus.defaultLayer,
    Truncate.defaultLayer,
    Database.defaultLayer,
    RuntimeFlags.layer({}),
  ).pipe(Layer.provide(Ripgrep.defaultLayer))

const it = testEffect(layer())

afterEach(async () => {
  await disposeAllInstances()
})

function stubOps(templates: string[], sessions: Session.Interface): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) =>
      Effect.sync(() => {
        templates.push(template)
        return [{ type: "text" as const, text: template }]
      }),
    prompt: (input) =>
      Effect.gen(function* () {
        const response = reply(input, "status: resolved\nchanged: fixed the immediate issue")
        yield* sessions.updateMessage(response.info)
        yield* Effect.forEach(response.parts, (part) => sessions.updatePart(part), { discard: true })
        return response
      }),
  }
}

function reply(input: SessionPrompt.PromptInput, text: string): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "build",
      agent: input.agent ?? "build",
      cost: 2.5,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 100, output: 20, reasoning: 3, cache: { read: 75, write: 4 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text,
      },
    ],
  }
}

describe("tool.ask_expert", () => {
  it.instance("creates one compact native child and resumes it on later calls", () =>
    Effect.gen(function* () {
      process.env.BROWSER_EXPERT_MODEL = EXPERT_MODEL
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Parent" })
      const user = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: chat.id,
        agent: "build",
        model: ref,
        time: { created: Date.now() },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: user.id,
        sessionID: chat.id,
        type: "text",
        text: "Collect all matching records and save them.",
      })
      const assistant: SessionV1.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: user.id,
        sessionID: chat.id,
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        time: { created: Date.now() },
      }
      yield* sessions.updateMessage(assistant)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistant.id,
        sessionID: chat.id,
        type: "text",
        text: "I found the table but pagination is unclear.",
      })

      const templates: string[] = []
      const tool = yield* AskExpertTool
      const def = yield* tool.init()
      const context = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps: stubOps(templates, sessions) },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      const first = yield* def.execute({ request: "Determine whether every page was collected." }, context)
      const second = yield* def.execute({ request: "Verify the repaired artifact." }, context)
      const children = yield* sessions.children(chat.id)
      const child = children[0]

      expect(children).toHaveLength(1)
      if (!child) throw new Error("Expected an expert child session")
      expect(child.parentID).toBe(chat.id)
      expect(child.metadata?.browserExpert).toBe(true)
      expect(child.model).toEqual({
        providerID: ProviderV2.ID.make("openai"),
        id: ModelV2.ID.make("gpt-5.5"),
      })
      expect(first.metadata.expertSessionId).toBe(child.id)
      expect(first.metadata.reused).toBe(false)
      expect(first.metadata.expertUsage).toEqual({
        costUsd: 2.5,
        modelCalls: 1,
        totalTokens: 123,
        inputTokens: 100,
        outputTokens: 20,
        reasoningTokens: 3,
        cacheReadTokens: 75,
        cacheWriteTokens: 4,
      })
      expect(second.metadata.expertSessionId).toBe(child.id)
      expect(second.metadata.reused).toBe(true)
      expect(second.metadata.expertUsage).toEqual(first.metadata.expertUsage)
      expect(SessionStore.get(chat.id)).toBe(SessionStore.get(child.id))
      expect(templates[0]).toContain("<original_requirements>")
      expect(templates[0]).toContain("Collect all matching records and save them.")
      expect(templates[0]).toContain("<current_parent_draft>")
      expect(templates[0]).toContain("full parent transcript was intentionally not copied")
      expect(templates[1]).toContain("<state_delta>")
      expect(templates[1]).not.toContain("<original_requirements>")
      expect(second.output).toContain(`session_id="${child.id}"`)
      expect(second.output).toContain('reused="true"')

      SessionStore.forget(child.id)
      SessionStore.forget(chat.id)
    }),
  )
})
