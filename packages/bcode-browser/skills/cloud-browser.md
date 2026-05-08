# cloud-browser.md — Browser Use cloud browser via raw HTTP

When BROWSER.md sent you here, the user wants a Browser Use cloud browser (Way 3): a clean isolated Chrome on BU's infrastructure, optionally with a geo-located proxy or a synced profile, with a `liveUrl` the user can open to watch you work.

There is no `browser_open_cloud` tool. You write the HTTP calls yourself in a `browser_execute` snippet. This keeps the connection model symmetric (you also call `session.connect()` for local browsers in Way 1 and Way 2) and gives you full control over the BU API surface — provision, stop, swap profiles, change proxies, anything BU exposes.

## Authentication

Every call to `https://api.browser-use.com/...` requires an API key in the `X-Browser-Use-API-Key` header. The key lives in the environment as `BROWSER_USE_API_KEY` (the user is expected to `export` it before launching bcode, the same way they'd set `AWS_BEDROCK_ACCESS_KEY_ID` for an LLM provider).

Read it once, fail clearly if missing:

```js
const apiKey = process.env.BROWSER_USE_API_KEY
if (!apiKey) {
  throw new Error("BROWSER_USE_API_KEY is not set. Get a key at https://browser-use.com and re-launch bcode with the key exported.")
}
```

## Provision

```js
const r = await fetch("https://api.browser-use.com/api/v3/browsers", {
  method: "POST",
  headers: { "X-Browser-Use-API-Key": apiKey, "Content-Type": "application/json" },
  body: JSON.stringify({
    // All optional — omit for an ephemeral fresh-profile browser with no proxy.
    // profile_id: "<uuid>",          // attach an existing BU profile
    // proxy_country_code: "us",      // geo-located proxy
  }),
})
if (!r.ok) throw new Error(`provision failed: ${r.status} ${await r.text()}`)
const body = await r.json()
// Some BU regions return camelCase, others snake_case. Accept both.
const id = body.id
const cdpUrl = body.cdp_url ?? body.cdpUrl
const liveUrl = body.live_url ?? body.liveUrl
```

The `liveUrl` is a viewer URL the user can open in their own browser to watch the cloud browser's pixels. **Print it to console** so the user can click it:

```js
console.log("Cloud browser ready. Live view:", liveUrl)
```

Stash `id` somewhere (a `globalThis.cloudBrowserId = id` is fine, or the snippet's return value) — you need it to stop the browser later.

## Connect

```js
await session.connect({ wsUrl: cdpUrl })
const targets = (await session.Target.getTargets({})).targetInfos
const page = targets.find(t => t.type === "page")
await session.use(page.targetId)
```

From here on `session.<Domain>.<method>(...)` drives the cloud browser exactly like a local Chrome.

## Stop

When you're done, stop the browser. BU's quotas and idle reclaim will eventually clean it up if you forget, but explicit stop is faster and frees the slot:

```js
await fetch(`https://api.browser-use.com/api/v3/browsers/${id}`, {
  method: "PATCH",
  headers: { "X-Browser-Use-API-Key": apiKey, "Content-Type": "application/json" },
  body: JSON.stringify({ state: "stop" }),
})
```

If you'll do this often within one project, save it as `./.bcode/agent-workspace/cloud.ts` (see BROWSER.md "Reusing code") and import it from later snippets.

## Swap

To switch from one cloud browser to another (e.g. different proxy country) within the same opencode session:

```js
// Stop the old one first.
await fetch(`https://api.browser-use.com/api/v3/browsers/${oldId}`, {
  method: "PATCH",
  headers: { "X-Browser-Use-API-Key": apiKey, "Content-Type": "application/json" },
  body: JSON.stringify({ state: "stop" }),
})

// Close the local Session's WS so connect() opens a fresh one.
await session.close()

// Provision and connect to the new one (provision block above, with new params).
```

## A reusable workspace helper

Recommended pattern for any project that uses cloud browsers more than once:

```ts
// ./.bcode/agent-workspace/cloud.ts
const API = "https://api.browser-use.com/api/v3/browsers"
const key = () => {
  const k = process.env.BROWSER_USE_API_KEY
  if (!k) throw new Error("BROWSER_USE_API_KEY is not set.")
  return k
}

export async function provision(opts: { profileId?: string; proxyCountryCode?: string } = {}) {
  const r = await fetch(API, {
    method: "POST",
    headers: { "X-Browser-Use-API-Key": key(), "Content-Type": "application/json" },
    body: JSON.stringify({
      profile_id: opts.profileId,
      proxy_country_code: opts.proxyCountryCode,
    }),
  })
  if (!r.ok) throw new Error(`provision failed: ${r.status} ${await r.text()}`)
  const body = await r.json()
  return {
    id: body.id as string,
    cdpUrl: (body.cdp_url ?? body.cdpUrl) as string,
    liveUrl: (body.live_url ?? body.liveUrl) as string,
  }
}

export async function stop(id: string) {
  const r = await fetch(`${API}/${id}`, {
    method: "PATCH",
    headers: { "X-Browser-Use-API-Key": key(), "Content-Type": "application/json" },
    body: JSON.stringify({ state: "stop" }),
  })
  if (!r.ok) throw new Error(`stop failed: ${r.status} ${await r.text()}`)
}
```

Then any snippet does:

```js
const { provision, stop } = await import(`${process.cwd()}/.bcode/agent-workspace/cloud.ts?t=${Date.now()}`)
const { id, cdpUrl, liveUrl } = await provision({ proxyCountryCode: "us" })
console.log("Live view:", liveUrl)
await session.connect({ wsUrl: cdpUrl })
// ... do work ...
await stop(id)
```

## Other BU API endpoints

The full BU cloud API (profile sync, profile list, custom proxies, recording on/off, etc.) is documented at https://browser-use.com — `read` the docs and write the matching `fetch` call. Anything BU's API exposes is reachable from a snippet without bcode-side wrapper code.
