// Vendored from lmnr-ts/packages/lmnr/src/opentelemetry-lib/tracing/exporter.ts.
// Trimmed to gRPC + bearer-token + an OTLP/HTTP fallback selected by standard
// OTel env vars (no OTEL_HEADERS-only env path — endpoint must be set to
// switch transports).

import { Metadata } from "@grpc/grpc-js"
import type { ExportResult } from "@opentelemetry/core"
import { OTLPTraceExporter as ExporterGrpc } from "@opentelemetry/exporter-trace-otlp-grpc"
import { OTLPTraceExporter as ExporterHttpProto } from "@opentelemetry/exporter-trace-otlp-proto"
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base"

import { makeSpanOtelV2Compatible } from "./compat"

export class LaminarSpanExporter implements SpanExporter {
  private exporter: SpanExporter

  constructor(options: { apiKey: string; baseUrl: string; port: number; timeoutMillis?: number }) {
    const url = options.baseUrl.replace(/\/$/, "").replace(/:\d{1,5}$/g, "")
    const metadata = new Metadata()
    metadata.set("authorization", `Bearer ${options.apiKey}`)
    this.exporter = new ExporterGrpc({
      url: `${url}:${options.port}`,
      metadata,
      timeoutMillis: options.timeoutMillis ?? 10000,
    })
  }

  export(items: ReadableSpan[], resultCallback: (result: ExportResult) => void) {
    items.forEach(makeSpanOtelV2Compatible)
    return this.exporter.export(items, resultCallback)
  }

  async shutdown() {
    return this.exporter.shutdown()
  }

  async forceFlush() {
    return this.exporter.forceFlush?.()
  }
}

// Pick the right exporter based on env. When `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
// or `OTEL_EXPORTER_OTLP_ENDPOINT` is set, route spans through OTLP/HTTP+protobuf
// (vendor-neutral; standard OTel env-var contract — headers come from
// `OTEL_EXPORTER_OTLP_HEADERS` / `OTEL_EXPORTER_OTLP_TRACES_HEADERS` which the
// proto exporter reads itself). Lets users point bcode at any OTel collector
// (Honeycomb, Tempo, Jaeger, etc.) without a Laminar account, and lets the
// V4 cloud worker relay through a backend that holds the real Laminar key —
// the runtime never needs LMNR_PROJECT_API_KEY.
//
// Default path is unchanged: gRPC to Laminar with bearer auth.
export const createSpanExporter = (laminar: { apiKey: string; baseUrl: string; port: number }): SpanExporter => {
  if (process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    return new ExporterHttpProto({ timeoutMillis: 10000 })
  }
  return new LaminarSpanExporter(laminar)
}
