import { afterAll, beforeAll, expect, test } from "bun:test"
import { Session } from "../src/cdp/session"
import { choice, cost } from "../src/fast-actor"
import { interact } from "../src/jev"

test("invalid action JSON and invented IDs are rejected", () => {
  for (const value of [null, "not json", '{"choice":"invented"}', '{"choice":"a","code":"click()"}'])
    expect(() => choice(value, ["a"])).toThrow()
  expect(choice('{"choice":"a"}', ["a"])).toBe("a")
})

test("missing, negative and BYOK charges are never silently free", () => {
  for (const usage of [null, {}, { cost: -1 }, { cost: Infinity }, { cost: 0, is_byok: true }])
    expect(cost(usage)).toBeNull()
  expect(cost({ cost: 0 })).toBe(0)
  expect(cost({ cost: 0.001, is_byok: true, cost_details: { upstream_inference_cost: 0.02 } })).toBe(0.021)
})

// Exercise the actual borrowed-session path with a loopback inference server.
// ACTOR_TEST_CDP must identify an owned, isolated browser, never the user's profile.
const enabled = !!process.env.ACTOR_TEST_CDP
const session = new Session()
type Criteria = Record<string, { operation?: string; target?: string; current_value?: string }>
let provider: ReturnType<typeof Bun.serve>
let target: string
let response: (criteria: Criteria, state: { values: Record<string, string> }) => Promise<string> | string
let requests = 0
let mode = "normal"

beforeAll(async () => {
  if (!enabled) return
  await session.connect({ wsUrl: process.env.ACTOR_TEST_CDP })
  target = ((await session._call("Target.createTarget", { url: "about:blank" })) as { targetId: string }).targetId
  await session.use(target)
  provider = Bun.serve({
    port: 0,
    async fetch(req) {
      requests++
      const body = (await req.json()) as {
        messages: { content: string }[]
        model: string
        reasoning: { enabled: boolean }
      }
      expect(body.model).toBe("qwen/qwen3.5-9b")
      expect(body.reasoning.enabled).toBe(false)
      const observation = JSON.parse(body.messages[1].content)
      const selected = await response(observation.actions, observation.state)
      if (mode === "http_error") return new Response("provider error", { status: 429 })
      return Response.json({
        id: "test-generation",
        model: body.model,
        provider: "loopback",
        choices: [
          { message: { content: mode === "invalid" ? '{"choice":"invented"}' : JSON.stringify({ choice: selected }) } },
        ],
        ...(mode === "missing_usage" ? {} : { usage: { cost: 0.001, prompt_tokens: 50, completion_tokens: 8 } }),
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
  return (
    (await session._call("Runtime.evaluate", { expression, returnByValue: true })) as { result: { value: unknown } }
  ).result.value
}
async function fixture(html: string) {
  requests = 0
  mode = "normal"
  await js(`document.open();document.write(${JSON.stringify(html)});document.close();window.__jevFast=undefined`)
}
function run(input: unknown, extra: { isActive?: () => boolean; signal?: AbortSignal; logPath?: string } = {}) {
  return interact(session, input, {
    isActive: () => true,
    apiKey: "local-test",
    actorModel: "qwen/qwen3.5-9b",
    apiUrl: `http://127.0.0.1:${provider.port}`,
    ...extra,
  })
}
function click(criteria: Criteria) {
  return Object.keys(criteria).find((id) => criteria[id].operation === "click")!
}

test.skipIf(!enabled)("caller values reach selects and observed evidence returns on the same session", async () => {
  await fixture(
    '<label>City<input id="city"></label><label>State<select id="state"><option>Alabama</option><option>Texas</option></select></label><button onclick="document.body.dataset.result=city.value+state.value">Go</button>',
  )
  response = (criteria, state) => {
    expect(state.values).toEqual({ city: "Austin", state: "Texas" })
    if (requests === 1)
      return Object.keys(criteria).find(
        (id) => criteria[id].operation === "fill" && criteria[id].target?.includes("Austin"),
      )!
    if (requests === 2) {
      const id = Object.keys(criteria).find(
        (id) => criteria[id].operation === "select" && criteria[id].target?.endsWith("Texas"),
      )!
      expect(criteria[id].current_value).toBe("Alabama")
      return id
    }
    return requests === 3 ? click(criteria) : "SUBGOAL_REACHED"
  }
  const attached = session.getActiveSession()
  const result = await run({ goal: "Fill Austin, Texas and click Go", values: { city: "Austin", state: "Texas" } })
  expect(result.status).toBe("subgoal_reached")
  expect(result.verified).toBe(false)
  expect(result.actions).toHaveLength(3)
  expect(result.calls).toHaveLength(4)
  expect(result.known_cost_usd).toBe(0.004)
  expect(result.calls[0].generation_id).toBe("test-generation")
  expect(await js("document.body.dataset.result")).toBe("AustinTexas")
  expect(session.getActiveSession()).toBe(attached)
})

test.skipIf(!enabled)("invalid reply preserves its charge and executes no action", async () => {
  await fixture('<button onclick="document.body.dataset.clicked=1">Go</button>')
  response = click
  mode = "invalid"
  const result = await run({ goal: "Go" })
  expect(result.status).toBe("needs_help")
  expect(result.actions).toHaveLength(0)
  expect(result.known_cost_usd).toBe(0.001)
  expect(await js("document.body.dataset.clicked || null")).toBeNull()
})

test.skipIf(!enabled)("provider failures are not retried or charged as zero known cost", async () => {
  await fixture("<button>Go</button>")
  response = click
  mode = "http_error"
  const result = await run({ goal: "Go" })
  expect(result.status).toBe("needs_help")
  expect(requests).toBe(1)
  expect(result.unknown_cost_calls).toBe(1)
  expect(result.actions).toHaveLength(0)
})

test.skipIf(!enabled)("replacement during prediction yields control before clicking", async () => {
  await fixture("<button>Go</button>")
  response = async (criteria) => {
    await js("document.querySelector('button').outerHTML='<button>Replacement</button>'")
    return click(criteria)
  }
  const result = await run({ goal: "Go" })
  expect(result.status).toBe("stale_page")
  expect(result.actions).toHaveLength(0)
})

test.skipIf(!enabled)("deadline aborts prediction and no late mutation occurs", async () => {
  await fixture('<button onclick="document.body.dataset.clicked=1">Go</button>')
  response = async (criteria) => {
    await Bun.sleep(250)
    return click(criteria)
  }
  const result = await run({ goal: "Go", timeoutMs: 100 })
  expect(result.status).toBe("timeout")
  await Bun.sleep(300)
  expect(await js("document.body.dataset.clicked || null")).toBeNull()
  expect(session.isConnected()).toBe(true)
})

test.skipIf(!enabled)("parent cancellation stops an in-flight prediction", async () => {
  await fixture('<button onclick="document.body.dataset.clicked=1">Go</button>')
  const controller = new AbortController()
  response = async (criteria) => {
    controller.abort()
    await Bun.sleep(100)
    return click(criteria)
  }
  const result = await run({ goal: "Go" }, { signal: controller.signal })
  expect(result.actions).toHaveLength(0)
  await Bun.sleep(150)
  expect(await js("document.body.dataset.clicked || null")).toBeNull()
})

test.skipIf(!enabled)("no-progress and action budgets allow direct recovery", async () => {
  await fixture("<button>Go</button>")
  response = click
  const result = await run({ goal: "Go" })
  expect(result.status).toBe("no_progress")
  // The first click can change focus; then two unchanged observations stop the loop.
  expect(result.actions.length).toBeLessThanOrEqual(3)
  await fixture("<button onclick=\"this.textContent+='!'\">Go</button>")
  mode = "missing_usage"
  const bounded = await run({ goal: "Go", maxActions: 2 })
  expect(bounded.status).toBe("action_limit")
  expect(bounded.unknown_cost_calls).toBe(2)
  expect(await js("document.body.textContent='Recovered'")).toBe("Recovered")
})

test.skipIf(!enabled)("concurrent bursts on one session are rejected", async () => {
  await fixture("<button>Go</button>")
  let overlap: Promise<unknown> | undefined
  response = () => {
    overlap = run({ goal: "Overlapping burst" }).then(
      () => "unexpected success",
      () => "rejected",
    )
    return "NEED_HELP"
  }
  await run({ goal: "Go" })
  expect(await overlap).toBe("rejected")
  expect(requests).toBe(1)
})

test.skipIf(!enabled)("checkbox state reaches the actor independently of its on value", async () => {
  await fixture('<label><input type="checkbox" checked>Newsletter</label>')
  response = (criteria) => {
    const control = Object.values(criteria).find((action) => action.operation === "click")
    expect(control).toMatchObject({ current_value: "on", checked: "true" })
    return "SUBGOAL_REACHED"
  }
  const result = await run({ goal: "Leave the newsletter checked" })
  expect(result.actions).toHaveLength(0)
  expect(result.status).toBe("subgoal_reached")
})

test.skipIf(!enabled)("repeated navigation context does not crowd out the form actions", async () => {
  await fixture('<nav>' + Array.from({ length: 80 }, (_, i) => `<button>Unrelated category ${i}</button>`).join("") +
    '</nav><label>Email<input type="email"></label><label>Theme<select><option>Light</option><option>Dark</option></select></label>')
  response = (criteria) => {
    expect(Object.values(criteria).some((action) => action.operation === "fill" && action.target?.includes("alex@example.com"))).toBe(true)
    expect(Object.values(criteria).some((action) => action.operation === "select" && action.target?.endsWith("Dark"))).toBe(true)
    return "NEED_HELP"
  }
  await run({ goal: "Fill email and choose Dark", values: { email: "alex@example.com", theme: "Dark" } })
})
