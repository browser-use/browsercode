// browser_execute — Level-2 hook (decisions.md §1c).
//
// Adapter only. Substantive logic lives in @browser-use/bcode-browser/browser-execute.

import path from "path"
import { Effect, Schema } from "effect"
import { BrowserExecute } from "@browser-use/bcode-browser/browser-execute"
import { Global } from "@opencode-ai/core/global"
import { InstanceState } from "@/effect/instance-state"
import * as Tool from "./tool"
import DESCRIPTION from "./browser-execute.txt"

const MAX_METADATA_LENGTH = 30_000
const preview = (text: string) =>
  text.length <= MAX_METADATA_LENGTH ? text : "...\n\n" + text.slice(-MAX_METADATA_LENGTH)

// Per-project workspace where the agent saves reusable .ts scripts. Resolved
// from opencode's project-detection (Instance.directory) — same source that
// already finds .bcode/plans, .bcode/db, etc. Shared via clone (`.bcode/` is
// tracked-by-default, see hard rule #3) and isolated per project.
const workspaceDirOf = (projectDir: string) => path.join(projectDir, ".bcode", "agent-workspace")

export const BrowserExecuteTool = Tool.define(
  "browser_execute",
  Effect.gen(function* () {
    const impl = yield* BrowserExecute.make(Global.Path.data)
    return {
      // Substitute the resolved skills path so SKILL.md / interaction-skills
      // references in the description point at concrete locations. Workspace
      // is per-project and agent-discoverable from cwd, so it's not
      // substituted here.
      description: DESCRIPTION.replaceAll("{{SKILLS_DIR}}", impl.skillsDir),
      parameters: impl.parameters,
      execute: (args: Schema.Schema.Type<typeof impl.parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          // Permission gate. Default agent ruleset has `"*": "allow"` so this
          // auto-allows; users can opt out via bcode.json — either
          // `"tools": { "browser_execute": false }` or a per-permission rule.
          yield* ctx.ask({
            permission: "browser_execute",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })

          const instance = yield* InstanceState.context
          const workspaceDir = workspaceDirOf(instance.directory)

          const result = yield* impl.execute(args, {
            sessionID: ctx.sessionID,
            workspaceDir,
            // Stream chunks to the TUI as they arrive — same pattern as bash.
            onChunk: (output) =>
              ctx.metadata({
                metadata: { output: preview(output) },
              }),
          })
          // Drain every `Page.captureScreenshot` made during this snippet
          // into `attachments[]`. Opencode appends FilePart attachments to
          // the next assistant turn as image parts, so the model receives
          // the screenshot natively as vision input — no decode/write/read
          // dance from inside the snippet. Same channel `read` and
          // `webfetch` use when they surface images.
          const attachments = result.screenshots.map((s) => ({
            type: "file" as const,
            mime: s.mime,
            url: `data:${s.mime};base64,${s.base64}`,
          }))
          return {
            title: "browser_execute",
            output: [
              result.output.trimEnd(),
              result.result === "null" ? "" : `=> ${result.result}`,
              attachments.length > 0
                ? `(${attachments.length} screenshot${attachments.length === 1 ? "" : "s"} attached)`
                : "",
            ]
              .filter(Boolean)
              .join("\n\n"),
            metadata: { result: result.result, output: preview(result.output) },
            attachments,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
