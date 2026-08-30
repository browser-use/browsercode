import { Tool } from "@opencode-ai/sdk-next"
import { Effect, Schema } from "effect"

export function makeAskHuman(ask: (question: string) => Promise<string>) {
  return Tool.make({
    description: "Ask the person using this agent for a decision or missing information",
    input: Schema.Struct({ question: Schema.String }),
    output: Schema.Struct({ answer: Schema.String }),
    execute: ({ question }) =>
      Effect.tryPromise({
        try: () => ask(question),
        catch: () => new Tool.Failure({ message: "The person did not answer" }),
      }).pipe(Effect.map((answer) => ({ answer }))),
  })
}
