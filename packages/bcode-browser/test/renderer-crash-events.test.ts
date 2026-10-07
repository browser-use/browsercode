import { expect, test } from "bun:test"
import { Session } from "../src/cdp/session"

test("crash is attachment-scoped, does not replay, and resets on reconnect", async () => {
  const requests: { id: number; method: string; sessionId?: string }[] = []
  let emit = (_event: object) => {}
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => srv.upgrade(req) ? undefined : new Response(null, { status: 400 }),
    websocket: {
      open(ws) { emit = event => { ws.send(JSON.stringify(event)) } },
      message(ws, raw) {
        const request = JSON.parse(String(raw))
        requests.push(request)
        if (request.method === "Runtime.evaluate") return
        ws.send(JSON.stringify({ id: request.id, result: {} }))
      },
    },
  })
  const session = new Session()
  try {
    await session.connect({ wsUrl: `ws://127.0.0.1:${server.port}` })
    session.setActiveSession("dead")
    const dead = session._call("Runtime.evaluate").catch(error => error)
    const waiting = session.waitFor("Page.loadEventFired", { timeoutMs: 1000 }).catch(error => error)
    session.setActiveSession("healthy")
    const healthy = session._call("Runtime.evaluate")
    await Bun.sleep(10)
    emit({ method: "Inspector.targetCrashed", sessionId: "dead", params: {} })
    expect(await dead).toMatchObject({ name: "RendererCrashedError" })
    expect(await waiting).toMatchObject({ name: "RendererCrashedError" })
    const request = requests.find(x => x.sessionId === "healthy")!
    emit({ id: request.id, result: { healthy: true } })
    expect(await healthy).toEqual({ healthy: true })
    session.setActiveSession("dead")
    await expect(session._call("Runtime.evaluate")).rejects.toThrow("Renderer crashed")
    await expect(session.waitFor("Page.loadEventFired")).rejects.toThrow("Renderer crashed")
    await session._call("Target.getTargets")
    expect(requests.filter(x => x.method === "Runtime.evaluate")).toHaveLength(2)
    const reload = session.waitFor("Inspector.targetReloadedAfterCrash").catch(error => error)
    // Already-crashed waits reject; the event still clears the attachment's failure.
    expect(await reload).toMatchObject({ name: "RendererCrashedError" })
    emit({ method: "Inspector.targetReloadedAfterCrash", sessionId: "dead", params: {} })
    await Bun.sleep(10)
    await session._call("Page.enable")
    emit({ method: "Inspector.targetCrashed", sessionId: "dead", params: {} })
    await Bun.sleep(10)
    await session.connect({ wsUrl: `ws://127.0.0.1:${server.port}` })
    session.setActiveSession("dead")
    await session._call("Page.enable")
  } finally {
    session.close()
    server.stop(true)
  }
})
