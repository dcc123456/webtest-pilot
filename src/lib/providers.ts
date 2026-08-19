/**
 * Provider profiles for any OpenAI-compatible chat-completions endpoint.
 *
 * Every supported vendor — DeepSeek, Volcengine Ark, OpenAI, OpenRouter, a local
 * Ollama or vLLM — speaks the same `POST {baseUrl}/chat/completions` protocol
 * with a `Bearer` token, SSE streaming, and `tools` function calling. So the
 * client needs no per-vendor code: a provider is just data (base URL, key,
 * model), and the presets below exist purely to spare the user from typing URLs.
 *
 * @module lib/providers
 */

/** A configured endpoint the agent can talk to. */
export interface ProviderProfile {
  id: string
  /** User-facing name, e.g. "Ark coding plan". */
  label: string
  /** Which preset this was created from; `'custom'` once freely edited. */
  presetId: string
  /** Endpoint base. `/chat/completions` is appended. */
  baseUrl: string
  apiKey: string
  /**
   * Model or, on Ark, an endpoint ID (`ep-…`) when using a dedicated endpoint
   * rather than a shared model name.
   */
  model: string
  /** Extra headers some gateways require (e.g. OpenRouter attribution). */
  headers?: Record<string, string>
  /** Sampling temperature; omitted from the request when undefined. */
  temperature?: number
  /** Response cap; omitted when undefined so the server default applies. */
  maxTokens?: number
  /**
   * Whether this model accepts image parts in a user message.
   *
   * Opt-in rather than detected: sending an image to a text-only model produces
   * a 400 that reads like a malformed request, and there is no reliable
   * capability endpoint across vendors. When false, the agent describes the page
   * structurally instead of attaching a screenshot.
   */
  supportsVision?: boolean
}

/** A starting point for a new profile. */
export interface ProviderPreset {
  id: string
  label: string
  baseUrl: string
  /** Suggested model, prefilled but always editable. */
  defaultModel: string
  /** Where to get a key, and any vendor-specific gotcha. */
  hint: string
  /** Docs URL for keys/models. */
  docsUrl?: string
  /** Whether the suggested model is multimodal. */
  vision?: boolean
}

/**
 * Known endpoints, in the order shown in the UI.
 *
 * `baseUrl` values deliberately include the version segment, because vendors
 * disagree about it (`/v1` vs `/api/v3`) and the client only ever appends
 * `/chat/completions`.
 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    hint: 'Create a key at platform.deepseek.com. Models: deepseek-chat, deepseek-reasoner. Text only, so page structure is used instead of screenshots.',
    docsUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'ark',
    label: '火山方舟 Volcengine Ark',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: 'doubao-seed-code',
    hint: 'Use an Ark API key. For "model", use a model ID such as doubao-seed-code, or your dedicated endpoint ID (ep-…). A coding-plan subscription is billed against the model it covers.',
    docsUrl: 'https://console.volcengine.com/ark',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    hint: 'Create a key at platform.openai.com. gpt-4o family models accept screenshots.',
    docsUrl: 'https://platform.openai.com/api-keys',
    vision: true,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'deepseek/deepseek-chat',
    hint: 'One key for many vendors. Model IDs are namespaced, e.g. deepseek/deepseek-chat.',
    docsUrl: 'https://openrouter.ai/keys',
  },
  {
    id: 'moonshot',
    label: 'Moonshot / Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'kimi-k2-0905-preview',
    hint: 'Create a key at platform.moonshot.cn.',
    docsUrl: 'https://platform.moonshot.cn/console/api-keys',
  },
  {
    id: 'dashscope',
    label: '阿里云百炼 DashScope',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    hint: 'Use the OpenAI-compatible base shown above, not the native DashScope path. qwen-vl-* models accept screenshots.',
    docsUrl: 'https://bailian.console.aliyun.com/',
  },
  {
    id: 'siliconflow',
    label: '硅基流动 SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    hint: 'Model IDs are namespaced, e.g. deepseek-ai/DeepSeek-V3.',
    docsUrl: 'https://cloud.siliconflow.cn/account/ak',
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-plus',
    hint: 'Create a key at open.bigmodel.cn. glm-4v-* models accept screenshots.',
    docsUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'qwen3:8b',
    hint: 'Runs locally; any non-empty key works. The model must already be pulled, and must support tool calling to drive a test.',
    docsUrl: 'https://ollama.com/',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (local)',
    baseUrl: 'http://localhost:1234/v1',
    defaultModel: 'local-model',
    hint: 'Start the local server in LM Studio first; any non-empty key works.',
  },
  {
    id: 'custom',
    label: 'Custom OpenAI-compatible',
    baseUrl: '',
    defaultModel: '',
    hint: 'Any endpoint exposing POST {baseUrl}/chat/completions with Bearer auth. Enter the base URL up to but not including /chat/completions.',
  },
]

export function findPreset(presetId: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.id === presetId)
}

/**
 * Normalizes a base URL into the form the client expects.
 *
 * Users routinely paste the full endpoint from vendor docs, so a trailing
 * `/chat/completions` is stripped rather than producing a confusing 404 later.
 */
export function normalizeBaseUrl(input: string): string {
  let url = input.trim().replace(/\/+$/, '')
  url = url.replace(/\/chat\/completions$/i, '')
  return url.replace(/\/+$/, '')
}

/** Validation failure describing exactly which field is wrong. */
export interface ProfileProblem {
  field: 'label' | 'baseUrl' | 'apiKey' | 'model'
  message: string
}

/** Returns every problem with a profile, so a form can report them at once. */
export function validateProfile(profile: ProviderProfile): ProfileProblem[] {
  const problems: ProfileProblem[] = []

  if (!profile.label.trim()) {
    problems.push({ field: 'label', message: 'Give this provider a name.' })
  }

  const baseUrl = normalizeBaseUrl(profile.baseUrl)
  if (!baseUrl) {
    problems.push({ field: 'baseUrl', message: 'Base URL is required.' })
  } else if (!/^https?:\/\//i.test(baseUrl)) {
    problems.push({ field: 'baseUrl', message: 'Base URL must start with http:// or https://.' })
  } else {
    try {
      new URL(baseUrl)
    } catch {
      problems.push({ field: 'baseUrl', message: 'Base URL is not a valid URL.' })
    }
  }

  if (!profile.apiKey.trim()) {
    problems.push({ field: 'apiKey', message: 'API key is required.' })
  }
  if (!profile.model.trim()) {
    problems.push({ field: 'model', message: 'Model is required.' })
  }
  return problems
}

/** Builds a profile from a preset, ready to be edited. */
export function profileFromPreset(preset: ProviderPreset, id: string): ProviderProfile {
  const profile: ProviderProfile = {
    id,
    label: preset.label,
    presetId: preset.id,
    baseUrl: preset.baseUrl,
    apiKey: '',
    model: preset.defaultModel,
  }
  if (preset.vision) profile.supportsVision = true
  return profile
}

/**
 * Hosts that need no real credential.
 *
 * Local runtimes accept any bearer token, so the UI can prefill a placeholder
 * instead of demanding a key the user does not have.
 */
export function isLocalEndpoint(baseUrl: string): boolean {
  try {
    const { hostname } = new URL(normalizeBaseUrl(baseUrl))
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
  } catch {
    return false
  }
}
