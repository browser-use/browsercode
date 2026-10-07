import { expect, test } from "bun:test"
import { Session } from "../src/cdp/session"

const profileDir = process.env.BCODE_CRASH_PROFILE_DIR

test.skipIf(!profileDir)("renderer crash rejects pending work and permits same-browser recovery", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response("<title>recovery</title>", { headers: { "Content-Type": "text/html" } }) })
  const session = new Session()
  const targets: string[] = []
  const bounded = async <T>(promise: Promise<T>) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("TEST_DEADLINE")), 2000) }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  try {
    await session.connect({ profileDir })
    const page = await session.domains.Target.createTarget({ url: `http://127.0.0.1:${server.port}/` })
    targets.push(page.targetId)
    await session.use(page.targetId)
    await session.domains.Runtime.evaluate({ expression: "document.cookie = 'recovery=preserved; path=/'; localStorage.setItem('saved', 'yes')" })
    const pending = bounded(session.domains.Runtime.evaluate({ expression: "new Promise(() => {})", awaitPromise: true })).catch(error => error)
    const crashed = bounded(session.domains.Page.crash()).catch(error => error)
    expect((await pending).name).toBe("RendererCrashedError")
    expect((await crashed).name).toBe("RendererCrashedError")
    expect(session.isConnected()).toBe(true)
    await expect(bounded(session.use(page.targetId))).rejects.toThrow("Renderer crashed")
    await expect(bounded(session.domains.Runtime.evaluate({ expression: "1" }))).rejects.toThrow("Renderer crashed")
    await session.domains.Target.closeTarget({ targetId: page.targetId })
    const replacement = await session.domains.Target.createTarget({ url: `http://127.0.0.1:${server.port}/` })
    targets.push(replacement.targetId)
    await session.use(replacement.targetId)
    const state = await session.domains.Runtime.evaluate({ expression: "JSON.stringify({cookie: document.cookie, saved: localStorage.getItem('saved')})", returnByValue: true })
    expect(JSON.parse(String(state.result.value))).toEqual({ cookie: "recovery=preserved", saved: "yes" })
    expect((await session.domains.Page.captureScreenshot()).data.length).toBeGreaterThan(0)
  } finally {
    for (const targetId of targets) await session.domains.Target.closeTarget({ targetId }).catch(() => {})
    session.close()
    server.stop(true)
  }
}, 15000)
