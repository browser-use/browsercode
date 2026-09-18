import { afterAll, beforeAll, expect, test } from "bun:test"
import { Session } from "../src/cdp/session"
import { choices, interact, validateChoice } from "../src/jev"

test("rejects hallucinated choices, incomplete probabilities and nonfinite confidence", () => {
  expect(() => validateChoice({ choice: "invented", confidence: 1, probabilities: { a: 1 } }, ["a"])).toThrow()
  expect(() => validateChoice({ choice: "a", confidence: 1, probabilities: { a: 1 } }, ["a", "b"])).toThrow()
  expect(() => validateChoice({ choice: "a", confidence: NaN, probabilities: { a: 1 } }, ["a"])).toThrow()
  expect(validateChoice({ choice: "a", confidence: 0.9, probabilities: { a: 1 } }, ["a"]).choice).toBe("a")
})

test("text entry exposes only caller-supplied values and uploads are excluded", () => {
  const page = {
    actions: [
      { id: "e1", kind: "fill", label: "City" },
      { id: "e2", kind: "upload", label: "File" },
    ],
  }
  // Structural minimum intentionally exercises the menu boundary without a browser.
  const empty = choices(page as Parameters<typeof choices>[0], {})
  expect(Object.keys(empty)).toHaveLength(0)
  const menu = choices(page as Parameters<typeof choices>[0], { origin: "Zurich" })
  expect(Object.keys(menu)).toEqual(["e1:v0"])
  expect(menu["e1:v0"].text).toBe("Zurich")
})

// Live mechanism checks use an already-owned isolated browser and a loopback provider stub.
// There are no real model calls. The harness must stop the browser after this test process.
const enabled = !!process.env.JEV_TEST_CDP
const session = new Session()
let target: string
let provider: ReturnType<typeof Bun.serve>
let respond: (criteria: Record<string, { target?: string; operation?: string }>) => Promise<string> | string
let mode = "normal"
let requests = 0
let shots = 0

beforeAll(async () => {
  if (!enabled) return
  await session.connect({ wsUrl: process.env.JEV_TEST_CDP })
  const result = (await session._call("Target.createTarget", { url: "about:blank" })) as { targetId: string }
  target = result.targetId
  await session.use(target)
  session.onCallResult((method) => {
    if (method === "Page.captureScreenshot") shots++
  })
  provider = Bun.serve({
    port: 0,
    async fetch(req) {
      requests++
      const body = (await req.json()) as {
        questions: { action: { criteria: Record<string, { target?: string; operation?: string }> } }
      }
      const criteria = body.questions.action.criteria
      const choice = await respond(criteria)
      return Response.json({
        answers: {
          action: {
            choice: mode === "invalid" ? "invented" : choice,
            confidence: 1,
            probabilities: Object.fromEntries(Object.keys(criteria).map((key) => [key, key === choice ? 1 : 0])),
          },
        },
        ...(mode === "no_usage" ? {} : { usage: { input_tokens: 100 } }),
      })
    },
  })
})

afterAll(async () => {
  if (!enabled) return
  await session._call("Target.closeTarget", { targetId: target })
  session.close()
  provider.stop(true)
})

async function js(expression: string) {
  const result = (await session._call("Runtime.evaluate", { expression, returnByValue: true })) as {
    result: { value: unknown }
  }
  return result.result.value
}
async function fixture(html: string) {
  mode = "normal"
  requests = 0
  await js(`document.open();document.write(${JSON.stringify(html)});document.close();window.__jevFast=undefined;`)
}
function run(input: unknown, isActive = () => true) {
  return interact(session, input, { isActive, apiKey: "local-test", apiUrl: `http://127.0.0.1:${provider.port}` })
}

test.skipIf(!enabled)("one burst types, selects and clicks in the existing tab with observed evidence", async () => {
  await fixture(`<label>City<input id="city"></label><label>Trip<select id="trip"><option>Round trip</option><option>One way</option></select></label>
    <button onclick="document.querySelector('#out').textContent=document.querySelector('#city').value+' '+document.querySelector('#trip').value">Search</button><p id="out"></p>`)
  respond = (criteria) => {
    const desired = requests === 1 ? "fill" : requests === 2 ? "select" : requests === 3 ? "click" : "stop"
    return Object.keys(criteria).find((key) => criteria[key].operation === desired) ?? "SUBGOAL_REACHED"
  }
  const activeId = session.getActiveSession()
  const before = shots
  const result = await run({ goal: "Search one way from Zurich", values: { origin: "Zurich" }, timeoutMs: 15000 })
  expect(result.status).toBe("subgoal_reached")
  expect(await js("document.querySelector('#out').textContent")).toBe("Zurich One way")
  expect(session.getActiveSession()).toBe(activeId)
  expect(result.actions).toHaveLength(3)
  expect(result.unknown_cost_calls).toBe(0)
  expect(shots).toBeGreaterThan(before)
})

test.skipIf(!enabled)("an invalid response never clicks", async () => {
  await fixture('<button onclick="window.clicks=(window.clicks||0)+1">Go</button>')
  mode = "invalid"
  respond = (criteria) => Object.keys(criteria).find((key) => criteria[key].operation === "click")!
  const result = await run({ goal: "Click Go" })
  expect(result.status).toBe("needs_help")
  expect(result.actions).toHaveLength(0)
  expect(await js("window.clicks||0")).toBe(0)
})

test.skipIf(!enabled)("replaced targets during prediction return stale without a click", async () => {
  await fixture('<button onclick="window.clicks=(window.clicks||0)+1">Go</button>')
  respond = async (criteria) => {
    await js("document.querySelector('button').outerHTML='<button>Replacement</button>'")
    return Object.keys(criteria).find((key) => criteria[key].operation === "click")!
  }
  const result = await run({ goal: "Click Go" })
  expect(result.status).toBe("stale_page")
  expect(result.actions).toHaveLength(0)
})

test.skipIf(!enabled)("covered target is rejected even when its label is unchanged", async () => {
  await fixture('<button onclick="window.coveredClick=true">Go</button>')
  respond = async (criteria) => {
    await js(
      "const cover=document.createElement('div');cover.style='position:fixed;inset:0;z-index:9999';document.body.append(cover)",
    )
    return Object.keys(criteria).find((key) => criteria[key].operation === "click")!
  }
  const result = await run({ goal: "Click Go" })
  expect(result.status).toBe("needs_help")
  expect(await js("!!window.coveredClick")).toBe(false)
})

test.skipIf(!enabled)("parent expiry during prediction prevents subsequent mutation", async () => {
  await fixture('<button onclick="window.expiredClick=true">Go</button>')
  let active = true
  respond = (criteria) => {
    active = false
    return Object.keys(criteria).find((key) => criteria[key].operation === "click")!
  }
  const result = await run({ goal: "Click Go" }, () => active)
  expect(result.actions).toHaveLength(0)
  expect(await js("!!window.expiredClick")).toBe(false)
})

test.skipIf(!enabled)("no-progress ends a burst and direct CDP remains usable", async () => {
  await fixture("<button>Do nothing</button>")
  respond = (criteria) => Object.keys(criteria).find((key) => criteria[key].operation === "click")!
  const result = await run({ goal: "Open the missing menu" })
  expect(result.status).toBe("no_progress")
  expect(result.actions.length).toBeLessThanOrEqual(3)
  expect(await js("document.body.textContent='Recovered';document.body.textContent")).toBe("Recovered")
})

test.skipIf(!enabled)("missing usage remains unknown and action budget is enforced", async () => {
  await fixture("<button onclick=\"this.textContent+='!'\">Go</button>")
  mode = "no_usage"
  respond = (criteria) => Object.keys(criteria).find((key) => criteria[key].operation === "click")!
  const result = await run({ goal: "Keep clicking", maxActions: 2 })
  expect(result.status).toBe("action_limit")
  expect(result.unknown_cost_calls).toBe(2)
  expect(result.actions).toHaveLength(2)
})

test.skipIf(!enabled)("deadline aborts delayed inference without a late click", async () => {
  await fixture('<button onclick="window.lateClick=true">Go</button>')
  respond = async (criteria) => {
    await Bun.sleep(250)
    return Object.keys(criteria).find((key) => criteria[key].operation === "click")!
  }
  const result = await run({ goal: "Click Go", timeoutMs: 100 })
  expect(result.status).toBe("timeout")
  await Bun.sleep(300)
  expect(await js("!!window.lateClick")).toBe(false)
  expect(session.isConnected()).toBe(true)
})
