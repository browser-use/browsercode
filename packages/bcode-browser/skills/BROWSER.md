# BROWSER.md — driving a real browser with `browser_execute`

Use the `browser_execute` tool to run JavaScript against a connected browser via the Chrome DevTools Protocol. The snippet runs in-process; `session` is bound to a long-lived CDP `Session` that persists across calls within the same bcode session. You connect once, drive many.

**Locations:**

- Workspace (read/write your reusable scripts): `<projectRoot>/.bcode/agent-workspace/`. The bcode CLI runs from the project root, so `./.bcode/agent-workspace/foo.ts` works directly with the `read`/`write`/`edit` tools.
- Skills (read-only reference docs): `{{SKILLS_DIR}}/`. Run `read {{SKILLS_DIR}}/interaction-skills/` to list every available interaction skill before reading any one of them.

## The model in one paragraph

`browser_execute` evaluates whatever JS you write against `session`. There is no auto-loaded library, no privileged file, no helper namespace — just `session` and standard JS globals. To reuse code from a previous snippet, save it as a `.ts` file under `./.bcode/agent-workspace/` (using the `write` tool) and `await import("/abs/path?t=" + Date.now())` it from a later snippet. The import takes an **absolute** path — construct it from `process.cwd()` inside the snippet. Same mechanism for a 5-line wrapper and a 500-line script. Skills under `{{SKILLS_DIR}}/` are documentation you `read`, not modules you `import` — they teach you the CDP patterns; you write the code.

## Connecting

You always call `session.connect(...)` once at the start of your work. The `Session` is fresh on the first `browser_execute` call of an opencode session; subsequent calls reuse it. Three connection methods, in order of preference for typical tasks:

**Way 1 — connect to the user's running Chrome (real profile, popup-gated).** Best when the task involves the user's actual logged-in sites.

```js
// Auto-detect the most-recently-launched Chrome with remote debugging enabled.
await session.connect()
```

The user must have ticked "Allow remote debugging for this browser instance" once at `chrome://inspect/#remote-debugging` (sticky per-profile), and on Chrome 144+ click "Allow" on the in-browser popup at first attach. If `connect()` fails with a 403/permission message, ask the user to do this. To wait for the click instead of erroring fast, pass `{ profileDir: "/abs/path", timeoutMs: 30000 }`.

**Way 2 — connect to a Chrome you (or the user) launched with a debug port (isolated profile, no popups).** Best for unattended automation.

```bash
# User runs this once (or you run it via the `bash` tool):
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/bcode-chrome
```

```js
await session.connect({ wsUrl: "ws://127.0.0.1:9222/devtools/browser" })
// or, if you know the profile dir:
await session.connect({ profileDir: "/tmp/bcode-chrome" })
```

The `--user-data-dir` must NOT be Chrome's platform default (`%LOCALAPPDATA%\Google\Chrome\User Data` on Windows, `~/Library/Application Support/Google/Chrome` on macOS, `~/.config/google-chrome` on Linux) — Chrome 136+ silently no-ops the port flag in that case.

**Way 3 — provision and connect to a Browser Use cloud browser.** Best when the user can't see the browser, you need a clean profile, geo-located proxy, or fingerprint isolation. Read `{{SKILLS_DIR}}/cloud-browser.md` for the full pattern (provision, stop, swap profile/proxy). Briefly:

```js
const r = await fetch("https://api.browser-use.com/api/v3/browsers", {
  method: "POST",
  headers: { "X-Browser-Use-API-Key": process.env.BROWSER_USE_API_KEY, "Content-Type": "application/json" },
  body: "{}",
})
const { id, cdp_url, live_url } = await r.json()
await session.connect({ wsUrl: cdp_url })
console.log("liveUrl for the user to watch:", live_url)
```

Requires `BROWSER_USE_API_KEY` in the environment (the user should have set this before launching bcode). If absent, tell the user to get a key at https://browser-use.com and `export BROWSER_USE_API_KEY=...`.

## Attaching to a target

After `connect()`, attach to a page target before driving the browser:

```js
const targets = (await session.Target.getTargets({})).targetInfos
const page = targets.find(t => t.type === "page" && !t.url.startsWith("chrome://"))
await session.use(page.targetId)
```

`session.use(targetId)` makes subsequent calls auto-route to that target. Switch with another `session.use`.

## Driving a page

Domain methods follow `session.<Domain>.<method>(params)` and return Promises. The full surface (652 commands) is the Chrome DevTools Protocol — see https://chromedevtools.github.io/devtools-protocol/.

Common moves:

```js
// Navigate.
await session.Page.enable()
await session.Page.navigate({ url: "https://example.com" })
await session.waitFor("Page.loadEventFired")

// Evaluate JS in the page.
const r = await session.Runtime.evaluate({
  expression: "document.title",
  returnByValue: true,
})
console.log(r.result.value)

// Click by coordinates.
const x = 200, y = 300
await session.Input.dispatchMouseEvent({ type: "mouseMoved", x, y })
await session.Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 })
await session.Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 })

// Type text.
await session.Input.insertText({ text: "hello" })

// Screenshot.
const { data } = await session.Page.captureScreenshot({ format: "png" })
// data is base64; write with the `write` tool or process in JS.
```

For the full menu of UI mechanics — dropdowns, dialogs, iframes, shadow DOM, uploads, scrolling, screenshots-with-highlights — list `{{SKILLS_DIR}}/interaction-skills/` to see all available topics, then read the relevant one.

## Switching browsers mid-session

You own the connection. To swap:

```js
await session.close()
await session.connect({ /* new opts */ })
```

Cloud cleanup is your responsibility — if you're done with a cloud browser, stop it explicitly (see `{{SKILLS_DIR}}/cloud-browser.md` for the PATCH call). Otherwise it persists until your API quota or BU's idle timer reclaims it.

## Reusing code: write to the workspace, import from snippet

The agent-workspace is per-project: `./.bcode/agent-workspace/`. It's a flat directory of `.ts` files you own and edit with the standard `write`/`edit` tools. Saved scripts travel with the project (`.bcode/agent-workspace/` is committed by default), so `git clone && cd && bcode` shares them.

Write once, import many:

```ts
// ./.bcode/agent-workspace/scrape_titles.ts (you write this with the `write` tool)
export async function run(session: any, urls: string[]) {
  const titles: string[] = []
  await session.Page.enable()
  for (const url of urls) {
    await session.Page.navigate({ url })
    await session.waitFor("Page.loadEventFired")
    const r = await session.Runtime.evaluate({ expression: "document.title", returnByValue: true })
    titles.push(r.result.value)
  }
  return titles
}
```

```js
// later snippet (browser_execute call) — construct the absolute path from cwd.
const path = process.cwd() + "/.bcode/agent-workspace/scrape_titles.ts"
const m = await import(`${path}?t=${Date.now()}`)
const titles = await m.run(session, ["https://example.com", "https://example.org"])
console.log(JSON.stringify(titles))
```

Cache-bust (`?t=${Date.now()}`) is your responsibility: without it, edits to the file won't be picked up. The pattern is the same for any depth — save to `subdir/foo.ts`, import by full path.

## Guardrails

- **Top-level `import`** statements inside the snippet body are **not allowed** — the snippet is wrapped in an async function. Use `await import(...)` instead.
- **No CPU-bound infinite loops without `await`.** JS Promises aren't preemptively cancellable; a `for (;;)` without an `await` yield-point will not respect the timeout. Insert `await new Promise(r => setTimeout(r, 0))` if you genuinely need a long compute loop.
- `console.log`, `console.error`, `console.warn`, `console.info` are all captured and streamed to the user. Treat them as your stdout.
- The snippet's `return` value is captured separately (JSON-serialized when possible).

## When something doesn't work

- **`session.Page.navigate` hangs forever** → the page is showing a native dialog. Use `session.Page.handleJavaScriptDialog({ accept: true })` to dismiss.
- **Selectors don't find elements that you can see** → likely an iframe or shadow DOM. Read `{{SKILLS_DIR}}/interaction-skills/iframes.md` or `shadow-dom.md`.
- **Actions silently no-op** → the page is mid-load. After `Page.navigate`, await `session.waitFor("Page.loadEventFired")` before driving inputs.
- **Connection refused or 403 on connect()** → Chrome wasn't started with `--remote-debugging-port`, or the user hasn't clicked "Allow" on the remote-debugging prompt. Pass `{ profileDir, timeoutMs: 30000 }` to wait for the click, or fall back to Way 2.
- **Cloud `connect()` fails after a successful provision** → check that `cdp_url` came back in the POST response; some BU regions return `cdpUrl` (camelCase) — accept both. See `{{SKILLS_DIR}}/cloud-browser.md`.
