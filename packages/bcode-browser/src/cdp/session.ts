/**
 * CDP Session: one persistent WebSocket to Chrome's browser endpoint.
 * Auto-injects sessionId for the active target on every call.
 *
 * Connect with `flatten: true` so all sessions share one WS (no nested
 * Target.sendMessageToTarget envelopes).
 */

import { bindDomains, type Domains, type Transport } from './generated.ts';

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
};

export type ConnectOptions = {
  /** Full WS URL: ws://host:port/devtools/browser/<id>. Escape hatch. */
  wsUrl?: string;
  /** Or: read DevToolsActivePort from a specific browser's profile dir. */
  profileDir?: string;
  /** Per-candidate WS-open timeout in ms. Default 5000.
   *  A live browser opens or 403s within ~100ms, so 5s is generous.
   *  The only case that legitimately needs longer is waiting on the Chrome
   *  "Allow" popup — bump to 30000 if you expect the user to click it. */
  timeoutMs?: number;
};

/** A Chromium-based browser detected as running on this machine. */
export type DetectedBrowser = {
  /** Short label, e.g. 'Google Chrome', 'Brave', 'Comet'. */
  name: string;
  /** Absolute profile (user-data) dir. */
  profileDir: string;
  /** Port from DevToolsActivePort line 1. */
  port: number;
  /** WebSocket path from DevToolsActivePort line 2. */
  wsPath: string;
  /** `ws://127.0.0.1:<port><wsPath>` — ready for WebSocket. */
  wsUrl: string;
  /** DevToolsActivePort mtime (ms since epoch). Used to order by recency. */
  mtimeMs: number;
};

export class Session implements Transport {
  private ws?: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private activeSessionId: string | undefined;
  private eventListeners: Array<(method: string, params: unknown, sessionId?: string) => void> = [];
  private callResultListeners: Array<(method: string, params: unknown, result: unknown) => void> = [];

  // Generated bindings — one per CDP domain.
  // Initialized lazily after construction so `_call` is available.
  domains!: Domains;

  constructor() {
    this.domains = bindDomains(this);
    // Mirror domains onto `this` so calls read as `session.Page.navigate(...)`.
    for (const k of Object.keys(this.domains) as (keyof Domains)[]) {
      (this as any)[k] = this.domains[k];
    }
  }

  /**
   * Connect to Chrome's browser-level WebSocket.
   *
   * With no args, picks a browser in this precedence:
   *   1. `BU_CDP_WS` / `BU_CDP_URL` env var — single fixed endpoint, used
   *      by eval harnesses and CI to hand the agent a preconfigured browser.
   *      If set, we connect there; failure does NOT fall through to scan
   *      (the harness's intent is binding — silently using a different
   *      browser is the worse failure mode).
   *   2. OS scan via `detectBrowsers()` — try each candidate
   *      (most-recently-launched first) until a WebSocket open succeeds.
   *      Each attempt has a short timeout so dead ports and 403s fail
   *      fast and the loop moves on.
   *
   * With explicit opts ({ wsUrl } | { profileDir }), env vars are ignored
   * and we connect directly to the supplied endpoint.
   */
  async connect(opts: ConnectOptions = {}): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? 5_000;
    if (opts.wsUrl || opts.profileDir) {
      const wsUrl = await resolveWsUrl(opts);
      await this.openWs(wsUrl, timeoutMs);
      return;
    }
    const envWsUrl = process.env.BU_CDP_WS ?? process.env.BU_CDP_URL;
    if (envWsUrl) {
      await this.openWs(envWsUrl, timeoutMs);
      return;
    }
    const browsers = await detectBrowsers();
    if (browsers.length === 0) {
      const scanned = getBrowserCandidates().map(c => c.name).join(', ');
      throw new Error(
        `No running browser with remote debugging detected. Enable it from chrome://inspect > "Discover network targets", or pass { profileDir } / { wsUrl } explicitly. Scanned: ${scanned}.`,
      );
    }
    const errors: string[] = [];
    for (const b of browsers) {
      try {
        await this.openWs(b.wsUrl, timeoutMs);
        return;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`  ${b.name} @ ${b.wsUrl}: ${msg}`);
      }
    }
    throw new Error(
      `No detected browser accepted a connection. If one of these is the browser you want, click "Allow" on its remote-debugging prompt and retry, or pass { profileDir, timeoutMs: 30000 } to wait for the click:\n${errors.join('\n')}`,
    );
  }

  private openWs(wsUrl: string, timeoutMs: number): Promise<void> {
    return new Promise<void>((res, rej) => {
      const ws = new WebSocket(wsUrl);
      let done = false;
      const finish = (err?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (err) { try { ws.close(); } catch { /* ignore */ } rej(err); }
        else res();
      };
      const timer = setTimeout(() => finish(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      ws.addEventListener('open', () => finish());
      ws.addEventListener('error', (e) => finish(new Error(`WS error: ${(e as any)?.message ?? 'connect failed (likely 403, permission not granted, or port closed)'}`)));
      ws.addEventListener('message', (e) => this.onMessage(String(e.data)));
      ws.addEventListener('close', () => {
        for (const [, p] of this.pending) p.reject(new Error('CDP socket closed'));
        this.pending.clear();
        finish(new Error('WS closed before open (likely 403 or port closed)'));
      });
      this.ws = ws;
    });
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  close(): void {
    this.ws?.close();
  }

  /**
   * Pick a target and make subsequent calls auto-route to it.
   * Uses Target.attachToTarget with flatten:true (single-WS, sessionId-on-message).
   */
  async use(targetId: string): Promise<string> {
    const r = await this._call('Target.attachToTarget', { targetId, flatten: true }) as { sessionId: string };
    this.activeSessionId = r.sessionId;
    return r.sessionId;
  }

  /** Set the active sessionId directly (e.g. one you already attached). */
  setActiveSession(sessionId: string | undefined): void {
    this.activeSessionId = sessionId;
  }

  getActiveSession(): string | undefined {
    return this.activeSessionId;
  }

  /** Subscribe to all CDP events. Returns an unsubscribe fn. */
  onEvent(fn: (method: string, params: unknown, sessionId?: string) => void): () => void {
    this.eventListeners.push(fn);
    return () => {
      this.eventListeners = this.eventListeners.filter(x => x !== fn);
    };
  }

  /**
   * Subscribe to all successful CDP method results. Returns an unsubscribe fn.
   * Fires after `_call` resolves; listener errors are swallowed.
   *
   * Used by `browser-execute` to collect `Page.captureScreenshot` outputs
   * from inside an execute() call (drained into `attachments[]` so the agent
   * sees the image inline; optionally also written to `BCODE_SCREENSHOT_DIR`
   * for eval-judge consumption). Generic by design — keeps `Session`
   * agnostic of any one method's semantics.
   */
  onCallResult(fn: (method: string, params: unknown, result: unknown) => void): () => void {
    this.callResultListeners.push(fn);
    return () => {
      this.callResultListeners = this.callResultListeners.filter(x => x !== fn);
    };
  }

  /** Wait for the next event matching `method` (and optional predicate). */
  waitFor<T = unknown>(method: string, predicate?: (params: T) => boolean, timeoutMs = 30_000): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsub();
        reject(new Error(`Timeout waiting for ${method}`));
      }, timeoutMs);
      const unsub = this.onEvent((m, params) => {
        if (m !== method) return;
        if (predicate && !predicate(params as T)) return;
        clearTimeout(timer);
        unsub();
        resolve(params as T);
      });
    });
  }

  // Transport implementation. Called by the generated domain bindings.
  _call(method: string, params: unknown = {}): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Not connected. Call session.connect(...) first.'));
    }
    const id = this.nextId++;
    const msg: Record<string, unknown> = { id, method, params: params ?? {} };
    if (this.activeSessionId && !isBrowserLevel(method)) {
      msg.sessionId = this.activeSessionId;
    }
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => {
          for (const fn of this.callResultListeners) {
            try { fn(method, params, v); } catch { /* ignore */ }
          }
          resolve(v);
        },
        reject,
      });
      this.ws!.send(JSON.stringify(msg));
    });
  }

  private onMessage(raw: string): void {
    let m: any;
    try { m = JSON.parse(raw); } catch { return; }
    if (typeof m.id === 'number') {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new CdpError(m.error.code, m.error.message, m.error.data));
      else p.resolve(m.result);
    } else if (m.method) {
      for (const fn of this.eventListeners) {
        try { fn(m.method, m.params, m.sessionId); } catch { /* ignore */ }
      }
    }
  }
}

export class CdpError extends Error {
  constructor(public code: number, message: string, public data?: unknown) {
    super(`CDP ${code}: ${message}`);
    this.name = 'CdpError';
  }
}

/** Browser-level methods never take a sessionId. */
function isBrowserLevel(method: string): boolean {
  return method.startsWith('Browser.') || method.startsWith('Target.');
}

/**
 * Resolve a WebSocket URL for one of the explicit connect forms:
 *   { wsUrl }      — passthrough.
 *   { profileDir } — reads `<profileDir>/DevToolsActivePort` and builds the
 *                    WS URL directly. Works on all Chrome versions including
 *                    144+ / chrome://inspect (which doesn't serve /json/version).
 *
 * For auto-detect, call `session.connect()` with no args — it iterates
 * `detectBrowsers()` and picks the first browser whose WS accepts.
 */
export async function resolveWsUrl(opts: ConnectOptions): Promise<string> {
  if (opts.wsUrl) return opts.wsUrl;
  if (opts.profileDir) {
    const { port, path } = await readDevToolsActivePort(opts.profileDir);
    return `ws://127.0.0.1:${port}${path}`;
  }
  throw new Error('resolveWsUrl needs { wsUrl } or { profileDir }. For auto-detect, call session.connect() directly.');
}

/**
 * Parse both lines of DevToolsActivePort. Chrome writes:
 *   line 1: port number
 *   line 2: path (e.g. "/devtools/browser/<uuid>")
 * With both in hand we can build `ws://host:port<path>` with no HTTP probe.
 */
async function readDevToolsActivePort(profileDir: string): Promise<{ port: number; path: string }> {
  const deadline = Date.now() + 30_000;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const text = (await Bun.file(`${profileDir}/DevToolsActivePort`).text()).trim();
      const [portStr, path] = text.split('\n');
      const port = Number(portStr);
      if (!Number.isFinite(port)) throw new Error(`malformed port line: ${portStr}`);
      if (!path || !path.startsWith('/devtools/')) {
        // File is written atomically but path line may not be there on first open.
        throw new Error(`missing/invalid path line in DevToolsActivePort: ${JSON.stringify(text)}`);
      }
      return { port, path };
    } catch (e) {
      lastErr = e;
      await Bun.sleep(250);
    }
  }
  throw new Error(`Could not read ${profileDir}/DevToolsActivePort after 30s: ${lastErr}`);
}

/**
 * List page targets via CDP's `Target.getTargets` (works on all Chrome versions,
 * including those that do not serve /json). Filters out chrome:// and devtools://
 * internals. Requires the session to be connected already.
 */
export type PageTarget = { targetId: string; title: string; url: string; type: string };
export async function listPageTargets(session: Session): Promise<PageTarget[]> {
  const { targetInfos } = await session.domains.Target.getTargets({});
  return (targetInfos as PageTarget[]).filter(
    t => t.type === 'page' && !t.url.startsWith('chrome://') && !t.url.startsWith('devtools://')
  );
}

/**
 * Scan OS-specific user-data directories for Chromium-based browsers that
 * currently have remote debugging enabled (a `DevToolsActivePort` file exists
 * in the profile dir). Does NOT verify the WS endpoint is live — call
 * `verifyWsEndpoint(wsUrl)` on each entry if you need that.
 *
 * Ordered by DevToolsActivePort mtime descending, so the most-recently-
 * launched browser is first — that's the one `connect()` picks by default.
 *
 * This is the ONLY reliable connect method for Chrome 144+ with remote
 * debugging toggled from chrome://inspect — those browsers do NOT serve
 * `/json/version`, so port-probe discovery fails.
 */
export async function detectBrowsers(): Promise<DetectedBrowser[]> {
  const candidates = getBrowserCandidates();
  const detected: DetectedBrowser[] = [];
  for (const { name, profileDir } of candidates) {
    const parsed = await tryReadDevToolsActivePort(profileDir);
    if (!parsed) continue;
    detected.push({
      name,
      profileDir,
      port: parsed.port,
      wsPath: parsed.path,
      wsUrl: `ws://127.0.0.1:${parsed.port}${parsed.path}`,
      mtimeMs: parsed.mtimeMs,
    });
  }
  detected.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return detected;
}

type BrowserCandidate = { name: string; profileDir: string };

/** OS-specific user-data dirs for Chromium-based browsers, in rough popularity order. */
function getBrowserCandidates(): BrowserCandidate[] {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const list: BrowserCandidate[] = [];
  const push = (name: string, profileDir: string) => list.push({ name, profileDir });

  if (process.platform === 'darwin') {
    const base = `${home}/Library/Application Support`;
    push('Google Chrome',          `${base}/Google/Chrome`);
    push('Chromium',               `${base}/Chromium`);
    push('Microsoft Edge',         `${base}/Microsoft Edge`);
    push('Brave',                  `${base}/BraveSoftware/Brave-Browser`);
    push('Arc',                    `${base}/Arc/User Data`);
    push('Vivaldi',                `${base}/Vivaldi`);
    push('Opera',                  `${base}/com.operasoftware.Opera`);
    push('Comet',                  `${base}/Comet`);
    push('Google Chrome Canary',   `${base}/Google/Chrome Canary`);
  } else if (process.platform === 'linux') {
    const cfg = `${home}/.config`;
    push('Google Chrome',          `${cfg}/google-chrome`);
    push('Chromium',               `${cfg}/chromium`);
    push('Microsoft Edge',         `${cfg}/microsoft-edge`);
    push('Brave',                  `${cfg}/BraveSoftware/Brave-Browser`);
    push('Vivaldi',                `${cfg}/vivaldi`);
    push('Opera',                  `${cfg}/opera`);
    push('Google Chrome Canary',   `${cfg}/google-chrome-unstable`);
  } else if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? `${home}\\AppData\\Local`;
    push('Google Chrome',          `${local}\\Google\\Chrome\\User Data`);
    push('Chromium',               `${local}\\Chromium\\User Data`);
    push('Microsoft Edge',         `${local}\\Microsoft\\Edge\\User Data`);
    push('Brave',                  `${local}\\BraveSoftware\\Brave-Browser\\User Data`);
    push('Arc',                    `${local}\\Arc\\User Data`);
    push('Vivaldi',                `${local}\\Vivaldi\\User Data`);
    push('Opera',                  `${local}\\Opera Software\\Opera Stable`);
    push('Google Chrome Canary',   `${local}\\Google\\Chrome SxS\\User Data`);
  }
  return list;
}

/**
 * Read and parse `<profileDir>/DevToolsActivePort` once (no polling), returning
 * undefined if the file is missing or malformed. Also returns mtime so callers
 * can sort by recency.
 */
async function tryReadDevToolsActivePort(
  profileDir: string,
): Promise<{ port: number; path: string; mtimeMs: number } | undefined> {
  try {
    const file = Bun.file(`${profileDir}/DevToolsActivePort`);
    const [text, mtimeMs] = await Promise.all([file.text(), file.lastModified]);
    const [portStr, path] = text.trim().split('\n');
    const port = Number(portStr);
    if (!Number.isFinite(port)) return undefined;
    if (!path || !path.startsWith('/devtools/')) return undefined;
    return { port, path, mtimeMs: mtimeMs as number };
  } catch {
    return undefined;
  }
}

