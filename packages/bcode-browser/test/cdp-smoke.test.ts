// CDP layer smoke test against a real Chrome instance. Skipped unless
// `BCODE_SMOKE_CHROME=1` and a running Chrome with `--remote-debugging-port`
// is reachable via the supplied profile dir.
//
// The point is to verify the vendored CDP stack (session.ts + generated.ts)
// drives a real browser end-to-end after the port: connect via profileDir,
// navigate, query document.title, close.

import { expect, test } from "bun:test"
import { Session } from "../src/cdp/session"

const profileDir = process.env.BCODE_SMOKE_PROFILE_DIR
const enabled = process.env.BCODE_SMOKE_CHROME === "1" && profileDir

test.skipIf(!enabled)("Session connects, navigates, reads title", async () => {
  const session = new Session()
  try {
    await session.connect({ profileDir: profileDir!, timeoutMs: 5000 })
    expect(session.isConnected()).toBe(true)

    // Pick an existing page target (chrome:// internals filtered out).
    const targets = (await session.domains.Target.getTargets({})).targetInfos
    const page = (targets as Array<{ targetId: string; type: string; url: string }>).find(
      (t) => t.type === "page" && !t.url.startsWith("chrome://") && !t.url.startsWith("devtools://"),
    ) ?? (targets as Array<{ targetId: string; type: string; url: string }>).find((t) => t.type === "page")
    if (!page) {
      // Open a fresh page if nothing exists.
      const created = await session.domains.Target.createTarget({ url: "about:blank" })
      await session.use(created.targetId)
    } else {
      await session.use(page.targetId)
    }

    await session.domains.Page.enable()
    const loaded = session.waitFor("Page.loadEventFired", { timeoutMs: 5000 })
    await session.domains.Page.navigate({ url: "data:text/html,<title>bcode-smoke</title>" })
    await loaded

    const r = (await session.domains.Runtime.evaluate({
      expression: "document.title",
      returnByValue: true,
    })) as { result: { value: unknown } }
    expect(r.result.value).toBe("bcode-smoke")
  } finally {
    session.close()
  }
})
