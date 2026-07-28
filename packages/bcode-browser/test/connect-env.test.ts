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
const server = Bun.serve({
  port: 0,
  fetch(req, srv) {
    if (srv.upgrade(req)) return
    return new Response("nope", { status: 400 })
  },
  websocket: {
    open() {},
    message() {},
    close() {},
  },
})

afterAll(() => server.stop(true))

const wsUrl = `ws://127.0.0.1:${server.port}/`

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

test("connect() falls back to BU_CDP_URL when BU_CDP_WS is unset", async () => {
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

test("setActiveSession tracks the selected target for delegation handoff", () => {
  const session = new Session()
  session.setActiveSession("session-id", "target-id")
  expect(session.getActiveSession()).toBe("session-id")
  expect(session.getActiveTarget()).toBe("target-id")

  session.setActiveSession(undefined)
  expect(session.getActiveTarget()).toBeUndefined()
})
