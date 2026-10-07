# V4 LLM transport recovery

The Cloud proxy emits `upstream_stream_failed` after an interrupted upstream stream. BrowserCode previously treated this envelope as an unknown terminal error. The fix recognizes transport exception classes, permits at most three total attempts with existing backoff, removes only incomplete attempt parts, and refuses replay once prepared tool execution starts or a tool call is observed.

The focused test uses the actual OpenAI SDK and an HTTP 200 SSE fixture. It covers ReadError, RemoteProtocolError, APIConnectionError, exhaustion, an executed action, a non-transport exception, and interruption during backoff. Recovery requires two HTTP calls, one tool execution, recovered output only, and correct token/cost accounting. Exhaustion requires exactly three HTTP calls.

With the final unchanged regression (SHA256 `2caa9604b5ce2aaa90b5449e0e74a4c0411e08a9fd81c915955dcff3e1a67db3`), baseline main had two passing safety cases and five failures; the fix passed all seven. Package typecheck passed. Focused lint reported zero errors and 42 warnings. VM evidence is in `/home/exedev/v4-llm-transport-proof`.

Run from `packages/opencode` with Bun 1.3.14:
```sh
bun test test/session/processor-effect.test.ts -t 'gateway transport recovery' --timeout 25000
bun typecheck
```

This fixes a recovery gap, not the unconfirmed provider/network trigger. Production still uses BrowserCode 0.1.21-telemetry.1; an updated binary release and a reviewed Cloud V4 worker pin are required. No release, Cloud pin, AWS change, or deployment was performed.
