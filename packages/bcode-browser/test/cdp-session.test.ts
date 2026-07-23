import { afterAll, beforeAll, expect, test } from "bun:test"
import { Session } from "../src/cdp/session"

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
    message(ws, raw) {
      const message: unknown = JSON.parse(String(raw))
      if (typeof message !== "object" || message === null) return
      const method = Reflect.get(message, "method")
      const id = Reflect.get(message, "id")
      if (method !== "Page.navigate" || typeof id !== "number") return
      const params = Reflect.get(message, "params")
      const url = typeof params === "object" && params !== null ? Reflect.get(params, "url") : undefined
      if (url === "https://navigation-fails.example") {
        ws.send(JSON.stringify({ id, result: { frameId: "frame", errorText: "net::ERR_FAILED" } }))
        return
      }
      ws.send(JSON.stringify({ method: "Page.loadEventFired", params: { timestamp: 1 } }))
      ws.send(JSON.stringify({ id, result: { frameId: "frame" } }))
    },
    close() {},
  },
})
const session = new Session()

beforeAll(async () => {
  await session.connect({ wsUrl: `ws://127.0.0.1:${server.port}/` })
})

afterAll(() => {
  session.close()
  server.stop(true)
})

const emit = (method: string, params: unknown, sessionId?: string) => {
  server.publish(channel, JSON.stringify({ method, params, sessionId }))
}

test("waitFor accepts predicate and timeout options", async () => {
  const waiting = session.waitFor<{ ready: boolean }>("Test.options", {
    predicate: (params) => params.ready,
    timeoutMs: 1_000,
  })
  emit("Test.options", { ready: false })
  emit("Test.options", { ready: true })
  expect(await waiting).toEqual({ ready: true })
})

test("waitFor options timeout is honored", async () => {
  const started = performance.now()
  await expect(session.waitFor("Test.timeout", { timeoutMs: 20 })).rejects.toThrow("Timeout waiting for Test.timeout")
  expect(performance.now() - started).toBeLessThan(500)
})

test("waitFor rejects and unsubscribes when a predicate throws", async () => {
  let calls = 0
  const waiting = session.waitFor("Test.predicate-error", {
    predicate: () => {
      calls++
      throw new Error("predicate failed")
    },
    timeoutMs: 1_000,
  })
  emit("Test.predicate-error", {})
  await expect(waiting).rejects.toThrow("predicate failed")
  emit("Test.predicate-error", {})
  await Bun.sleep(10)
  expect(calls).toBe(1)
})

test("waitFor retains the positional signature", async () => {
  const waiting = session.waitFor<{ ready: boolean }>("Test.positional", (params) => params.ready, 1_000)
  emit("Test.positional", { ready: true })
  expect(await waiting).toEqual({ ready: true })
})

test("a waiter registered before navigation catches an event emitted before the navigation response", async () => {
  const loaded = session.waitFor<{ timestamp: number }>("Page.loadEventFired", { timeoutMs: 1_000 })
  await session.domains.Page.navigate({ url: "https://example.com" })
  expect(await loaded).toEqual({ timestamp: 1 })
})

test("waitFor ignores matching events from another attached session", async () => {
  session.setActiveSession("session-active")
  try {
    const waiting = session.waitFor<{ source: string }>("Page.loadEventFired", { timeoutMs: 1_000 })
    emit("Page.loadEventFired", { source: "background" }, "session-background")
    emit("Page.loadEventFired", { source: "active" }, "session-active")
    expect(await waiting).toEqual({ source: "active" })
  } finally {
    session.setActiveSession(undefined)
  }
})

test("navigation failure does not leave an unhandled waiter rejection", async () => {
  const loaded = session.waitFor("Page.loadEventFired", { timeoutMs: 20 })
  void loaded.catch(() => {})
  const navigation = await session.domains.Page.navigate({ url: "https://navigation-fails.example" })
  expect(navigation.errorText).toBe("net::ERR_FAILED")
  await Bun.sleep(30)
})

test("waitFor rejects invalid runtime arguments immediately", () => {
  expect(() =>
    // @ts-expect-error Runtime callers can still pass invalid JavaScript.
    session.waitFor("Test.invalid-predicate", { predicate: "not a function" }),
  ).toThrow("waitFor options.predicate must be a function")
  expect(() =>
    session.waitFor("Test.invalid-timeout", { timeoutMs: Number.NaN }),
  ).toThrow("waitFor timeoutMs must be a non-negative finite number")
})
