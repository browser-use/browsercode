import { expect, test } from "bun:test"
import { SessionStore } from "../src/session-store"

test("shares and releases a live CDP session without closing the parent", () => {
  const parentID = crypto.randomUUID()
  const expertID = crypto.randomUUID()
  const parent = SessionStore.get(parentID)

  SessionStore.share(parentID, expertID)
  expect(SessionStore.get(expertID)).toBe(parent)

  SessionStore.forget(expertID)
  expect(SessionStore.get(parentID)).toBe(parent)
  expect(SessionStore.get(expertID)).not.toBe(parent)
})
