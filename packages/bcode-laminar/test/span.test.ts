import { afterEach, expect, test } from "bun:test"

import { serializeSpawningToolSpanContext } from "../src/span"
import { spawningToolSpanContexts } from "../src/state"

afterEach(() => {
  for (const toolCallId of Object.keys(spawningToolSpanContexts)) {
    delete spawningToolSpanContexts[toolCallId]
  }
})

test("prefers the live spawning tool context over the enclosing turn", () => {
  const context = JSON.stringify({
    traceId: "00000000-0000-0000-0000-000000000001",
    spanId: "00000000-0000-0000-0000-000000000002",
    isRemote: false,
    spanPath: ["evaluation.task", "harness.execute", "turn", "browser_delegate"],
    spanIdsPath: ["00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002"],
  })
  spawningToolSpanContexts.call_delegate = context

  expect(serializeSpawningToolSpanContext("call_delegate", "session")).toBe(context)
})
