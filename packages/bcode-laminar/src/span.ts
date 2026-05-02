// Minimal subset of Laminar.startSpan from
// lmnr-ts/packages/lmnr/src/laminar.ts. We only need to start a "turn" span
// per chat.message event with sessionId association, optional parent span
// context (for callers driving opencode programmatically), and an input
// payload. No tracing-level, masked-input, global-context-stack, or
// active-span machinery — opencode owns its own trace lifecycle.

import { type Context, ROOT_CONTEXT, type Span, trace, TraceFlags } from "@opentelemetry/api"

import {
  PARENT_SPAN_IDS_PATH,
  PARENT_SPAN_PATH,
  SESSION_ID,
  SPAN_INPUT,
  SPAN_TYPE,
} from "./attributes"
import { isStringUUID, type StringUUID, uuidToOtelSpanId, uuidToOtelTraceId } from "./utils"

const TURN_TRACER_NAME = "@browser-use/bcode-laminar"

export const startTurnSpan = (opts: {
  name: string
  sessionId: string
  parentSpanContext?: string
  input?: unknown
}): Span => {
  let ctx: Context = ROOT_CONTEXT
  let parentPath: string[] | undefined
  let parentIdsPath: StringUUID[] | undefined

  if (opts.parentSpanContext) {
    const parsed = parseLaminarSpanContext(opts.parentSpanContext)
    if (parsed) {
      parentPath = parsed.spanPath
      parentIdsPath = parsed.spanIdsPath
      ctx = trace.setSpan(
        ctx,
        trace.wrapSpanContext({
          traceId: uuidToOtelTraceId(parsed.traceId),
          spanId: uuidToOtelSpanId(parsed.spanId),
          isRemote: parsed.isRemote,
          traceFlags: TraceFlags.SAMPLED,
        }),
      )
    }
  }

  const attributes: Record<string, any> = {
    [SPAN_TYPE]: "DEFAULT",
    [SESSION_ID]: opts.sessionId,
    ...(parentPath ? { [PARENT_SPAN_PATH]: parentPath } : {}),
    ...(parentIdsPath ? { [PARENT_SPAN_IDS_PATH]: parentIdsPath } : {}),
  }
  if (opts.input !== undefined) attributes[SPAN_INPUT] = JSON.stringify(opts.input)

  return trace.getTracer(TURN_TRACER_NAME).startSpan(opts.name, { attributes }, ctx)
}

type ParsedSpanContext = {
  traceId: string
  spanId: string
  isRemote: boolean
  spanPath?: string[]
  spanIdsPath?: StringUUID[]
}

const parseLaminarSpanContext = (input: string): ParsedSpanContext | undefined => {
  try {
    const record = JSON.parse(input)
    const traceId = record.traceId ?? record.trace_id
    const spanId = record.spanId ?? record.span_id
    if (typeof traceId !== "string" || typeof spanId !== "string") return undefined
    if (!isStringUUID(traceId) || !isStringUUID(spanId)) return undefined
    const spanPath = Array.isArray(record.spanPath ?? record.span_path)
      ? (record.spanPath ?? record.span_path)
      : undefined
    const spanIdsPathRaw = record.spanIdsPath ?? record.span_ids_path
    const spanIdsPath =
      Array.isArray(spanIdsPathRaw) &&
      spanIdsPathRaw.every((v: unknown) => typeof v === "string" && isStringUUID(v))
        ? (spanIdsPathRaw as StringUUID[])
        : undefined
    return {
      traceId,
      spanId,
      isRemote: Boolean(record.isRemote ?? record.is_remote ?? false),
      spanPath,
      spanIdsPath,
    }
  } catch {
    return undefined
  }
}
