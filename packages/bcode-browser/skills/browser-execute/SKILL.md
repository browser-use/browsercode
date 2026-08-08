---
name: browser-execute
description: Required reference for driving a browser with browser_execute and its persistent CDP session.
---

`browser_execute` runs JavaScript with `session`, `console`, and standard JS globals. The CDP `session` persists across
calls, but local JavaScript variables do not. Use short deterministic snippets, print or return compact structured
results, and checkpoint large collections under `./.bcode/agent-workspace/`.

This read-only skill is materialized under `{{SKILLS_DIR}}/browser-execute/` for the current run.

When `browser_delegate` is available, use it for a bounded, visually driven episode with a known start URL and exact
finish criteria. Delegate the whole episode, not one click from it. Keep ambiguous research, exhaustive collection,
CDP/API reverse engineering, filesystem work, and access recovery in the parent agent. Trust a complete successful
receipt; after a give-up, take over on the same tab instead of delegating it again.

Connect once. When `BU_CDP_WS` or `BU_CDP_URL` is configured, no arguments are needed:

```js
await session.connect()
const targets = (await session.Target.getTargets({})).targetInfos
const page = targets.find(t => t.type === "page" && !t.url.startsWith("chrome://"))
await session.use(page.targetId)
```

Common operations:

```js
await session.Page.enable()
await session.Page.navigate({url: "https://example.com"})
await session.waitFor("Page.loadEventFired")

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

Every successful `Page.captureScreenshot` is attached natively to the tool result. Do not print or decode its base64.
Use `Object.keys(session.domains).sort()` or `Object.keys(session.Page).sort()` to inspect available CDP methods.

For reusable code, write a module under `./.bcode/agent-workspace/` and dynamically import it with a cache-busting query:

```js
const path = process.cwd() + "/.bcode/agent-workspace/helpers.ts"
const helpers = await import(`${path}?t=${Date.now()}`)
```

Use `await import(...)`; top-level static imports are unsupported. Avoid CPU-bound loops without await points. Prefer
several small calls over one long call, and verify the current URL, selected entity, counts, and required fields before
submitting the final result.
