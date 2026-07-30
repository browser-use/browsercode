// LaminarPlugin — opencode-side hook wiring.
//
// Vendored and trimmed from lmnr-opencode-plugin/src/index.ts.
// Differences vs upstream:
//   - No loadEnv() — opencode loads .env / .env.local already.
//   - No external-context (caller-side) injection path; we don't ship a TS host.
//   - log fallback is a no-op (no console.log; the TUI owns stdout).
//
// First-run notice is intentionally short and non-alarming. Industry standard
// for telemetry disclosure is one line referencing DO_NOT_TRACK; that lives in
// README and runs once on key application via the bcode-browser telemetry
// module, not here.

import type { Plugin } from "@opencode-ai/plugin"
import { NodeSDK } from "@opentelemetry/sdk-node"

import { createSpanExporter } from "./exporter"
import { OpenCodeLaminarSpanProcessor } from "./processor"
import { startTurnSpan } from "./span"
import { parentSessionID, sessionCurrentTurnSpan, subagentSessionIds } from "./state"

const DEFAULT_GRPC_PORT_LMNR = 8443
const DEFAULT_GRPC_PORT_GENERIC = 443

const parsePort = (raw: string | undefined, fallback: number): number => {
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : fallback
}

export const LaminarPlugin: Plugin = ({ client }) => {
  const projectApiKey = process.env.LMNR_PROJECT_API_KEY
  // OTel-standard endpoint env vars opt into OTLP/HTTP+protobuf — used by
  // OSS users routing to non-Laminar collectors (Honeycomb, Tempo, Jaeger),
  // and by the V4 cloud worker which relays through a backend that holds
  // the real Laminar key. Either env var alone (without LMNR_PROJECT_API_KEY)
  // is sufficient to enable tracing.
  // `||` (not `??`) so an empty-string signal-specific override falls back
  // to the generic endpoint, matching OTel SDK convention (empty == unset).
  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  const baseUrl = process.env.LMNR_BASE_URL ?? "https://api.lmnr.ai"
  const port = parsePort(
    process.env.LMNR_GRPC_PORT,
    baseUrl === "https://api.lmnr.ai" ? DEFAULT_GRPC_PORT_LMNR : DEFAULT_GRPC_PORT_GENERIC,
  )
  // When set, every "turn" span this plugin starts is parented under the
  // given Laminar span context. Used by external evaluation harnesses that
  // spawn bcode as a subprocess and want the agent's traces to nest under
  // their own evaluation span (one trace per task, judge + agent siblings).
  // Format: JSON serialization of LaminarSpanContext (snake_case or camelCase
  // keys both accepted by parseLaminarSpanContext in span.ts).
  const parentSpanContext = process.env.LMNR_PARENT_SPAN_CONTEXT

  const log = (level: "debug" | "info" | "warn" | "error", message: string) => {
    client.app.log({ body: { service: "laminar", level, message } }).catch(() => {})
  }

  if (!projectApiKey && !otlpEndpoint) return Promise.resolve({})

  const processor = new OpenCodeLaminarSpanProcessor({
    exporter: createSpanExporter({ apiKey: projectApiKey ?? "", baseUrl, port }),
    log,
  })

  const sdk = new NodeSDK({ spanProcessors: [processor] })
  sdk.start()
  log("info", `Laminar tracing initialized → ${otlpEndpoint ?? baseUrl}`)

  // Track forceFlush() Promises kicked off by bus event handlers
  // (session.idle, session.deleted). Each is fire-started by the handler
  // but the host doesn't await them — they're orphan microtasks. If
  // `process.exit()` fires before they resolve, in-flight OTLP HTTP
  // requests die and the span is dropped server-side.
  //
  // The sync shutdown hook awaits this set before returning so the host's
  // `Promise.race([hooks, 3s])` race can let the export actually finish.
  const pendingFlushes = new Set<Promise<void>>()
  const trackFlush = (p: Promise<void> | undefined): void => {
    if (!p) return
    const wrapped = p.catch(() => {}).finally(() => pendingFlushes.delete(wrapped))
    pendingFlushes.add(wrapped)
  }

  return Promise.resolve({
    config: async (config) => {
      if (!config.experimental?.openTelemetry) {
        config.experimental = { ...config.experimental, openTelemetry: true }
      }
    },
    // End-of-process drain. The host calls this from its top-level finally
    // before `process.exit()`. Awaits any forceFlush Promises kicked off by
    // bus event handlers (session.idle, session.deleted) — those are orphan
    // microtasks from the host's perspective and `process.exit()` would kill
    // their in-flight OTLP HTTP exports otherwise. Host bounds this with
    // `Promise.race([hooks, 3000ms])` so a wedged exporter cannot hang exit.
    shutdown: async () => {
      for (const sessionId of Object.keys(sessionCurrentTurnSpan)) {
        const span = sessionCurrentTurnSpan[sessionId]
        if (!span) continue
        span.end()
        delete sessionCurrentTurnSpan[sessionId]
      }
      trackFlush(processor.forceFlush())
      await Promise.all(Array.from(pendingFlushes))
    },
    event: async ({ event }) => {
      switch (event.type) {
        case "session.idle": {
          const sessionId = event.properties.sessionID
          const span = sessionCurrentTurnSpan[sessionId]
          if (span) {
            span.end()
            delete sessionCurrentTurnSpan[sessionId]
          }
          // Track the flush Promise so the shutdown hook can await it before
          // `process.exit()`. Fire-and-forget from this fiber's POV.
          trackFlush(processor.forceFlush())
          break
        }
        case "server.instance.disposed": {
          // End any turn spans still open so they're queued before the host
          // calls our `shutdown` hook. Do NOT call `sdk.shutdown()` here —
          // it unregisters the global TracerProvider and closes the BSP,
          // both observed to fire mid-await in headless `bcode run` mode
          // and silently drop the just-ended turn span. The shutdown hook
          // is the single drain point.
          for (const [sessionId, span] of Object.entries(sessionCurrentTurnSpan)) {
            span.end()
            delete sessionCurrentTurnSpan[sessionId]
          }
          for (const key of Object.keys(subagentSessionIds)) delete subagentSessionIds[key]
          break
        }
        case "session.created":
        case "session.updated":
          if (event.properties.info.parentID) {
            const parentId = event.properties.info.parentID
            if (!subagentSessionIds[parentId]) subagentSessionIds[parentId] = new Set()
            subagentSessionIds[parentId].add(event.properties.info.id)
          }
          break
        case "session.deleted": {
          const sessionId = event.properties.info.id
          const span = sessionCurrentTurnSpan[sessionId]
          if (span) {
            span.end()
            delete sessionCurrentTurnSpan[sessionId]
          }
          delete subagentSessionIds[sessionId]
          for (const children of Object.values(subagentSessionIds)) children.delete(sessionId)
          trackFlush(processor.forceFlush())
          break
        }
      }
    },
    "chat.message": async (input, output) => {
      const { sessionID, agent, model, messageID, variant } = input
      if (sessionCurrentTurnSpan[sessionID]) return
      const parentID = parentSessionID(sessionID)
      const parentSpan = parentID ? sessionCurrentTurnSpan[parentID] : undefined

      const span = startTurnSpan({
        name: parentID ? "subagent" : "turn",
        sessionId: sessionID,
        parentSpan,
        parentSpanContext: parentSpan ? undefined : parentSpanContext,
        input: {
          sessionID,
          agent,
          model,
          messageID,
          variant,
          message: output.message,
          parts: output.parts,
        },
      })
      sessionCurrentTurnSpan[sessionID] = span
    },
  })
}
