import { expect, test } from "bun:test"
import { context, trace, SpanStatusCode } from "@opentelemetry/api"
import { ExportResultCode, type ExportResult } from "@opentelemetry/core"
import { BasicTracerProvider, type ReadableSpan } from "@opentelemetry/sdk-trace-base"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import { OpenCodeLaminarSpanProcessor } from "../src/processor"
import { encodedBytes } from "../src/budget"

function setup() {
  const spans: ReadableSpan[] = []
  const processor = new OpenCodeLaminarSpanProcessor({
    exporter: {
      export(items, done) {
        spans.push(...items)
        done({ code: ExportResultCode.SUCCESS })
      },
      async shutdown() {},
    },
  })
  const provider = new BasicTracerProvider({ spanProcessors: [processor] })
  return { provider, spans, tracer: provider.getTracer("safety") }
}

test("truncation preserves identity, parenting, usage, status and the original data", async () => {
  const { provider, tracer, spans } = setup()
  const parent = tracer.startSpan("parent")
  const child = tracer.startSpan("child", {}, trace.setSpan(context.active(), parent))
  const original = "😺".repeat(20000)
  child.setAttribute("lmnr.span.input", original)
  child.setAttribute("gen_ai.usage.input_tokens", 123)
  child.setStatus({ code: SpanStatusCode.ERROR, message: "test failure" })
  child.end()
  parent.end()
  await provider.forceFlush()
  await provider.shutdown()
  const output = spans.find((span) => span.name === "child")!
  expect(output.spanContext().spanId).toBe(child.spanContext().spanId)
  expect(output.parentSpanContext?.spanId).toBe(parent.spanContext().spanId)
  expect(output.attributes["gen_ai.usage.input_tokens"]).toBe(123)
  expect(output.status).toEqual({ code: SpanStatusCode.ERROR, message: "test failure" })
  expect(output.attributes["bcode.telemetry.truncated"]).toBe(true)
  expect(String(output.attributes["lmnr.span.input"])).not.toContain("�")
  expect((child as unknown as ReadableSpan).attributes["lmnr.span.input"]).toBe(original)
  expect(Object.getPrototypeOf(output)).toBe(Object.prototype)
  expect(encodedBytes([output])).toBeLessThanOrEqual(65536)
})

test("oversized events and links stay bounded", async () => {
  const { provider, tracer, spans } = setup()
  const span = tracer.startSpan("event", {
    links: [
      {
        context: { traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: 1 },
        attributes: { text: "x".repeat(100000) },
      },
    ],
  })
  for (let i = 0; i < 12; i++) span.addEvent("error", { message: "x".repeat(100000) })
  span.end()
  await provider.forceFlush()
  await provider.shutdown()
  expect(spans.length).toBe(1)
  expect(encodedBytes(spans)).toBeLessThanOrEqual(65536)
  expect(spans[0].attributes["bcode.telemetry.truncated"]).toBe(true)
})

test("a stalled exporter cannot grow the queue beyond byte or record budgets and recovers", async () => {
  const callbacks: ((result: ExportResult) => void)[] = []
  let exported = 0
  const processor = new OpenCodeLaminarSpanProcessor({
    exporter: {
      export(items, done) {
        exported += items.length
        callbacks.push(done)
      },
      async shutdown() {},
    },
  })
  const provider = new BasicTracerProvider({ spanProcessors: [processor] })
  const tracer = provider.getTracer("stalled")
  for (let i = 0; i < 1000; i++) {
    const span = tracer.startSpan("step")
    span.setAttribute("input", "x".repeat(15000))
    span.end()
  }
  const state = processor as unknown as { pendingBytes: number; pendingRecords: number }
  expect(state.pendingBytes).toBeLessThanOrEqual(4 * 1024 * 1024)
  expect(state.pendingRecords).toBeLessThanOrEqual(512)
  const admitted = state.pendingRecords
  const flushing = provider.forceFlush()
  await new Promise((resolve) => setTimeout(resolve, 0))
  for (const done of callbacks.splice(0)) done({ code: ExportResultCode.SUCCESS })
  await flushing
  expect(exported).toBe(admitted)
  expect(state.pendingBytes).toBe(0)
  tracer.startSpan("recovered").end()
  const recovered = provider.forceFlush()
  await new Promise((resolve) => setTimeout(resolve, 0))
  for (const done of callbacks.splice(0)) done({ code: ExportResultCode.SUCCESS })
  await recovered
  await provider.shutdown()
  expect(exported).toBe(admitted + 1)
})

for (const status of [200, 413]) {
  test(`real OTLP HTTP transport: ${status} response produces one attempt with a bounded body`, async () => {
    const bodies: number[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        bodies.push((await request.arrayBuffer()).byteLength)
        return new Response(status === 200 ? new Uint8Array() : "too large", {
          status,
          headers: { "content-type": "application/x-protobuf" },
        })
      },
    })
    const exporter = new OTLPTraceExporter({ url: `http://127.0.0.1:${server.port}/v1/traces`, timeoutMillis: 10000 })
    const { provider, tracer, spans } = setup()
    tracer.startSpan("wire").end()
    await provider.forceFlush()
    await provider.shutdown()
    try {
      const result = await new Promise<ExportResult>((done) => exporter.export(spans, done))
      expect(result.code).toBe(status === 200 ? ExportResultCode.SUCCESS : ExportResultCode.FAILED)
      expect(bodies.length).toBe(1)
      expect(bodies[0]).toBeLessThanOrEqual(1024 * 1024)
    } finally {
      await exporter.shutdown()
      server.stop(true)
    }
  })
}

test("overlong attribute keys cannot overwrite a valid key", async () => {
  const { provider, tracer, spans } = setup()
  const key = "x".repeat(16384)
  const span = tracer.startSpan("keys")
  span.setAttribute(key, "keep")
  span.setAttribute(key + "suffix", "overwrite")
  span.end()
  await provider.forceFlush()
  await provider.shutdown()
  expect(spans[0].attributes[key]).toBe("keep")
  expect(spans[0].attributes["bcode.telemetry.truncated"]).toBe(true)
})
