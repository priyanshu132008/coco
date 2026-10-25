/** Setup form → the config the backend expects. Secrets go to the root .env (plaintext,
 *  machine-local — the gateway, runner and health tool all read that same file) and the
 *  resolved LiteLLM model to config.json for tools/byok.py. */

export type Provider = 'openrouter' | 'openai' | 'anthropic' | 'custom'

/** Provider → the model fields byok.py expects. `model` is the BARE model name: byok.py
 *  prefixes the provider itself (except for provider "openai", which it passes through
 *  verbatim) — never pre-prefix it here. */
const PROVIDERS: Record<Provider, { provider: string; model: string }> = {
  openrouter: { provider: 'openrouter', model: 'auto' },
  openai: { provider: 'openai', model: 'gpt-4o' },
  anthropic: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
  // custom = any OpenAI-compatible gateway: the base URL and model name come from the form
  custom: { provider: 'openai', model: 'gpt-4o' },
}

export interface SetupInput {
  token: string
  provider: Provider
  apiKey: string
  baseUrl?: string
  model?: string
}

/** Provider submission → the fields byok.py's config path expects, and the resolved
 *  LiteLLM model string. A model the user typed wins verbatim (it may carry its own
 *  provider prefix — byok.py passes known-prefixed strings through); blank falls back
 *  to the provider default. byok.py prefixes a bare model with the provider itself. */
export function planSetup(input: SetupInput): { provider: string; active_model: string } {
  const p = PROVIDERS[input.provider]
  const given = input.model?.trim()
  const active_model = given || (p.provider === 'openai' && input.provider === 'custom' ? 'gpt-4o' : p.model)
  return { provider: p.provider, active_model }
}

/** LiteLLM provider prefixes — a model written like "provider/model" is already qualified. */
const QUALIFIED_RE =
  /^(anthropic|openai|openrouter|ollama|gemini|azure|azure_ai|bedrock|vertex_ai|mistral|groq|deepseek|together_ai|xai|cohere|fireworks|watsonx|perplexity)\//

/** The FULLY-qualified LiteLLM model string (e.g. "openrouter/auto") — display only;
 *  the stored value is config.json's active_model + provider (tools/byok.py resolves). */
export function resolveModel(input: SetupInput): string {
  const { provider, active_model } = planSetup(input)
  return provider === 'openai' || QUALIFIED_RE.test(active_model) ? active_model : `${provider}/${active_model}`
}

if (process.argv[1]?.endsWith('setup.ts')) {
  // self-check: the provider mapping only — byok.py hands "openai" providers the model
  // verbatim, so a custom model must keep its "openai/" prefix and others must not double up
  if (planSetup({ token: 't', provider: 'anthropic', apiKey: 'k' }).active_model !== 'claude-sonnet-5-5') throw new Error('anthropic config wrong')
  const custom = planSetup({ token: 't', provider: 'custom', apiKey: 'k', baseUrl: 'http://x/v1', model: 'my-model' })
  if (custom.active_model !== 'my-model') throw new Error('custom model not used') // bare — byok.py prefixes openai/
  // a user-specified model wins verbatim, whatever the provider
  const given = planSetup({ token: 't', provider: 'openrouter', apiKey: 'k', model: 'openrouter/anthropic/claude-3.5-sonnet' })
  if (given.active_model !== 'openrouter/anthropic/claude-3.5-sonnet') throw new Error('user model dropped: ' + JSON.stringify(given))
  for (const p of Object.keys(PROVIDERS) as Provider[]) {
    // resolveModel is the display string — with config.json the runner (byok.py) adds the
    // provider prefix itself, so the bare model must never carry a doubled provider name
    const resolved = resolveModel({ token: 't', provider: p, apiKey: 'k' })
    // custom+openai resolve bare (gpt-4o — LiteLLM infers/rides the openai provider)
    const qualified = p === 'custom' || p === 'openai' ? 'gpt-4o' : `${p}/`
    if (!resolved.startsWith(qualified)) throw new Error(`${p}: unresolved model "${resolved}"`)
    const hits = resolved.split('/').filter((part: string) => part === p).length
    if (hits > 1) throw new Error(`${p}: provider prefix repeated in "${resolved}"`)
  }
  if (resolveModel({ token: 't', provider: 'openrouter', apiKey: 'k' }) !== 'openrouter/auto') throw new Error('openrouter auto unresolved')
  // a user-typed qualified model passes through the display string un-prefixed
  if (resolveModel({ token: 't', provider: 'openrouter', apiKey: 'k', model: 'anthropic/claude-3.5-sonnet' }) !== 'anthropic/claude-3.5-sonnet') {
    throw new Error('qualified user model was re-prefixed')
  }
  console.log('setup self-check OK (provider mapping)')
}