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
Path(args.result).with_name("final_result.txt").write_text("Reached the requested page.\\n")
Path(args.result).write_text(json.dumps({
    "schema_version": 1,
    "delegation_id": request["delegation_id"],
    "status": "completed",
    "done_when": request["done_when"],
    "summary": "Reached the requested page.",
    "result_artifact": "final_result.txt",
    "result_length_chars": 27,
    "result_truncated": False,
    "action_digest": ["input_text, click"],
    "action_details": ["step 1: {\\"input\\":{\\"text\\":\\"10019\\"}}"],
    "extracted_content": ["Ground rate: $18.42"],
    "done_condition_claimed": True,
    "initial_url": "https://example.com/form",
    "initial_title": "Rate form",
    "final_url": "https://example.com/results",
    "observed_state_after": {
        "target_id": request["target_id"],
        "url": "https://example.com/results",
        "title": "Rate results",
        "tabs": [],
        "page_excerpt": "Ground rate: $18.42",
        "page_excerpt_truncated": False,
        "screenshot_artifact": None,
        "captured_at": "2026-07-28T00:00:00+00:00",
        "capture_error": None,
    },
    "blocker": None,
    "uncertainties": [],
    "metrics": {
        "duration_seconds": 1.25,
        "steps": 1,
        "actions": 2,
        "cost_usd": 0.01,
        "total_tokens": 100,
    },
    "artifacts": ["request.json", "final_result.txt", "result.json"],
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
        originalTask: "Find the displayed shipping price for this route.",
      },
    ),
  )

  expect(result.status).toBe("completed")
  expect(result.action_digest).toEqual(["input_text, click"])
  expect(result.done_when).toBe("Result cards are visible.")
  expect(result.result_artifact).toBe("final_result.txt")
  expect(result.observed_state_after?.page_excerpt).toContain("$18.42")
  expect(result.artifact_directory).toBe(path.join(directory, "delegations", "call_test"))
  expect(
    JSON.parse(await fs.readFile(path.join(directory, "delegations", "call_test", "request.json"), "utf8")),
  ).toMatchObject({
    delegation_id: "call_test",
    parent_session_id: "session_test",
    target_id: "target_test",
    original_task: "Find the displayed shipping price for this route.",
    limits: { max_steps: 15, max_actions_per_step: 3, timeout_seconds: 300 },
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
  } finally {
    if (previousDelegateKey === undefined) delete process.env.BROWSER_USE_DELEGATE_API_KEY
    else process.env.BROWSER_USE_DELEGATE_API_KEY = previousDelegateKey
    if (previousApiKey === undefined) delete process.env.BROWSER_USE_API_KEY
    else process.env.BROWSER_USE_API_KEY = previousApiKey
  }
})

test("allows a newly planned delegation after a failed episode on the same tab", async () => {
  const indexPath = path.join(directory, "blocked-delegations.json")
  await fs.writeFile(
    indexPath,
    JSON.stringify([{ delegation_id: "prior", target_id: "target_blocked", status: "gave_up", steps: 3 }]),
  )

  const result = await Effect.runPromise(
    BrowserDelegate.execute(
      {
        task: "Complete a newly planned browser portion from the current state.",
        done_when: "The newly planned portion is complete.",
      },
      {
        delegationID: "call_replanned",
        parentSessionID: "session_test",
        targetID: "target_blocked",
        artifactRoot: path.join(directory, "blocked-delegations"),
        indexPath,
        apiKey: "test-key",
        originalTask: "Complete the broader workflow.",
      },
    ),
  )

  expect(result.status).toBe("completed")
  expect(JSON.parse(await fs.readFile(indexPath, "utf8"))).toEqual([
    expect.objectContaining({ delegation_id: "prior", status: "gave_up" }),
    expect.objectContaining({ delegation_id: "call_replanned", status: "completed" }),
  ])
})

test("caps total delegation episodes across a task", async () => {
  const indexPath = path.join(directory, "budgeted-delegations.json")
  await fs.writeFile(
    indexPath,
    JSON.stringify(
      Array.from({ length: 4 }, (_, index) => ({
        delegation_id: `prior-${index}`,
        target_id: `target-${index}`,
        status: "completed",
        steps: 5,
      })),
    ),
  )

  await expect(
    Effect.runPromise(
      BrowserDelegate.execute(
        {
          task: "Run a fifth browser episode.",
          done_when: "The fifth episode is complete.",
        },
        {
          delegationID: "call_over_budget",
          parentSessionID: "session_test",
          targetID: "target-new",
          artifactRoot: path.join(directory, "budgeted-delegations"),
          indexPath,
          apiKey: "test-key",
          originalTask: "Complete a broad multi-part workflow.",
        },
      ),
    ),
  ).rejects.toThrow("4-episode task budget")
})

test("uses only the remaining child-step budget for the final episode", async () => {
  const indexPath = path.join(directory, "remaining-step-budget.json")
  await fs.writeFile(
    indexPath,
    JSON.stringify([
      {
        delegation_id: "prior",
        target_id: "target-prior",
        status: "completed",
        steps: 40,
      },
    ]),
  )

  await Effect.runPromise(
    BrowserDelegate.execute(
      {
        task: "Use the remaining budget.",
        done_when: "The bounded episode is complete.",
      },
      {
        delegationID: "call_remaining",
        parentSessionID: "session_test",
        targetID: "target-new",
        artifactRoot: path.join(directory, "remaining-step-delegations"),
        indexPath,
        apiKey: "test-key",
        originalTask: "Complete a broad multi-part workflow.",
      },
    ),
  )

  expect(
    JSON.parse(
      await fs.readFile(path.join(directory, "remaining-step-delegations", "call_remaining", "request.json"), "utf8"),
    ),
  ).toMatchObject({
    limits: { max_steps: 5 },
  })
})
