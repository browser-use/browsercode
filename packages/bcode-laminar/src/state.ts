// Vendored from lmnr-opencode-plugin/src/state.ts.
// Module-level maps shared by plugin.ts and processor.ts:
// - sessionCurrentTurnSpan: session id -> live "turn" span the AI-SDK spans nest under.
// - subagentSessionIds: parent session id -> set of child (sub-agent) session ids.
//   Used to skip turn-span creation for sub-agent prompts.
// - spawningToolSpanContexts: tool call id -> serialized Laminar context for a
//   live tool span that launches an independently instrumented child process.

import type { Span } from "@opentelemetry/api"

export const sessionCurrentTurnSpan: Record<string, Span> = {}
export const subagentSessionIds: Record<string, Set<string>> = {}
export const spawningToolSpanContexts: Record<string, string> = {}
