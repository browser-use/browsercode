import { Effect } from "effect"
import { define } from "../internal"

export const OrcaRouterPlugin = define({
  id: "orcarouter",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.catalog.transform(
      Effect.fn(function* (evt) {
        for (const item of evt.provider.list()) {
          if (item.provider.api.type !== "aisdk") continue
          if (item.provider.api.package !== "@ai-sdk/openai-compatible") continue
          if (item.provider.api.url !== "https://api.orcarouter.ai/v1") continue
          evt.provider.update(item.provider.id, (provider) => {
            provider.request.headers["HTTP-Referer"] ??= "https://bcode.sh/"
            provider.request.headers["X-Title"] ??= "bcode"
          })
        }
      }),
    )
  }),
})
