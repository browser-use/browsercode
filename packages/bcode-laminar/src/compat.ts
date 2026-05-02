// Vendored from lmnr-ts/packages/lmnr/src/opentelemetry-lib/tracing/compat.ts
// Bridges OTel SDK v1 (parentSpanId / instrumentationLibrary) and
// v2 (parentSpanContext / instrumentationScope). Required by the Laminar
// backend, which reads v1-shaped fields off serialized spans.

import type { SpanContext } from "@opentelemetry/api"
import type { ReadableSpan, Span as SdkSpan } from "@opentelemetry/sdk-trace-base"

export type OTelSpanCompat = SdkSpan &
  ReadableSpan & {
    parentSpanId?: string
    parentSpanContext?: SpanContext
    instrumentationLibrary?: any
    instrumentationScope?: any
  }

type OTelReadableSpanCompat = ReadableSpan & {
  parentSpanId?: string
  parentSpanContext?: SpanContext
  instrumentationLibrary?: any
  instrumentationScope?: any
}

export const makeSpanOtelV2Compatible = (span: OTelSpanCompat | OTelReadableSpanCompat) => {
  const spanAny = span as any
  if (spanAny.instrumentationScope && !spanAny.instrumentationLibrary) {
    Object.assign(span, { instrumentationLibrary: spanAny.instrumentationScope })
  } else if (spanAny.instrumentationLibrary && !spanAny.instrumentationScope) {
    Object.assign(span, { instrumentationScope: spanAny.instrumentationLibrary })
  }

  if (spanAny.parentSpanContext && !spanAny.parentSpanId) {
    Object.defineProperty(span, "parentSpanId", {
      value: spanAny.parentSpanContext.spanId,
      writable: true,
      enumerable: true,
      configurable: true,
    })
  } else if (spanAny.parentSpanId && !spanAny.parentSpanContext) {
    const spanContext = span.spanContext()
    Object.defineProperty(span, "parentSpanContext", {
      value: {
        traceId: spanContext.traceId,
        spanId: spanAny.parentSpanId,
        traceFlags: spanContext.traceFlags,
        traceState: spanContext.traceState,
        isRemote: spanContext.isRemote,
      },
      writable: true,
      enumerable: true,
      configurable: true,
    })
  }
}

export const getParentSpanId = (
  span: OTelSpanCompat | OTelReadableSpanCompat,
): string | undefined => {
  const spanAny = span as any
  return spanAny.parentSpanContext?.spanId ?? spanAny.parentSpanId
}
