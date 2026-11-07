# @opencode-ai/sdk-next

Effect-native scoped OpenCode host for in-process applications. This transitional package will replace the existing generated `@opencode-ai/sdk` after its consumers migrate.

The SDK executes Server's assembled HTTP router in memory. It opens no listener and performs no network I/O, while preserving the same routing, middleware, handlers, codecs, and errors as the network client.

```ts
import { OpenCode } from "@opencode-ai/sdk-next"

const opencode = yield * OpenCode.create()
const session = yield * opencode.sessions.get({ sessionID })
```

It also exports `Tool` and exposes local-only `tools.register(...)`, replacing the former `@opencode-ai/core/public` facade. Registration uses Core's host-level `ApplicationTools` service shared by the host's Locations; each Location retains its own `ToolRegistry` for overlay, lookup, and settlement. Closing the owning Effect Scope releases router resources, location services, fibers, and scoped tool registrations.

Host applications can register a callback as an agent tool. For example, an app can pause for a person instead of teaching each agent how its UI works:

```ts
import { OpenCode } from "@opencode-ai/sdk-next"
import { makeAskHuman } from "./ask-human"

const opencode = yield * OpenCode.create()
yield *
  opencode.tools.register({
    ask_human: makeAskHuman((question) => showQuestionModal(question)),
  })
```

A complete `makeAskHuman` implementation is in [`examples/ask-human.ts`](examples/ask-human.ts).

`sessions.events({ sessionID, after })` replays durable events after the optional aggregate sequence, then emits newly committed durable events. `sessions.interrupt(...)` targets execution owned by this host, and `sessions.message(...)` retrieves one projected Session message.

The same constructor is available as a service Layer:

```ts
const program = Effect.gen(function* () {
  const opencode = yield* OpenCode.Service
  return yield* opencode.sessions.get({ sessionID })
})

yield * program.pipe(Effect.provide(OpenCode.layer))
```

`OpenCode.layer` adapts `OpenCode.create()` for dependency injection; it does not define another host implementation.
