import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect } from "effect"
import { BrowserDelegate } from "../src/browser-delegate"

let directory: string
let runner: string
const previousRunner = process.env.BROWSER_USE_DELEGATE_RUNNER
const previousCdp = process.env.BU_CDP_WS

beforeAll(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "bcode-delegate-"))
  runner = path.join(directory, "fake_runner.py")
  await fs.writeFile(
    runner,
    `
import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--request", required=True)
parser.add_argument("--result", required=True)
args = parser.parse_args()
request = json.loads(Path(args.request).read_text())
Path(args.result).write_text(json.dumps({
    "schema_version": 1,
    "delegation_id": request["delegation_id"],
    "status": "completed",
    "summary": "Reached the requested page.",
    "action_digest": ["input_text, click"],
    "done_condition_claimed": True,
    "final_url": "https://example.com/results",
    "blocker": None,
    "uncertainties": [],
    "metrics": {
        "duration_seconds": 1.25,
        "steps": 1,
        "actions": 2,
        "cost_usd": 0.01,
        "total_tokens": 100,
    },
    "artifacts": ["request.json", "result.json"],
    "trace_id": None,
}) + "\\n")
`,
  )
  process.env.BROWSER_USE_DELEGATE_RUNNER = runner
  process.env.BU_CDP_WS = "ws://127.0.0.1:9222/devtools/browser/test"
})

afterAll(async () => {
  if (previousRunner === undefined) delete process.env.BROWSER_USE_DELEGATE_RUNNER
  else process.env.BROWSER_USE_DELEGATE_RUNNER = previousRunner
  if (previousCdp === undefined) delete process.env.BU_CDP_WS
  else process.env.BU_CDP_WS = previousCdp
  await fs.rm(directory, { recursive: true, force: true })
})

test("persists a compact delegation receipt and top-level index", async () => {
  const result = await Effect.runPromise(
    BrowserDelegate.execute(
      {
        task: "Enter the postcode and search.",
        done_when: "Result cards are visible.",
      },
      {
        delegationID: "call_test",
        parentSessionID: "session_test",
        targetID: "target_test",
        artifactRoot: path.join(directory, "delegations"),
        indexPath: path.join(directory, "delegations.json"),
        apiKey: "test-key",
      },
    ),
  )

  expect(result.status).toBe("completed")
  expect(result.action_digest).toEqual(["input_text, click"])
  expect(result.artifact_directory).toBe(path.join(directory, "delegations", "call_test"))
  expect(
    JSON.parse(await fs.readFile(path.join(directory, "delegations", "call_test", "request.json"), "utf8")),
  ).toMatchObject({
    delegation_id: "call_test",
    parent_session_id: "session_test",
    target_id: "target_test",
    limits: { max_steps: 8, max_actions_per_step: 3, timeout_seconds: 120 },
  })
  expect(JSON.parse(await fs.readFile(path.join(directory, "delegations.json"), "utf8"))).toEqual([
    expect.objectContaining({
      delegation_id: "call_test",
      status: "completed",
    }),
  ])
})

test("enables delegation only when the shared browser and leaf model are configured", () => {
  const previousDelegateKey = process.env.BROWSER_USE_DELEGATE_API_KEY
  const previousApiKey = process.env.BROWSER_USE_API_KEY
  try {
    delete process.env.BROWSER_USE_DELEGATE_API_KEY
    delete process.env.BROWSER_USE_API_KEY
    expect(BrowserDelegate.enabled()).toBe(false)
    process.env.BROWSER_USE_DELEGATE_API_KEY = "test-key"
    expect(BrowserDelegate.enabled()).toBe(true)
    expect(BrowserDelegate.routingPolicy).toContain("call browser_delegate as the first browser tool")
  } finally {
    if (previousDelegateKey === undefined) delete process.env.BROWSER_USE_DELEGATE_API_KEY
    else process.env.BROWSER_USE_DELEGATE_API_KEY = previousDelegateKey
    if (previousApiKey === undefined) delete process.env.BROWSER_USE_API_KEY
    else process.env.BROWSER_USE_API_KEY = previousApiKey
  }
})
