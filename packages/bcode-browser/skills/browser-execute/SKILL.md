---
name: browser-execute
description: Required reference for driving a browser with browser_execute and its persistent CDP session.
---

`browser_execute` runs JavaScript with `session`, `console`, and standard JS globals. The CDP `session` persists across
calls, but local JavaScript variables do not. Use short deterministic snippets, print or return compact structured
results, and checkpoint large collections under `./.bcode/agent-workspace/`.

This read-only skill is materialized under `{{SKILLS_DIR}}/browser-execute/` for the current run.

## Connect

Browser Use Cloud API V4 automatically connects and attaches the existing page. When both `V4_RUN_ID` and
`BU_CDP_WS` or `BU_CDP_URL` are set, start driving immediately; do not call `session.connect()` or `session.use()`.

Otherwise connect once, then attach a non-internal page:

```js
await session.connect()
const targets = (await session.Target.getTargets({})).targetInfos
const page = targets.find(t => t.type === "page" && !t.url.startsWith("chrome://"))
await session.use(page.targetId)
```

An explicit `{wsUrl}` connects to a chosen CDP endpoint. Every reconnect or browser switch clears the target attachment,
so list targets and call `session.use(...)` again. If a target command throws `-32001`, reattach the intended page and
retry once. Opening a tab does not switch the attachment.

## Drive

CDP methods are available as `session.<Domain>.<method>(params)`. Inspect the surface with
`Object.keys(session.domains).sort()` or `Object.keys(session.Page).sort()`.

```js
await session.Page.enable()
const loaded = session.waitFor("Page.loadEventFired", {timeoutMs: 15_000})
const navigation = await session.Page.navigate({url: "https://example.com"})
await loaded
if (navigation.errorText) throw new Error(navigation.errorText)

const result = await session.Runtime.evaluate({
  expression: `JSON.stringify({title: document.title, text: document.body.innerText.slice(0, 4000)})`,
  returnByValue: true,
})
console.log(result.result.value)

await session.Runtime.evaluate({
  expression: `document.querySelector("button")?.click()`,
  returnByValue: true,
})

await session.Input.insertText({text: "hello"})
await session.Page.captureScreenshot({format: "png"})
```

Register event waiters before the action that triggers them. Treat non-empty `Page.navigate.errorText` as failure.
Every successful `Page.captureScreenshot` response is attached natively to the tool result; do not print or decode its
base64. Persistent `ERR_TUNNEL_CONNECTION_FAILED` requires another source or browser, not retries on the same endpoint.

## Reuse Code

Write reusable modules under `./.bcode/agent-workspace/` and import them with a cache-busting query:

```js
const path = process.cwd() + "/.bcode/agent-workspace/helpers.ts"
const helpers = await import(`${path}?t=${Date.now()}`)
```

Use `await import(...)`; top-level static imports are unsupported. Avoid CPU-bound loops without await points. Prefer
several small calls over one long call. After a timeout, continue in the next call if `Target.getTargets` still works.
Print or return only the evidence needed for the current decision. After three tool calls that add no new evidence
toward the same missing fact, change the source or approach instead of repeating the strategy. Before submitting,
verify the current URL, selected entity or variant, counts, and every required field.
