/// <reference path="../markdown.d.ts" />

export * as SkillPlugin from "./skill"

import { define } from "./internal"
import { Effect } from "effect"
import { PluginV2 } from "../plugin"

export const Plugin = PluginV2.define({
  id: PluginV2.ID.make("skill"),
  effect: Effect.void,
})
