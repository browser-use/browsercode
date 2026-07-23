// `session.connect()` env-var precedence.
//
// `BU_CDP_WS` (and `BU_CDP_URL`) hand the agent a preconfigured browser:
// when set, no-args connect skips OS scan and connects there directly.
// Used by eval harnesses and CI to ensure the agent always lands on the
// browser they provisioned, regardless of which local Chromes are running.

import { afterAll, expect, test } from "bun:test"
import { Session } from "../src/cdp/session"

// Tiny WS echo server. Accept the upgrade so `connect()` resolves; the
// CDP protocol itself is never exercised in this test.
let versionRequests = 0
let versionFailuresRemaining = 0
let versionStatus = 200
let versionDelayMs = 0
let websocketDelayMs = 0
let wsUrl = ""
const server = Bun.serve({
  port: 0,
  async fetch(req, srv) {
    const path = new URL(req.url).pathname
    if (path === "/json/version") {
      versionRequests++
      if (versionDelayMs > 0) await Bun.sleep(versionDelayMs)
      if (versionFailuresRemaining > 0) {
        versionFailuresRemaining--
        return new Response("starting", { status: 503 })
      }
      if (versionStatus !== 200) return new Response("blocked", { status: versionStatus })
      return Response.json({ webSocketDebuggerUrl: wsUrl })
    }
    if (path === "/devtools/browser/test") {
      if (websocketDelayMs > 0) await Bun.sleep(websocketDelayMs)
      if (srv.upgrade(req)) return undefined
    }
    return new Response("nope", { status: 400 })
  },
  websocket: {
    open() {},
    message() {},
    close() {},
  },
})

afterAll(() => server.stop(true))

wsUrl = `ws://127.0.0.1:${server.port}/devtools/browser/test`

const withEnv = async <T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> => {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(vars)) {
    prev[k] = process.env[k]
    if (vars[k] === undefined) delete process.env[k]
    else process.env[k] = vars[k]
  }
  try {
    return await fn()
  } finally {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
  }
}

test("connect() with no args connects to BU_CDP_WS when set", async () => {
  await withEnv({ BU_CDP_WS: wsUrl, BU_CDP_URL: undefined }, async () => {
    const session = new Session()
    try {
      await session.connect()
      expect(session.isConnected()).toBe(true)
    } finally {
      session.close()
    }
  })
})

test("BU_CDP_URL still accepts a WebSocket URL for compatibility", async () => {
  await withEnv({ BU_CDP_WS: undefined, BU_CDP_URL: wsUrl }, async () => {
    const session = new Session()
    try {
      await session.connect()
      expect(session.isConnected()).toBe(true)
    } finally {
      session.close()
    }
  })
})

test("BU_CDP_URL resolves an HTTP DevTools endpoint through /json/version", async () => {
  versionRequests = 0
  await withEnv({
    BU_CDP_WS: undefined,
    BU_CDP_URL: `http://127.0.0.1:${server.port}`,
  }, async () => {
    const session = new Session()
    try {
      await session.connect()
      expect(session.isConnected()).toBe(true)
      expect(versionRequests).toBe(1)
    } finally {
      session.close()
    }
  })
})

test("BU_CDP_URL recognizes an uppercase HTTP scheme", async () => {
  versionRequests = 0
  await withEnv({
    BU_CDP_WS: undefined,
    BU_CDP_URL: `HTTP://127.0.0.1:${server.port}`,
  }, async () => {
    const session = new Session()
    try {
      await session.connect()
      expect(session.isConnected()).toBe(true)
      expect(versionRequests).toBe(1)
    } finally {
      session.close()
    }
  })
})

test("BU_CDP_URL retries while a DevTools HTTP endpoint starts", async () => {
  versionRequests = 0
  versionFailuresRemaining = 2
  await withEnv({
    BU_CDP_WS: undefined,
    BU_CDP_URL: `http://127.0.0.1:${server.port}`,
  }, async () => {
    const session = new Session()
    try {
      await session.connect({ timeoutMs: 1_000 })
      expect(session.isConnected()).toBe(true)
      expect(versionRequests).toBe(3)
    } finally {
      versionFailuresRemaining = 0
      session.close()
    }
  })
})

test("BU_CDP_URL discovery and WebSocket opening share one timeout", async () => {
  versionDelayMs = 130
  websocketDelayMs = 130
  await withEnv({
    BU_CDP_WS: undefined,
    BU_CDP_URL: `http://127.0.0.1:${server.port}`,
  }, async () => {
    const session = new Session()
    const started = performance.now()
    try {
      await expect(session.connect({ timeoutMs: 200 })).rejects.toThrow("timed out")
      expect(performance.now() - started).toBeLessThan(270)
    } finally {
      versionDelayMs = 0
      websocketDelayMs = 0
      session.close()
    }
  })
})

test("BU_CDP_URL reports an HTTP permission block immediately", async () => {
  versionRequests = 0
  versionStatus = 403
  await withEnv({
    BU_CDP_WS: undefined,
    BU_CDP_URL: `http://127.0.0.1:${server.port}`,
  }, async () => {
    const session = new Session()
    try {
      await expect(session.connect({ timeoutMs: 1_000 })).rejects.toThrow("permission-blocked")
      expect(versionRequests).toBe(1)
    } finally {
      versionStatus = 200
      session.close()
    }
  })
})

test("explicit { wsUrl } overrides env vars", async () => {
  // Env points at an unreachable port; explicit opts point at the live server.
  // If env-var were consulted first, the test would fail with a timeout.
  await withEnv({ BU_CDP_WS: "ws://127.0.0.1:1/", BU_CDP_URL: undefined }, async () => {
    const session = new Session()
    try {
      await session.connect({ wsUrl, timeoutMs: 2_000 })
      expect(session.isConnected()).toBe(true)
    } finally {
      session.close()
    }
  })
})

test("BU_CDP_WS pointing at a dead port surfaces the error (no fallback to OS scan)", async () => {
  await withEnv({ BU_CDP_WS: "ws://127.0.0.1:1/", BU_CDP_URL: undefined }, async () => {
    const session = new Session()
    let threw = false
    try {
      await session.connect({ timeoutMs: 1_000 })
    } catch {
      threw = true
    } finally {
      session.close()
    }
    expect(threw).toBe(true)
  })
})
