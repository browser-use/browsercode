import { describe, expect, test } from "bun:test"
import { BasicTracerProvider, type ReadableSpan, type SpanExporter } from "@opentelemetry/sdk-trace-base"
import { ExportResultCode } from "@opentelemetry/core"
import { ProtobufTraceSerializer } from "@opentelemetry/otlp-transformer"
import { OpenCodeLaminarSpanProcessor } from "../src/processor"

function setup() {
  const batches: ReadableSpan[][] = []
  const exporter: SpanExporter = {
    export(spans, done) {
      batches.push([...spans])
      done({ code: ExportResultCode.SUCCESS })
    },
    async shutdown() {},
  }
  const processor = new OpenCodeLaminarSpanProcessor({ exporter })
  const provider = new BasicTracerProvider({ spanProcessors: [processor] })
  return { batches, processor, provider, tracer: provider.getTracer("memory-budget") }
}
function bytes(spans: ReadableSpan[]) {
  return ProtobufTraceSerializer.serializeRequest(spans)!.byteLength
}

describe("diagnostic byte budgets", () => {
  test("red: diagnostic text is capped at 16 KiB in UTF-8", async () => {
    const ctx = setup()
    const span = ctx.tracer.startSpan("step")
    span.setAttribute("lmnr.span.input", "😺".repeat(20000))
    span.end()
    await ctx.provider.forceFlush()
    await ctx.provider.shutdown()
    expect(ctx.batches.flat().length).toBe(1)
    expect(Buffer.byteLength(String(ctx.batches[0][0].attributes["lmnr.span.input"]))).toBeLessThanOrEqual(16 * 1024)
  })
  test("red: one record stays below 64 KiB", async () => {
    const ctx = setup()
    const span = ctx.tracer.startSpan("step")
    for (let i = 0; i < 8; i++) span.setAttribute(`diagnostic.${i}`, "x".repeat(16000))
    span.end()
    await ctx.provider.forceFlush()
    await ctx.provider.shutdown()
    expect(ctx.batches.flat().length).toBe(1)
    expect(bytes(ctx.batches.flat())).toBeLessThanOrEqual(64 * 1024)
  })
  test("red: uploads split at 1 MiB including wire encoding", async () => {
    const ctx = setup()
    for (let i = 0; i < 32; i++) {
      const span = ctx.tracer.startSpan(`step-${i}`)
      for (let j = 0; j < 4; j++) span.setAttribute(`diagnostic.${j}`, "x".repeat(16200))
      span.end()
    }
    await ctx.provider.forceFlush()
    await ctx.provider.shutdown()
    expect(ctx.batches.flat().length).toBe(32)
    expect(Math.max(...ctx.batches.map(bytes))).toBeGreaterThan(1000000)
    expect(Math.max(...ctx.batches.map(bytes))).toBeLessThanOrEqual(1024 * 1024)
  })
  test("red: queued diagnostics stay below 4 MiB", async () => {
    const ctx = setup()
    for (let i = 0; i < 128; i++) {
      const span = ctx.tracer.startSpan(`step-${i}`)
      for (let j = 0; j < 3; j++) span.setAttribute(`diagnostic.${j}`, "x".repeat(15000))
      span.end()
    }
    const queued = (ctx.processor as unknown as { inner: { _finishedSpans: ReadableSpan[] } }).inner._finishedSpans
    const queuedBytes = bytes(queued)
    await ctx.provider.forceFlush()
    await ctx.provider.shutdown()
    expect(queuedBytes).toBeLessThanOrEqual(4 * 1024 * 1024)
  })
  test("control: small diagnostic retains name, timing and input", async () => {
    const ctx = setup()
    const span = ctx.tracer.startSpan("read page")
    span.setAttribute("lmnr.span.input", "cats")
    span.end()
    await ctx.provider.forceFlush()
    await ctx.provider.shutdown()
    expect(ctx.batches.flat().length).toBe(1)
    expect(ctx.batches[0][0].name).toBe("read page")
    expect(ctx.batches[0][0].attributes["lmnr.span.input"]).toBe("cats")
    expect(ctx.batches[0][0].duration[0]).toBeGreaterThanOrEqual(0)
  })
})
