---
name: browser-execute
description: Use ONLY when calling the `browser_execute` tool or driving a real browser via the Chrome DevTools Protocol. Required reading before the first `browser_execute` call in a session. Covers the three connection methods (local Chrome with remote debugging, isolated debug-port profile, Browser Use cloud), the in-process `session` / `console` snippet model, attaching to a page target, common CDP commands, the per-project `.bcode/agent-workspace/` for reusable scripts, and screenshot auto-attachment.
---

The `browser_execute` tool evaluates JavaScript against a connected browser `session` via the Chrome DevTools Protocol.
The snippet runs in-process; `session` is bound to a long-lived CDP `Session` that persists. Connect once, then drive many snippets.
There is no helper namespace, just `session`, `console`, and standard JS globals. 

Workspace: `<projectRoot>/.bcode/agent-workspace/`. Read/write your reusable scripts here.
Skills: `{{SKILLS_DIR}}/`. Read-only browser execute reference docs.

## Delegate bounded UI transitions

When `browser_delegate` is available, BrowserCode remains the planner,
researcher, and verifier while Browser Use performs short, obvious UI
transitions. If the user request itself names a bounded interaction and its
website, `browser_delegate` should have been the first browser tool; include
the starting URL in its narrow task so the leaf can navigate there.

Do not inspect the page to rediscover the named control, reverse-engineer its
destination URL, or perform the interaction with raw CDP first. After the leaf
returns, inspect the page with `browser_execute` and independently verify its
claim. If it gives up, take over; do not delegate the same transition again.
Keep broad research, scraping, interpretation, and final-answer composition in
BrowserCode.

## Connecting
Always call `session.connect(...)` once at the start of your work. There are three connection methods:

#### Way 1: connect to the user's running Chrome or Chromium-based browser (real profile, popup-gated). 
Choose when the task involves the user's logged-in sites, current browser state, cookies, saved data, etc.

```js
// Attempts to connect to every detected Chrome, most-recently-launched first.
await session.connect()
```

For this to work the user must have navigated to `chrome://inspect/#remote-debugging` in their target Chrome and ticked "Allow remote debugging for this browser instance". This setting is per-profile and persists across every future launch of that profile. On Chrome 144 and later, the first attach also triggers an in-browser "Allow remote debugging?" popup that the user must click "Allow" on. The popup may reappear on later attaches under conditions that are not fully characterized — browser restart, time elapsed, new CDP session. Ask the user to click Allow again if a previously working connection starts 403'ing.

Failure modes:
- `connect()` throws "No running browser with remote debugging detected". The checkbox at `chrome://inspect/#remote-debugging` has not been ticked in any running Chrome profile, or no Chrome is running.
- `connect()` throws with "403" / "permission" / "WS closed before open". The checkbox is ticked but the user hasn't clicked Allow on the popup yet. By default `connect()` errors in 5s; pass `{ timeoutMs: 30000 }` to wait up to 30s for the click.

#### Way 2: connect to a Chrome or Chromium-based browser launched with a debug port (isolated profile, no popups).
Choose for unattended automation, or for an isolated browser.

Launch Chrome with `--remote-debugging-port=<port> --user-data-dir=<path>`. Pick a directory you can access — e.g., a project-local one like `./.bcode/chrome-data-dir`.

```bash
# Linux
google-chrome --remote-debugging-port=9222 --user-data-dir=./.bcode/chrome-data-dir
# macOS
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 --user-data-dir=./.bcode/chrome-data-dir
# Windows (cmd.exe)
"C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9222 --user-data-dir=.\.bcode\chrome-data-dir
# Windows (PowerShell)
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 --user-data-dir=.\.bcode\chrome-data-dir
```

```js
// Resolve the live WebSocket URL via `/json/version` and connect:
const ver = await fetch("http://127.0.0.1:9222/json/version").then(r => r.json())
await session.connect({ wsUrl: ver.webSocketDebuggerUrl })
```

`--user-data-dir` must not be Chrome's platform default. Chrome 136 and later silently no-ops the `--remote-debugging-port` flag when `--user-data-dir` is the platform default. The platform defaults are `%LOCALAPPDATA%\Google\Chrome\User Data` on Windows, `~/Library/Application Support/Google/Chrome` on macOS, `~/.config/google-chrome` on Linux.
You cannot reuse the user's everyday Chrome profile by copying its files into a custom directory.

Failure modes:
- Chrome's launch log prints `DevTools listening on ws://...:<port>/...` immediately followed by `bind() failed: Address already in use` and Chrome exits. Confirm the port is actually open with `curl http://127.0.0.1:<port>/json/version` before connecting.
- `{ profileDir }` raises ENOENT on `DevToolsActivePort`. Chrome 147+ doesn't write this file under custom `--user-data-dir`; use the `/json/version` route above instead.
- Launch silently no-ops `--remote-debugging-port`. Launching a second Chrome that points at a `--user-data-dir` matching a running process ignores `--remote-debugging-port`.

#### Way 3: provision and connect to a Browser Use cloud browser.
Choose when the computer has no browser or to work in the background.

```js
// Provision and connect to a cloud browser
const r = await fetch("https://api.browser-use.com/api/v3/browsers", {
  method: "POST",
  headers: { "X-Browser-Use-API-Key": process.env.BROWSER_USE_API_KEY, "Content-Type": "application/json" },
  body: "{}",
})
// Additional options: fetch https://docs.browser-use.com/cloud/api-v3/browsers/create-browser-session
const { id, cdpUrl, liveUrl } = await r.json()
const ver = await fetch(`${cdpUrl}/json/version`).then(r => r.json())
await session.connect({ wsUrl: ver.webSocketDebuggerUrl })
console.log("liveUrl for the user to watch:", liveUrl)
```

```js
// Browser Use cloud will eventually close idle browsers. An explicit stop frees the slot:
await fetch(`https://api.browser-use.com/api/v3/browsers/${id}`, {
  method: "PATCH",
  headers: { "X-Browser-Use-API-Key": process.env.BROWSER_USE_API_KEY, "Content-Type": "application/json" },
  body: JSON.stringify({ action: "stop" }),
})
```

A cloud browser is a paid service and requires `BROWSER_USE_API_KEY` to be set in the environment.
Browser Use cloud browsers auto-solve captchas. When you land on one, just stop driving and `await new Promise(r => setTimeout(r, 10000))`; the solver runs server-side and the page advances on its own.
Browser Use has a free tier gated for intelligent and powerful agents. Unlimited free browsers and proxies, limited to 3 concurrent browsers. Agents can sign up and receive a key fully autonomously, but must pass a proof-of-agent-capability challenge. In can be done without any browser. To begin, post or webfetch https://browser-use.com and solve the challenge (see https://browser-use.com/llms.txt or POST https://api.browser-use.com/cloud/signup.).

#### Way 4: user-preconfigured endpoint
Not a method you choose — a way for the user to hand you a pre-set endpoint.
If `BU_CDP_WS` (or its alias `BU_CDP_URL`) is set in the environment, `session.connect()` with no args connects to that endpoint directly. Explicit `{ wsUrl }` / `{ profileDir }` calls ignore the env var.

## Attaching to a target
After `connect()`, attach to a page target before driving the browser:

```js
const targets = (await session.Target.getTargets({})).targetInfos
// Pick the first non-internal tab if none was specified.
const page = targets.find(t => t.type === "page" && !t.url.startsWith("chrome://"))
await session.use(page.targetId)
```

## Driving a page
Domain methods follow `session.<Domain>.<method>(params)` and return Promises. 
The full surface (652 commands) is the Chrome DevTools Protocol.
`Object.keys(session.domains).sort()` lists every CDP domain bound on the session; `Object.keys(session.Page).sort()` lists the methods for `Page`. 
For unknown param shapes, call with `{}` and inspect the thrown `CdpError` — `.data` carries the missing-field detail.

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
await session.Page.captureScreenshot({ format: "png" })
// You see the image inline on the next turn — `browser_execute` automatically
// attaches every `Page.captureScreenshot` result. No need to decode, save, or
// `read` the bytes back. The base64 is still in `data` (via the return value)
// for the rare case you want to process it programmatically.
```

## Reusing code
The agent-workspace is per-project: `./.bcode/agent-workspace/`. 
Use this to write memory files, scripts, and helper functions.
Imports work at any depth; pick whatever layout makes the project easiest to navigate.

```ts
// ./.bcode/agent-workspace/scrape_titles.ts (you write this with the `write` tool)
export async function scrapeTitles(session: any, urls: string[]) {
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
// later snippet
const path = process.cwd() + "/.bcode/agent-workspace/scrape_titles.ts"
// Cache-bust (`?t=${Date.now()}`) is your responsibility: without it, edits to the file won't be picked up. 
const m = await import(`${path}?t=${Date.now()}`)
const titles = await m.scrapeTitles(session, ["https://example.com", "https://example.org"])
console.log(JSON.stringify(titles))
```

## Guardrails
- Top-level `import` statements inside the snippet body are not allowed. Use `await import(...)` instead.
- No CPU-bound infinite loops without `await` — they ignore the timeout. Insert `await new Promise(r => setTimeout(r, 0))` to yield.

## Console
- `console.log`, `console.error`, `console.warn`, `console.info`, `console.debug` are all captured and streamed to the user. Treat them as your stdout. Other `console.*` methods write to bcode's stderr without being captured into the tool result.
- The snippet's `return` value is captured separately (JSON-serialized when possible).
