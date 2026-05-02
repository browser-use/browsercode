// Vendored from lmnr-ts/packages/lmnr/src/opentelemetry-lib/tracing/exporter.ts.
// Trimmed to gRPC + bearer-token only (no HTTP fallback, no OTEL_HEADERS env path).

import { Metadata } from "@grpc/grpc-js"
import type { ExportResult } from "@opentelemetry/core"
import { OTLPTraceExporter as ExporterGrpc } from "@opentelemetry/exporter-trace-otlp-grpc"
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base"

import { makeSpanOtelV2Compatible } from "./compat"

export class LaminarSpanExporter implements SpanExporter {
  private exporter: SpanExporter

  constructor(options: {
    apiKey: string
    baseUrl: string
    port: number
    timeoutMillis?: number
  }) {
    const url = options.baseUrl.replace(/\/$/, "").replace(/:\d{1,5}$/g, "")
    const metadata = new Metadata()
    metadata.set("authorization", `Bearer ${options.apiKey}`)
    this.exporter = new ExporterGrpc({
      url: `${url}:${options.port}`,
      metadata,
      timeoutMillis: options.timeoutMillis ?? 30000,
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
