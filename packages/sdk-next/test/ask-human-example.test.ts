import { expect, test } from "bun:test"
import { Agent, Session, SessionMessage } from "@opencode-ai/sdk-next"
import { Tool } from "@opencode-ai/core/tool/tool"
import { Effect } from "effect"
import { makeAskHuman } from "../examples/ask-human"

test("ask_human returns the host application's answer", async () => {
  const asked: string[] = []
  const tool = makeAskHuman(async (question) => {
    asked.push(question)
    return "Use the existing account"
  })

  const result = await Effect.runPromise(
    Tool.settle(
      tool,
      {
        type: "tool-call",
        id: "call-ask-human",
        name: "ask_human",
        input: { question: "Which account should I use?" },
      },
      {
        sessionID: Session.ID.make("ses_ask_human"),
        agent: Agent.ID.make("build"),
        assistantMessageID: SessionMessage.ID.make("msg_ask_human"),
        toolCallID: "call-ask-human",
      },
    ),
  )

  expect(asked).toEqual(["Which account should I use?"])
  expect(result.structured).toEqual({ answer: "Use the existing account" })
})
