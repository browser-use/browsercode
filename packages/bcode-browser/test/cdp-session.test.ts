// waitFor semantics against a bare WebSocket server (no Chrome needed).
// Test structure adapted from PR #111 by @MagMueller.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { Session, withSessionExecution } from "../src/cdp/session"

const channel = "cdp-events"
const server = Bun.serve({
  port: 0,
  fetch(req, srv) {
    return srv.upgrade(req) ? undefined : new Response("nope", { status: 400 })
  },
  websocket: {
    open(ws) {
      ws.subscribe(channel)
    },
    message(ws, message) {
      const request = JSON.parse(String(message)) as { id?: number; method?: string }
      if (request.method === "Test.pending") return
      if (typeof request.id === "number") ws.send(JSON.stringify({ id: request.id, result: {} }))
    },
  },
})
const session = new Session()
const emit = (method: string, params: unknown) => {
  server.publish(channel, JSON.stringify({ method, params }))
}

beforeAll(async () => {
  await session.connect({ wsUrl: `ws://127.0.0.1:${server.port}/` })
})

afterAll(() => {
  session.close()
  server.stop(true)
})

test("waitFor resolves on a matching event, respecting the predicate", async () => {
  const waiting = session.waitFor<{ ready: boolean }>("Test.event", {
    predicate: (params) => params.ready,
    timeoutMs: 1_000,
  })
  emit("Test.event", { ready: false })
  emit("Test.event", { ready: true })
  expect(await waiting).toEqual({ ready: true })
})

test("waitFor honors timeoutMs", async () => {
  await expect(session.waitFor("Test.timeout", { timeoutMs: 20 })).rejects.toThrow("Timeout waiting for Test.timeout")
})

test("waitFor rejects and unsubscribes when a predicate throws", async () => {
  let calls = 0
  const waiting = session.waitFor("Test.bad", {
    predicate: () => {
      calls++
      throw new Error("predicate failed")
    },
    timeoutMs: 1_000,
  })
  emit("Test.bad", {})
  await expect(waiting).rejects.toThrow("predicate failed")
  emit("Test.bad", {})
  await Bun.sleep(10)
  expect(calls).toBe(1)
})

test("waitFor throws synchronously on the removed positional-predicate form", () => {
  // @ts-expect-error old signature: waitFor(method, predicate, timeoutMs)
  expect(() => session.waitFor("Test.positional", () => true, 1_000)).toThrow(TypeError)
})

test("waitFor throws on a positional timeout rather than silently using the 30s default", async () => {
  // The whole point of this change is removing a silent 30s stall, so the one
  // remaining positional shape — an omitted predicate with a third-argument
  // timeout — must not quietly fall back to the default.
  // @ts-expect-error old signature: waitFor(method, undefined, timeoutMs)
  expect(() => session.waitFor("Test.positionalTimeout", undefined, 50)).toThrow(TypeError)

  // And the supported form still honours the timeout it was given.
  const started = Date.now()
  await expect(session.waitFor("Test.never", { timeoutMs: 50 })).rejects.toThrow(/Timeout waiting for/)
  expect(Date.now() - started).toBeLessThan(1_000)
})

test("inactive executions cannot start a waiter", () => {
  expect(() =>
    withSessionExecution({ active: false }, () => session.waitFor("Test.late", { timeoutMs: 10 })),
  ).toThrow("browser_execute call already timed out")
})

test("event callbacks retain the execution scope that registered them", async () => {
  const execution = { active: true }
  let callbackError = "callback did not run"
  const unsubscribe = withSessionExecution(execution, () =>
    session.onEvent((method) => {
      if (method !== "Test.late") return
      try {
        session.setActiveSession("late-session")
        callbackError = "late command succeeded"
      } catch (error) {
        callbackError = error instanceof Error ? error.message : String(error)
      }
    }),
  )

  execution.active = false
  emit("Test.late", {})
  await Bun.sleep(10)
  unsubscribe()

  expect(callbackError).toBe("browser_execute call already timed out")
  expect(session.getActiveSession()).not.toBe("late-session")
})

test("call-result callbacks retain the execution scope that registered them", async () => {
  const execution = { active: true }
  let callbackError = "callback did not run"
  const registered = withSessionExecution(execution, () => ({
    unsubscribe: session.onCallResult(() => {
      try {
        session.setActiveSession("late-result-session")
        callbackError = "late command succeeded"
      } catch (error) {
        callbackError = error instanceof Error ? error.message : String(error)
      }
    }),
    result: session._call("Test.call", {}),
  }))

  execution.active = false
  await registered.result
  registered.unsubscribe()

  expect(callbackError).toBe("browser_execute call already timed out")
  expect(session.getActiveSession()).not.toBe("late-result-session")
})

// Retirement guarantee under in-flight connects: an invalidation landing
// while connect() is between awaits must not leave a usable or open socket.
test("invalidate before the socket exists rejects the in-flight connect", async () => {
  const s = new Session()
  // connect() awaits resolveWsUrl before openWs, so invalidate() runs while
  // no socket exists yet — openWs must refuse to create one afterwards.
  const connecting = s.connect({ wsUrl: `ws://127.0.0.1:${server.port}/`, timeoutMs: 1_000 })
  s.invalidate(new Error("retired by test"))
  await expect(connecting).rejects.toThrow("retired by test")
  expect(s.isConnected()).toBe(false)
})

test("invalidate while the socket is connecting closes it and rejects", async () => {
  const s = new Session()
  const connecting = s.connect({ wsUrl: `ws://127.0.0.1:${server.port}/`, timeoutMs: 1_000 })
  // Yield one macrotask so openWs has created the WebSocket, then retire.
  await Bun.sleep(0)
  s.invalidate(new Error("retired by test"))
  // Depending on whether the open event won the race, connect either rejects
  // or resolved just before retirement — in both cases the Session must end
  // dead with no usable transport.
  await connecting.catch(() => {})
  expect(s.isConnected()).toBe(false)
  await expect(s._call("Runtime.evaluate", { expression: "1" })).rejects.toThrow("retired by test")
  await expect(s.connect({ wsUrl: `ws://127.0.0.1:${server.port}/` })).rejects.toThrow("retired by test")
})

test("invalidate rejects in-flight CDP calls", async () => {
  const s = new Session()
  await s.connect({ wsUrl: `ws://127.0.0.1:${server.port}/` })
  const pending = s._call("Test.pending", {})

  s.invalidate(new Error("retired with a pending call"))

  await expect(pending).rejects.toThrow("retired with a pending call")
})
