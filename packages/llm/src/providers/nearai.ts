import { AuthOptions, type ProviderAuthOption } from "../route/auth-options"
import { Provider } from "../provider"
import { ProviderID, type ModelID } from "../schema"
import * as OpenAICompatibleProfiles from "./openai-compatible-profile"
import * as OpenAICompatibleChat from "../protocols/openai-compatible-chat"

export const profile = OpenAICompatibleProfiles.profiles.nearai
export const id = ProviderID.make(profile.provider)

export type ModelOptions = Omit<
  OpenAICompatibleChat.OpenAICompatibleChatModelInput,
  "id" | "provider" | "apiKey" | "auth" | "baseURL"
> &
  ProviderAuthOption<"optional"> & {
    readonly baseURL?: string
  }

export const routes = [OpenAICompatibleChat.route]

const auth = (options: ProviderAuthOption<"optional">) => AuthOptions.bearer(options, "NEARAI_API_KEY")

export const chat = (modelID: string | ModelID, options: ModelOptions = {}) => {
  const { apiKey: _, ...rest } = options
  return OpenAICompatibleChat.model({
    ...rest,
    auth: auth(options),
    id: modelID,
    provider: id,
    baseURL: options.baseURL ?? profile.baseURL,
  })
}

export const provider = Provider.make({
  id,
  model: chat,
  apis: { chat },
})

export const model = provider.model
export const apis = provider.apis
