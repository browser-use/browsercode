import { describe, expect, test } from "bun:test"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { Global } from "@opencode-ai/core/global"
import { InstallationChannel } from "@opencode-ai/core/installation/version"

describe("Database.path", () => {
  test("uses BrowserCode database filenames", () => {
    delete process.env.OPENCODE_DISABLE_CHANNEL_DB

    expect(Database.path()).toBe(
      ["latest", "beta", "prod"].includes(InstallationChannel)
        ? path.join(Global.Path.data, "bcode.db")
        : path.join(Global.Path.data, `bcode-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`),
    )

    process.env.OPENCODE_DISABLE_CHANNEL_DB = "1"
    expect(Database.path()).toBe(path.join(Global.Path.data, "bcode.db"))
    delete process.env.OPENCODE_DISABLE_CHANNEL_DB
  })
})
