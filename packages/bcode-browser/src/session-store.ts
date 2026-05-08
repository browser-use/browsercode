// Process-scope per-opencode-session CDP Session map.
//
// `browser_execute` looks up a `Session` keyed by `sessionID` so that calls
// to `session.connect(...)` made inside one snippet persist across later
// snippets in the same opencode session — the agent connects once, drives
// many. The Session is a single CDP transport (one WebSocket); the agent
// is the source of truth for which browser is on the other end.
//
// Lifetime: Sessions live for the life of the opencode process. The
// underlying WebSocket closes naturally when the browser exits. The agent
// can also close explicitly from a snippet (`await session.close()`) — for
// instance, before reconnecting to a different browser.
//
// `evict(sessionID)` is exposed for tests to clean up between cases. It
// closes the Session and removes the entry. Production code does not need
// to call it; sessions are cheap and the process will exit eventually.

import { Session } from "./cdp/session"

const sessions = new Map<string, Session>()

export const get = (sessionID: string): Session => {
  const existing = sessions.get(sessionID)
  if (existing) return existing
  const fresh = new Session()
  sessions.set(sessionID, fresh)
  return fresh
}

export const evict = async (sessionID: string): Promise<void> => {
  const entry = sessions.get(sessionID)
  if (!entry) return
  sessions.delete(sessionID)
  entry.close()
}

export * as SessionStore from "./session-store"
