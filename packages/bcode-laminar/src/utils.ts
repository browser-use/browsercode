// Vendored from lmnr-ts/packages/lmnr/src/utils.ts (selected helpers).
// Laminar uses UUIDs for span/trace ids; OTel uses 16/8-byte hex strings.

export type StringUUID = `${string}-${string}-${string}-${string}-${string}`

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const isStringUUID = (id: string): id is StringUUID => UUID_RE.test(id)

export const otelSpanIdToUUID = (spanId: string): StringUUID => {
  let id = spanId.toLowerCase()
  if (id.startsWith("0x")) id = id.slice(2)
  return id
    .padStart(32, "0")
    .replace(
      /^([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})$/,
      "$1-$2-$3-$4-$5",
    ) as StringUUID
}

export const uuidToOtelTraceId = (uuid: string): string => uuid.replace(/-/g, "")
export const uuidToOtelSpanId = (uuid: string): string => uuid.replace(/-/g, "").slice(16)
