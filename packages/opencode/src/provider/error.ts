import { APICallError } from "ai"
import { STATUS_CODES } from "http"
import { iife } from "@/util/iife"
import type { ProviderV2 } from "@opencode-ai/core/provider"
import { isContextOverflow } from "@opencode-ai/llm"
import { Flag } from "@opencode-ai/core/flag/flag"

export class HeaderTimeoutError extends Error {
  public override readonly name = "ProviderHeaderTimeoutError"

  constructor(public readonly ms: number) {
    super(`Provider response headers timed out after ${ms}ms`)
  }
}

export class ResponseStreamError extends Error {
  public override readonly name = "ProviderResponseStreamError"

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

function isOpenAiErrorRetryable(e: APICallError) {
  const status = e.statusCode
  if (!status) return e.isRetryable
  // openai sometimes returns 404 for models that are actually available
  return status === 404 || e.isRetryable
}

// Providers not reliably handled in this function:
// - z.ai: can accept overflow silently (needs token-count/context-window checks)
function message(providerID: ProviderV2.ID, e: APICallError) {
  return iife(() => {
    const msg = e.message
    if (msg === "") {
      if (e.responseBody) return e.responseBody
      if (e.statusCode) {
        const err = STATUS_CODES[e.statusCode]
        if (err) return err
      }
      return "Unknown error"
    }

    if (!e.responseBody || (e.statusCode && msg !== STATUS_CODES[e.statusCode])) {
      return msg
    }

    try {
      const body = JSON.parse(e.responseBody)
      // try to extract common error message fields
      const errMsg = body.message || body.error || body.error?.message
      if (errMsg && typeof errMsg === "string") {
        return `${msg}: ${errMsg}`
      }
    } catch {}

    // If responseBody is HTML (e.g. from a gateway or proxy error page),
    // provide a human-readable message instead of dumping raw markup
    if (/^\s*<!doctype|^\s*<html/i.test(e.responseBody)) {
      if (e.statusCode === 401) {
        return "Unauthorized: request was blocked by a gateway or proxy. Your authentication token may be missing or expired — try running `opencode auth login <your provider URL>` to re-authenticate."
      }
      if (e.statusCode === 403) {
        return "Forbidden: request was blocked by a gateway or proxy. You may not have permission to access this resource — check your account and provider settings."
      }
      return msg
    }

    return `${msg}: ${e.responseBody}`
  }).trim()
}

function json(input: unknown) {
  if (typeof input === "string") {
    try {
      const result = JSON.parse(input)
      if (result && typeof result === "object") return result
      return undefined
    } catch {
      return undefined
    }
  }
  if (typeof input === "object" && input !== null) {
    return input
  }
  return undefined
}

export type ParsedStreamError =
  | {
      type: "context_overflow"
      message: string
      responseBody: string
    }
  | {
      type: "api_error"
      message: string
      isRetryable: boolean
      responseBody: string
      metadata?: Record<string, string>
    }

// Cloud V4 gateway failures after the reply started, which the same route may serve on a resend.
const TRANSPORT = /^(ReadError|ReadTimeout|RemoteProtocolError|APIConnectionError|ConnectError|ConnectTimeout)(?::|$)/
// The gateway's own wording for a provider or stream failure; rejections and refusals carry other text or types.
const GATEWAY_FAILURES = new Set([
  "The model returned an error.",
  "The model request timed out.",
  "The model request is temporarily unavailable.",
])

function gatewayFailure(message: unknown): message is string {
  return (
    typeof message === "string" && Flag.BCODE_STREAM_RETRY && (TRANSPORT.test(message) || GATEWAY_FAILURES.has(message))
  )
}

function streamFailed(message: string, responseBody: string): ParsedStreamError {
  return { type: "api_error", message, isRetryable: true, responseBody, metadata: { code: "upstream_stream_failed" } }
}

export function parseStreamError(input: unknown): ParsedStreamError | undefined {
  const raw = json(input)
  // Chat Completions SDKs pass on only the error message.
  if (!raw && gatewayFailure(input)) return streamFailed(input, JSON.stringify(input))
  const body = typeof raw?.message === "string" ? (json(raw.message) ?? raw) : raw
  if (!body) return

  const responseBody = JSON.stringify(body)
  // Anthropic SDKs pass on the error object of a mid-stream error event; these two types are server failures.
  if ((body.type === "api_error" || body.type === "overloaded_error") && gatewayFailure(body.message))
    return streamFailed(body.message, responseBody)
  const error =
    body.type === "error"
      ? body.error
      : body.type === "response.failed" &&
          (body.response?.error?.code === "server_is_overloaded" || body.response?.error?.code === "server_error")
        ? body.response.error
        : undefined
  if (!error) return

  switch (error.code) {
    case "context_length_exceeded":
      return {
        type: "context_overflow",
        message: "Input exceeds context window of this model",
        responseBody,
      }
    case "insufficient_quota":
      return {
        type: "api_error",
        message: "Quota exceeded. Check your plan and billing details.",
        isRetryable: false,
        responseBody,
      }
    case "usage_not_included":
      return {
        type: "api_error",
        message: "To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.",
        isRetryable: false,
        responseBody,
      }
    case "invalid_prompt":
      return {
        type: "api_error",
        message: typeof error.message === "string" ? error.message : "Invalid prompt.",
        isRetryable: false,
        responseBody,
      }
    case "upstream_stream_failed":
      if (typeof error.message !== "string" || !(TRANSPORT.test(error.message) || gatewayFailure(error.message))) return
      return streamFailed(error.message, responseBody)
    case "server_is_overloaded":
    case "server_error":
      return {
        type: "api_error",
        message: typeof error.message === "string" ? error.message : "Server error.",
        isRetryable: true,
        responseBody,
      }
  }
}

export type ParsedAPICallError =
  | {
      type: "context_overflow"
      message: string
      responseBody?: string
    }
  | {
      type: "api_error"
      message: string
      statusCode?: number
      isRetryable: boolean
      responseHeaders?: Record<string, string>
      responseBody?: string
      metadata?: Record<string, string>
    }

export function parseAPICallError(input: { providerID: ProviderV2.ID; error: APICallError }): ParsedAPICallError {
  const m = message(input.providerID, input.error)
  const body = json(input.error.responseBody)
  if (isContextOverflow(m) || input.error.statusCode === 413 || body?.error?.code === "context_length_exceeded") {
    return {
      type: "context_overflow",
      message: m,
      responseBody: input.error.responseBody,
    }
  }

  const metadata = input.error.url ? { url: input.error.url } : undefined
  return {
    type: "api_error",
    message: m,
    statusCode: input.error.statusCode,
    isRetryable: input.providerID.startsWith("openai") ? isOpenAiErrorRetryable(input.error) : input.error.isRetryable,
    responseHeaders: input.error.responseHeaders,
    responseBody: input.error.responseBody,
    metadata,
  }
}

export * as ProviderError from "./error"
