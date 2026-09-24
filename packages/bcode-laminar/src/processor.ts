// Vendored span processor for the Laminar OpenCode integration.
// Folds two upstream classes into one:
//
//  - `LaminarSpanProcessor` from lmnr-ts/packages/lmnr/src/opentelemetry-lib/tracing/processor.ts
//    Stamps `lmnr.span.path` / `lmnr.span.ids_path` ancestor-attribute pairs
//    that the Laminar UI uses to nest spans (it does NOT nest by OTel parentSpanId).
//
//  - `OpenCodeLaminarSpanProcessor` from lmnr-opencode-plugin/src/processor.ts
//    Re-parents AI-SDK spans onto the per-session "turn" span by reading
//    `ai.telemetry.metadata.sessionId` off span attributes; tags spans created
//    inside the `task` tool so sub-agent traces link back to the parent's tool call.
//
// Trims (vs. upstream LaminarSpanProcessor):
//  - LMNR_ROLLOUT_SESSION_ID branch (LaminarClient sendSpanUpdate path) — unused here.
//  - parseOtelHeaders / OTEL_HEADERS env path — we always have an LMNR project key.
//  - `forceHttp` HTTP/protobuf exporter — gRPC only.
//  - `pino` logger — opencode plugins log via `client.app.log`; the plugin passes
//    in a logger callback.

import { type Context, type Span, SpanStatusCode, TraceFlags, trace } from "@opentelemetry/api"
import { ExportResultCode } from "@opentelemetry/core"
import {
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base"

import {
  PARENT_SPAN_IDS_PATH,
  PARENT_SPAN_PATH,
  SPAN_IDS_PATH,
  SPAN_INSTRUMENTATION_SOURCE,
  SPAN_PATH,
  SPAN_SDK_VERSION,
} from "./attributes"
import { getParentSpanId, makeSpanOtelV2Compatible, type OTelSpanCompat } from "./compat"
import { boundedSpan, encodedBytes, QUEUE_BYTES, QUEUE_RECORDS } from "./budget"
import { sessionCurrentTurnSpan } from "./state"
import { otelSpanIdToUUID, type StringUUID } from "./utils"

const SDK_VERSION = "bcode-laminar-0.1"
const SPAWNING_TOOL_NAMES = ["task"]
const TOOL_ERROR = "bcode.tool.error"
type LogFn = (level: "debug" | "info" | "warn" | "error", message: string) => void

export class OpenCodeLaminarSpanProcessor implements SpanProcessor {
  private inner: BatchSpanProcessor
  private pendingBytes = 0
  private pendingRecords = 0
  private sizes = new WeakMap<ReadableSpan, number>()
  private readonly spanIdToPath = new Map<string, string[]>()
  private readonly spanIdLists = new Map<string, StringUUID[]>()
  private readonly spawningSpanIdToToolUseId: Record<string, string> = {}
  private readonly log: LogFn

  constructor(options: { exporter: SpanExporter; log?: LogFn }) {
    this.inner = new BatchSpanProcessor(
      {
        export: (spans, callback) => {
          let completed = false
          const finish: typeof callback = (result) => {
            if (completed) return
            completed = true
            for (const span of spans) {
              this.pendingBytes -= this.sizes.get(span) ?? 0
              this.pendingRecords--
              this.sizes.delete(span)
            }
            callback(result)
          }
          try {
            options.exporter.export(spans, finish)
          } catch {
            finish({ code: ExportResultCode.FAILED, error: new Error("Diagnostic export failed") })
          }
        },
        shutdown: () => options.exporter.shutdown(),
        forceFlush: () => options.exporter.forceFlush?.() ?? Promise.resolve(),
      },
      {
        // Sixteen 64 KiB records fit in 1 MiB, including each record's OTLP envelope.
        maxExportBatchSize: 16,
        maxQueueSize: QUEUE_RECORDS,
        exportTimeoutMillis: 10000,
      },
    )
    this.log = options.log ?? (() => {})
  }

  forceFlush() {
    return this.inner.forceFlush()
  }

  shutdown() {
    return this.inner.shutdown()
  }

  onStart(spanArg: any, parentContext: Context): void {
    const span = spanArg as OTelSpanCompat

    // 1. Re-parent AI-SDK spans onto the live "turn" span for this opencode
    //    session, so each turn becomes its own Laminar trace instead of a
    //    forest of orphan traces.
    const sessionId = span.attributes?.["ai.telemetry.metadata.sessionId"] as string | undefined
    let ctx = parentContext
    if (sessionId && typeof sessionId === "string") {
      const parentSpanContext = sessionCurrentTurnSpan[sessionId]?.spanContext()
      const parentSpanId = getParentSpanId(span)
      if (parentSpanContext && !parentSpanId) {
        ctx = trace.setSpan(ctx, trace.wrapSpanContext(parentSpanContext))
        // OTel SDK v1 (parentSpanId) and v2 (parentSpanContext) both need patching.
        Object.assign(span, { parentSpanContext })
        Object.assign(span, { parentSpanId: parentSpanContext.spanId })
        const spanContext = span.spanContext()
        Object.assign(spanContext, { ...spanContext, traceId: parentSpanContext.traceId })
        Object.assign(spanContext, { _spanContext: spanContext })
      }
    }

    // 2. Track `task`-tool spans so any descendant sub-agent span can be
    //    tagged with its tool-use id (links sub-agent traces to parent).
    const toolCallId = span.attributes?.["ai.toolCall.id"] as string | undefined
    if (toolCallId) {
      const toolCallNameAttr = span.attributes?.["ai.toolCall.name"] as string | undefined
      if (
        SPAWNING_TOOL_NAMES.includes(span.name) ||
        (span.name === "ai.toolCall" && toolCallNameAttr && SPAWNING_TOOL_NAMES.includes(toolCallNameAttr))
      ) {
        this.spawningSpanIdToToolUseId[otelSpanIdToUUID(span.spanContext().spanId)] = toolCallId
      }
    }

    // 3. Stamp Laminar's path attributes. The UI nests by these, NOT by
    //    OTel parentSpanId — must run for every span.
    const parentPathFromAttribute = span.attributes?.[PARENT_SPAN_PATH] as string[] | undefined
    const parentIdsPathFromAttribute = span.attributes?.[PARENT_SPAN_IDS_PATH] as StringUUID[] | undefined
    const parentSpanId = getParentSpanId(span)
    const parentSpanPath =
      parentPathFromAttribute ?? (parentSpanId !== undefined ? this.spanIdToPath.get(parentSpanId) : undefined)
    const parentSpanIdsPath =
      parentIdsPathFromAttribute ?? (parentSpanId !== undefined ? this.spanIdLists.get(parentSpanId) : [])

    const spanId = span.spanContext().spanId
    const spanPath = parentSpanPath ? [...parentSpanPath, span.name] : [span.name]
    const spanIdUuid = otelSpanIdToUUID(spanId)
    const spanIdsPath = parentSpanIdsPath ? [...parentSpanIdsPath, spanIdUuid] : [spanIdUuid]

    span.setAttribute(SPAN_IDS_PATH, spanIdsPath)
    span.setAttribute(SPAN_PATH, spanPath)
    span.setAttribute(SPAN_INSTRUMENTATION_SOURCE, "javascript")
    span.setAttribute(SPAN_SDK_VERSION, SDK_VERSION)
    this.spanIdLists.set(spanId, spanIdsPath)
    this.spanIdToPath.set(spanId, spanPath)

    // 4. If this span descends from a tracked spawning tool call, tag it.
    if (spanIdsPath.length > 0) {
      let spawningToolCallSpanId: StringUUID | undefined
      for (let i = spanIdsPath.length - 1; i >= 0; i--) {
        const candidate = spanIdsPath[i]!
        if (this.spawningSpanIdToToolUseId[candidate] !== undefined) {
          spawningToolCallSpanId = candidate
          break
        }
      }
      if (spawningToolCallSpanId) {
        span.setAttributes({
          "lmnr.spawning_subagent.span_id": spawningToolCallSpanId,
          "lmnr.spawning_subagent.tool_use_id": this.spawningSpanIdToToolUseId[spawningToolCallSpanId]!,
        })
      }
    }

    makeSpanOtelV2Compatible(span)
    this.inner.onStart(span, ctx)
  }

  onEnd(span: ReadableSpan): void {
    // A tool that throws is normal agent flow, not a failed run: the model
    // reads the `tool-error` result and adapts. The AI SDK still stamps ERROR
    // on the `ai.toolCall` span (`recordErrorOnSpan`), and Laminar reds a
    // whole trace if ANY of its spans is ERROR — so every run where the model
    // wrote one buggy `browser_execute` snippet was reported as a failure.
    // Demote to UNSET, keeping the message as an attribute and the recorded
    // `exception` event untouched. Only the `turn` span decides run outcome.
    //
    // Mutated in place because `setStatus`/`setAttribute` are no-ops once the
    // span has ended, which it has by the time onEnd runs.
    if (span.attributes["ai.toolCall.id"] && span.status.code === SpanStatusCode.ERROR) {
      Object.assign(span.attributes, { [TOOL_ERROR]: span.status.message ?? "" })
      Object.assign(span, { status: { code: SpanStatusCode.UNSET } })
    }

    const spanId = span.spanContext().spanId
    this.spanIdLists.delete(spanId)
    this.spanIdToPath.delete(spanId)
    // spawningSpanIdToToolUseId is keyed by UUID (matches `lmnr.span.ids_path`
    // entries that the descendant scan iterates), not by the raw hex span id.
    delete this.spawningSpanIdToToolUseId[otelSpanIdToUUID(spanId)]
    makeSpanOtelV2Compatible(span)
    if (!(span.spanContext().traceFlags & TraceFlags.SAMPLED)) return
    const bounded = boundedSpan(span)
    const size = bounded ? encodedBytes([bounded]) : 0
    if (!bounded || this.pendingBytes + size > QUEUE_BYTES || this.pendingRecords >= QUEUE_RECORDS) {
      this.log("warn", "Diagnostic span dropped: telemetry memory budget")
      return
    }
    makeSpanOtelV2Compatible(bounded)
    this.sizes.set(bounded, size)
    this.pendingBytes += size
    this.pendingRecords++
    this.inner.onEnd(bounded)
  }
}
