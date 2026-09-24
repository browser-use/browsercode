import { resourceFromAttributes } from "@opentelemetry/resources"
import { ProtobufTraceSerializer } from "@opentelemetry/otlp-transformer"
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base"
import type { Attributes, AttributeValue } from "@opentelemetry/api"

export const RECORD_BYTES = 64 * 1024
export const QUEUE_BYTES = 4 * 1024 * 1024
export const QUEUE_RECORDS = 512
const FIELD_BYTES = 16 * 1024
const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

export function encodedBytes(spans: ReadableSpan[]): number {
  return ProtobufTraceSerializer.serializeRequest(spans)?.byteLength ?? 0
}

function text(value: string): string {
  // Slice before encoding so a huge diagnostic string cannot create another huge buffer.
  const bytes = encoder.encode(value.slice(0, FIELD_BYTES))
  if (bytes.length <= FIELD_BYTES) return decoder.decode(bytes)
  let end = FIELD_BYTES
  while ((bytes[end]! & 0xc0) === 0x80) end--
  return decoder.decode(bytes.subarray(0, end))
}

function attributes(source: Attributes, mark: () => void): Attributes {
  const result: Attributes = Object.create(null)
  for (const [key, value] of Object.entries(source)) {
    if (text(key) !== key) {
      mark()
      continue
    }
    if (typeof value === "string") {
      result[key] = text(value)
      if (result[key] !== value) mark()
    } else if (Array.isArray(value)) {
      const values: AttributeValue[] = []
      let remaining = FIELD_BYTES
      for (const item of value) {
        const bounded = typeof item === "string" ? text(item) : item
        const size = typeof bounded === "string" ? encoder.encode(bounded).length : 8
        if (size > remaining) {
          mark()
          break
        }
        if (bounded !== item) mark()
        remaining -= size
        values.push(bounded as AttributeValue)
      }
      result[key] = values as AttributeValue
    } else result[key] = value
  }
  return result
}

export function boundedSpan(source: ReadableSpan): ReadableSpan | undefined {
  let changed = false
  const mark = () => {
    changed = true
  }
  const boundedText = (value: string) => {
    const result = text(value)
    if (result !== value) mark()
    return result
  }
  const context = { ...source.spanContext() }
  // A plain snapshot must not retain the original span and its unbounded strings.
  const span: ReadableSpan = {
    name: boundedText(source.name),
    kind: source.kind,
    spanContext: () => context,
    parentSpanContext: source.parentSpanContext,
    startTime: source.startTime,
    endTime: source.endTime,
    duration: source.duration,
    ended: source.ended,
    resource: resourceFromAttributes(attributes(source.resource.attributes, mark)),
    instrumentationScope: source.instrumentationScope,
    droppedAttributesCount: source.droppedAttributesCount,
    droppedEventsCount: source.droppedEventsCount,
    droppedLinksCount: source.droppedLinksCount,
    attributes: attributes(source.attributes, mark),
    status: { ...source.status, message: source.status.message && boundedText(source.status.message) },
    events: source.events.map((event) => ({
      ...event,
      name: boundedText(event.name),
      attributes: attributes(event.attributes ?? {}, mark),
    })),
    links: source.links.map((link) => ({ ...link, attributes: attributes(link.attributes ?? {}, mark) })),
  }
  if (changed) span.attributes["bcode.telemetry.truncated"] = true
  // Keep identity, timings, numeric usage and error status before diagnostic text.
  for (const key of Object.keys(span.attributes).sort(
    (a, b) =>
      (typeof span.attributes[b] === "string" ? span.attributes[b].length : 0) -
      (typeof span.attributes[a] === "string" ? span.attributes[a].length : 0),
  )) {
    if (encodedBytes([span]) <= RECORD_BYTES) return span
    if (typeof span.attributes[key] === "number" || typeof span.attributes[key] === "boolean") continue
    delete span.attributes[key]
    span.attributes["bcode.telemetry.truncated"] = true
  }
  while (encodedBytes([span]) > RECORD_BYTES && span.events.length) {
    span.events.pop()
    span.attributes["bcode.telemetry.truncated"] = true
  }
  while (encodedBytes([span]) > RECORD_BYTES && span.links.length) {
    span.links.pop()
    span.attributes["bcode.telemetry.truncated"] = true
  }
  return encodedBytes([span]) <= RECORD_BYTES ? span : undefined
}
