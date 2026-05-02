# Vendor record — @browser-use/bcode-laminar

This package is a vendored, trimmed combination of two upstream sources, both
licensed Apache-2.0. Pulled once on **2026-05-02**; we do not maintain a
recurring sync — Laminar's plugin shape changes rarely, and the OpenTelemetry
contract is stable. Re-pull only when a behavior fix or new attribute is
worth chasing.

## Sources

| Upstream | Commit | License |
|---|---|---|
| [`lmnr-ai/lmnr-opencode-plugin`](https://github.com/lmnr-ai/lmnr-opencode-plugin) | `bb2fceaff0d2b52161fb1c8a477a50b0b4789a0e` (v0.1.2) | Apache-2.0 |
| [`lmnr-ai/lmnr-ts`](https://github.com/lmnr-ai/lmnr-ts) (selected files from `packages/lmnr/src/opentelemetry-lib/`) | `5ebe07a6284ce0bbfebcf10bdd9d1faa04ed6c64` (v0.8.22) | Apache-2.0 |

## File mapping

| `src/<file>.ts` | Upstream origin |
|---|---|
| `plugin.ts` | `lmnr-opencode-plugin/src/index.ts` |
| `processor.ts` | merged: `lmnr-opencode-plugin/src/processor.ts` + base class from `lmnr-ts/.../tracing/processor.ts` |
| `exporter.ts` | `lmnr-ts/.../tracing/exporter.ts` |
| `span.ts` | `Laminar.startSpan` extracted from `lmnr-ts/src/laminar.ts` |
| `attributes.ts` | `lmnr-ts/.../tracing/attributes.ts` (subset) |
| `compat.ts` | `lmnr-ts/.../tracing/compat.ts` |
| `state.ts` | `lmnr-opencode-plugin/src/state.ts` (dropped `sessionExternalContexts` — TS host injection isn't relevant for bcode) |
| `utils.ts` | UUID helpers from `lmnr-ts/src/utils.ts` |

## Behavior trims (vs upstream)

- **No `LaminarClient` "rollout sessions"** — `LMNR_ROLLOUT_SESSION_ID` branch removed. We don't use that feature.
- **No HTTP/protobuf exporter fallback** — gRPC only. Drops `@opentelemetry/exporter-trace-otlp-proto`.
- **No `parseOtelHeaders` / `OTEL_HEADERS` resolution** — we always have a Laminar API key when emitting; OTel-env paths are dead.
- **No `pino` logger** — log via `client.app.log` (opencode-managed).
- **No `loadEnv()`** — opencode loads `.env` already; second pass would surprise users.
- **No caller-side context injection (`sessionExternalContexts`)** — bcode runs the agent locally, not driven by an external TS host.
- **`Laminar.startSpan` reduced** — only the path needed for the per-turn span (sessionId + optional parentSpanContext); no `tracingLevel`, masked-input, or process-global activation stack.

## Behavior preserved

- `lmnr.span.path` / `lmnr.span.ids_path` ancestor stamping (Laminar UI nests by these, not by OTel parentSpanId).
- OTel SDK v1/v2 compat shim (`makeSpanOtelV2Compatible`).
- Per-`chat.message` "turn" span lifecycle, ended on `session.idle` / `session.deleted`.
- Sub-agent tagging: spans created inside the `task` tool tag descendants with `lmnr.spawning_subagent.tool_use_id`.
- gRPC bearer-token auth to `${LMNR_BASE_URL}:${LMNR_GRPC_PORT}`.

## Maintenance protocol

If/when we re-pull:

1. Clone both upstreams at the new tag.
2. Diff each vendored file against its origin; bring across only behavior changes (not stylistic / build / dep churn).
3. Update the commit hashes above; bump `version` in `package.json` only if behavior changed.
4. Re-verify the smoke flow (see PR description).

Do not introduce a `dependencies` entry on `@lmnr-ai/lmnr` or `@lmnr-ai/opencode-plugin` — vendoring is the point.
