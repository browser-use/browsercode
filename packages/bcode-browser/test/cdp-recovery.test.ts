import { expect, test } from "bun:test"
import { Session } from "../src/cdp/session"

const wsUrl = (server: { port?: number }) => {
  if (server.port === undefined) throw new Error("test server has no port")
  return `ws://127.0.0.1:${server.port}/`
}

test("a missing page session is reattached once and the rejected command is retried", async () => {
  let attachCount = 0
  let getTargetsCount = 0
  let staleCommandCount = 0
  const commandSessions: string[] = []
  const attachedTargets: string[] = []
  const enabledDomains: string[] = []
  const server = Bun.serve({
    port: 0,
    fetch(req, bunServer) {
      return bunServer.upgrade(req) ? undefined : new Response("nope", { status: 400 })
    },
    websocket: {
      message(socket, raw) {
        const message = JSON.parse(String(raw))
        if (message.method === "Target.attachToTarget") {
          attachCount++
          attachedTargets.push(message.params.targetId)
          socket.send(JSON.stringify({ id: message.id, result: { sessionId: `session-${attachCount}` } }))
          return
        }
        if (message.method === "Target.getTargets") {
          getTargetsCount++
          setTimeout(() => {
            socket.send(JSON.stringify({
              id: message.id,
              result: {
                targetInfos: [
                  { targetId: "other-page", title: "Other", type: "page", url: "https://other.example" },
                  { targetId: "page-1", title: "Page", type: "page", url: "https://example.com" },
                ],
              },
            }))
          }, 10)
          return
        }
        if (message.method === "Debugger.enable") {
          enabledDomains.push(message.method)
          socket.send(JSON.stringify({ id: message.id, result: {} }))
          return
        }
        if (message.method === "Runtime.evaluate") {
          commandSessions.push(message.sessionId)
          if (message.sessionId === "session-1") {
            staleCommandCount++
            const rejectMissingSession = () => {
              socket.send(JSON.stringify({
                id: message.id,
                error: { code: -32001, message: "Session with given id not found." },
              }))
            }
            if (staleCommandCount === 3) setTimeout(rejectMissingSession, 30)
            else rejectMissingSession()
          } else {
            socket.send(JSON.stringify({
              id: message.id,
              result: { result: { type: "number", value: message.params.expression } },
            }))
          }
        }
      },
      close() {},
    },
  })
  const session = new Session()

  try {
    await session.connect({ wsUrl: wsUrl(server) })
    await session.use("page-1")
    await session.domains.Debugger.enable({})
    const [first, second, third] = await Promise.all([
      session.domains.Runtime.evaluate({ expression: "1" }),
      session.domains.Runtime.evaluate({ expression: "2" }),
      session.domains.Runtime.evaluate({ expression: "3" }),
    ])

    expect(first.result.value).toBe("1")
    expect(second.result.value).toBe("2")
    expect(third.result.value).toBe("3")
    expect(attachCount).toBe(2)
    expect(attachedTargets).toEqual(["page-1", "page-1"])
    expect(getTargetsCount).toBe(1)
    expect(enabledDomains).toEqual(["Debugger.enable", "Debugger.enable"])
    expect(commandSessions).toEqual([
      "session-1",
      "session-1",
      "session-1",
      "session-2",
      "session-2",
      "session-2",
    ])
  } finally {
    session.close()
    server.stop(true)
  }
})

test("calls started during reattachment join the same recovery", async () => {
  let attachCount = 0
  let markReattachStarted: (() => void) | undefined
  const reattachStarted = new Promise<void>((resolve) => {
    markReattachStarted = resolve
  })
  const commandSessions: string[] = []
  const server = Bun.serve({
    port: 0,
    fetch(req, bunServer) {
      return bunServer.upgrade(req) ? undefined : new Response("nope", { status: 400 })
    },
    websocket: {
      message(socket, raw) {
        const message = JSON.parse(String(raw))
        if (message.method === "Target.attachToTarget") {
          attachCount++
          socket.send(JSON.stringify({ id: message.id, result: { sessionId: `session-${attachCount}` } }))
          return
        }
        if (message.method === "Target.getTargets") {
          markReattachStarted?.()
          setTimeout(() => {
            socket.send(JSON.stringify({
              id: message.id,
              result: {
                targetInfos: [{ targetId: "page-1", title: "Page", type: "page", url: "https://example.com" }],
              },
            }))
          }, 20)
          return
        }
        if (message.method !== "Runtime.evaluate") return
        commandSessions.push(message.sessionId)
        if (message.sessionId === "session-1") {
          socket.send(JSON.stringify({
            id: message.id,
            error: { code: -32001, message: "Session with given id not found." },
          }))
          return
        }
        socket.send(JSON.stringify({
          id: message.id,
          result: { result: { type: "string", value: message.params.expression } },
        }))
      },
      close() {},
    },
  })
  const session = new Session()

  try {
    await session.connect({ wsUrl: wsUrl(server) })
    await session.use("page-1")
    const first = session.domains.Runtime.evaluate({ expression: "first" })
    await reattachStarted
    const second = session.domains.Runtime.evaluate({ expression: "second" })

    expect((await first).result.value).toBe("first")
    expect((await second).result.value).toBe("second")
    expect(attachCount).toBe(2)
    expect(commandSessions).toEqual(["session-1", "session-1", "session-2", "session-2"])
  } finally {
    session.close()
    server.stop(true)
  }
})

test("reattach reuses an existing about:blank target", async () => {
  let attachCount = 0
  let createCount = 0
  const attachedTargets: string[] = []
  const server = Bun.serve({
    port: 0,
    fetch(req, bunServer) {
      return bunServer.upgrade(req) ? undefined : new Response("nope", { status: 400 })
    },
    websocket: {
      message(socket, raw) {
        const message = JSON.parse(String(raw))
        if (message.method === "Target.attachToTarget") {
          attachCount++
          attachedTargets.push(message.params.targetId)
          socket.send(JSON.stringify({ id: message.id, result: { sessionId: `session-${attachCount}` } }))
          return
        }
        if (message.method === "Target.getTargets") {
          socket.send(JSON.stringify({
            id: message.id,
            result: {
              targetInfos: [{ targetId: "blank-page", title: "", type: "page", url: "about:blank" }],
            },
          }))
          return
        }
        if (message.method === "Target.createTarget") {
          createCount++
          socket.send(JSON.stringify({ id: message.id, result: { targetId: "unexpected-page" } }))
          return
        }
        if (message.method !== "Runtime.evaluate") return
        if (message.sessionId === "session-1") {
          socket.send(JSON.stringify({
            id: message.id,
            error: { code: -32001, message: "Session with given id not found." },
          }))
          return
        }
        socket.send(JSON.stringify({
          id: message.id,
          result: { result: { type: "boolean", value: true } },
        }))
      },
      close() {},
    },
  })
  const session = new Session()

  try {
    await session.connect({ wsUrl: wsUrl(server) })
    await session.use("blank-page")
    const result = await session.domains.Runtime.evaluate({ expression: "true" })

    expect(result.result.value).toBe(true)
    expect(createCount).toBe(0)
    expect(attachedTargets).toEqual(["blank-page", "blank-page"])
  } finally {
    session.close()
    server.stop(true)
  }
})

test("a missing original target is reported without replaying on another page", async () => {
  let attachCount = 0
  let createCount = 0
  let commandCount = 0
  const attachedTargets: string[] = []
  const server = Bun.serve({
    port: 0,
    fetch(req, bunServer) {
      return bunServer.upgrade(req) ? undefined : new Response("nope", { status: 400 })
    },
    websocket: {
      message(socket, raw) {
        const message = JSON.parse(String(raw))
        if (message.method === "Target.attachToTarget") {
          attachCount++
          attachedTargets.push(message.params.targetId)
          socket.send(JSON.stringify({ id: message.id, result: { sessionId: `session-${attachCount}` } }))
          return
        }
        if (message.method === "Target.getTargets") {
          socket.send(JSON.stringify({
            id: message.id,
            result: {
              targetInfos: [
                { targetId: "other-page", title: "Other", type: "page", url: "https://other.example" },
                { targetId: "settings", title: "Settings", type: "page", url: "chrome://settings" },
              ],
            },
          }))
          return
        }
        if (message.method === "Target.createTarget") {
          createCount++
          socket.send(JSON.stringify({ id: message.id, result: { targetId: "unexpected-page" } }))
          return
        }
        if (["Page.enable", "DOM.enable", "Runtime.enable", "Network.enable"].includes(message.method)) {
          socket.send(JSON.stringify({ id: message.id, result: {} }))
          return
        }
        if (message.method === "Runtime.evaluate") {
          commandCount++
          if (message.sessionId === "session-1") {
            socket.send(JSON.stringify({
              id: message.id,
              error: { code: -32001, message: "Session with given id not found." },
            }))
          } else {
            socket.send(JSON.stringify({ id: message.id, result: { result: { type: "boolean", value: true } } }))
          }
        }
      },
      close() {},
    },
  })
  const session = new Session()

  try {
    await session.connect({ wsUrl: wsUrl(server) })
    await session.use("old-page")
    await expect(session.domains.Runtime.evaluate({ expression: "submit()" }))
      .rejects.toThrow("CDP target old-page was closed")

    expect(commandCount).toBe(1)
    expect(createCount).toBe(0)
    expect(attachCount).toBe(1)
    expect(attachedTargets).toEqual(["old-page"])
  } finally {
    session.close()
    server.stop(true)
  }
})

test("no-argument connect preserves a healthy socket and active target", async () => {
  let connectionCount = 0
  const commandSessions: string[] = []
  const server = Bun.serve({
    port: 0,
    fetch(req, bunServer) {
      if (!bunServer.upgrade(req)) return new Response("nope", { status: 400 })
      connectionCount++
      return undefined
    },
    websocket: {
      message(socket, raw) {
        const message = JSON.parse(String(raw))
        if (message.method === "Target.attachToTarget") {
          socket.send(JSON.stringify({ id: message.id, result: { sessionId: "session-1" } }))
          return
        }
        if (message.method !== "Runtime.evaluate") return
        commandSessions.push(message.sessionId)
        socket.send(JSON.stringify({
          id: message.id,
          result: { result: { type: "boolean", value: true } },
        }))
      },
      close() {},
    },
  })
  const session = new Session()

  try {
    await session.connect({ wsUrl: wsUrl(server) })
    await session.use("page-1")
    await session.connect()
    const result = await session.domains.Runtime.evaluate({ expression: "true" })

    expect(result.result.value).toBe(true)
    expect(connectionCount).toBe(1)
    expect(commandSessions).toEqual(["session-1"])
  } finally {
    session.close()
    server.stop(true)
  }
})

test("a socket drop rejects an in-flight command without replaying it", async () => {
  let commandCount = 0
  const server = Bun.serve({
    port: 0,
    fetch(req, bunServer) {
      return bunServer.upgrade(req) ? undefined : new Response("nope", { status: 400 })
    },
    websocket: {
      message(socket, raw) {
        const message = JSON.parse(String(raw))
        if (message.method !== "Input.insertText") return
        commandCount++
        socket.close(1011, "connection dropped")
      },
      close() {},
    },
  })
  const session = new Session()

  try {
    await session.connect({ wsUrl: wsUrl(server) })
    await expect(session.domains.Input.insertText({ text: "only once" })).rejects.toThrow("CDP socket closed")
    expect(commandCount).toBe(1)
  } finally {
    session.close()
    server.stop(true)
  }
})

test("a failed replacement connection leaves the working socket active", async () => {
  const live = Bun.serve({
    port: 0,
    fetch(req, bunServer) {
      return bunServer.upgrade(req) ? undefined : new Response("nope", { status: 400 })
    },
    websocket: {
      message(socket, raw) {
        const message = JSON.parse(String(raw))
        socket.send(JSON.stringify({ id: message.id, result: { targetInfos: [] } }))
      },
      close() {},
    },
  })
  const rejecting = Bun.serve({
    port: 0,
    fetch() {
      return new Response("forbidden", { status: 403 })
    },
  })
  const session = new Session()

  try {
    await session.connect({ wsUrl: wsUrl(live) })
    await expect(session.connect({ wsUrl: wsUrl(rejecting), timeoutMs: 1_000 })).rejects.toThrow()
    expect(session.isConnected()).toBe(true)
    expect((await session.domains.Target.getTargets({})).targetInfos).toEqual([])
  } finally {
    session.close()
    live.stop(true)
    rejecting.stop(true)
  }
})

test("closing a replaced socket cannot reject commands on the new socket", async () => {
  let connectionCount = 0
  const server = Bun.serve<{ connection: number }>({
    port: 0,
    fetch(req, bunServer) {
      const connection = ++connectionCount
      return bunServer.upgrade(req, { data: { connection } })
        ? undefined
        : new Response("nope", { status: 400 })
    },
    websocket: {
      message(socket, raw) {
        const message = JSON.parse(String(raw))
        setTimeout(() => {
          socket.send(JSON.stringify({
            id: message.id,
            result: {
              targetInfos: [{
                targetId: `page-${socket.data.connection}`,
                type: "page",
                title: "Page",
                url: "https://example.com",
                attached: false,
                canAccessOpener: false,
              }],
            },
          }))
        }, 20)
      },
      close() {},
    },
  })
  const session = new Session()

  try {
    await session.connect({ wsUrl: wsUrl(server) })
    await session.connect({ wsUrl: wsUrl(server) })
    const { targetInfos } = await session.domains.Target.getTargets({})

    expect(targetInfos[0]?.targetId).toBe("page-2")
  } finally {
    session.close()
    server.stop(true)
  }
})
