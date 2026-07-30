import { afterEach, describe, expect, test } from "bun:test"
import { trace } from "@opentelemetry/api"
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base"
import { startTurnSpan } from "../src/span"
import { parentSessionID, sessionCurrentTurnSpan, subagentSessionIds } from "../src/state"

trace.setGlobalTracerProvider(new BasicTracerProvider())

afterEach(() => {
  for (const key of Object.keys(sessionCurrentTurnSpan)) delete sessionCurrentTurnSpan[key]
  for (const key of Object.keys(subagentSessionIds)) delete subagentSessionIds[key]
})

describe("subagent tracing state", () => {
  test("resolves a child's parent session", () => {
    subagentSessionIds.parent = new Set(["child"])

    expect(parentSessionID("child")).toBe("parent")
    expect(parentSessionID("other")).toBeUndefined()
  })

  test("starts a subagent span in its parent's trace", () => {
    const parent = startTurnSpan({ name: "turn", sessionId: "parent" })
    const child = startTurnSpan({ name: "subagent", sessionId: "child", parentSpan: parent })

    expect(child.spanContext().traceId).toBe(parent.spanContext().traceId)

    child.end()
    parent.end()
  })
})
