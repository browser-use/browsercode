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
          getTargetsCount++
          setTimeout(() => {
            socket.send(JSON.stringify({
              id: message.id,
              result: {
                targetInfos: [{ targetId: "page-1", title: "Page", type: "page", url: "https://example.com" }],
              },
            }))
          }, 10)
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
    const [first, second, third] = await Promise.all([
      session.domains.Runtime.evaluate({ expression: "1" }),
      session.domains.Runtime.evaluate({ expression: "2" }),
      session.domains.Runtime.evaluate({ expression: "3" }),
    ])

    expect(first.result.value).toBe("1")
    expect(second.result.value).toBe("2")
    expect(third.result.value).toBe("3")
    expect(attachCount).toBe(2)
    expect(getTargetsCount).toBe(1)
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

test("reattach creates a blank page when only internal targets remain", async () => {
  let attachCount = 0
  let createdTarget: unknown
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
          socket.send(JSON.stringify({
            id: message.id,
            result: {
              targetInfos: [{ targetId: "settings", title: "Settings", type: "page", url: "chrome://settings" }],
            },
          }))
          return
        }
        if (message.method === "Target.createTarget") {
          createdTarget = message.params
          socket.send(JSON.stringify({ id: message.id, result: { targetId: "fresh-page" } }))
          return
        }
        if (message.method === "Runtime.evaluate") {
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
    const result = await session.domains.Runtime.evaluate({ expression: "true" })

    expect(result.result.value).toBe(true)
    expect(createdTarget).toEqual({ url: "about:blank" })
    expect(attachCount).toBe(2)
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
