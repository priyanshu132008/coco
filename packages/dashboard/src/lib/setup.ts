/** Setup form → the config the backend expects. Secrets go to Supabase bot_credentials
 *  (encrypted) — never to files: serverless filesystems are read-only and local .env
 *  writes made the multi-tenant path impossible. */

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

/** The LiteLLM model string a provider submission resolves to. */
export function planSetup(input: SetupInput): { provider: string; active_model: string } {
  const p = PROVIDERS[input.provider]
  return {
    provider: p.provider,
    // byok.py passes "openai" models through verbatim and prefixes everything else with
    // the provider — so a custom gateway needs the "openai/" prefix to survive that step.
    active_model:
      p.provider === 'openai'
        ? input.provider === 'custom'
          ? `openai/${input.model || 'gpt-4o'}`
          : p.model
        : p.model,
  }
}

if (process.argv[1]?.endsWith('setup.ts')) {
  // self-check: the provider mapping only — byok.py hands "openai" providers the model
  // verbatim, so a custom model must keep its "openai/" prefix and others must not double up
  if (planSetup({ token: 't', provider: 'anthropic', apiKey: 'k' }).active_model !== 'claude-sonnet-5-5') throw new Error('anthropic config wrong')
  const custom = planSetup({ token: 't', provider: 'custom', apiKey: 'k', baseUrl: 'http://x/v1', model: 'my-model' })
  if (custom.active_model !== 'openai/my-model') throw new Error('custom model not used')
  for (const p of Object.keys(PROVIDERS) as Provider[]) {
    const { provider, active_model: model } = planSetup({ token: 't', provider: p, apiKey: 'k' })
    // byok.py: provider "openai" passes the model through, everything else is prefixed
    const resolved = provider === 'openai' ? model : `${provider}/${model}`
    const hits = resolved.split('/').filter((part) => part === provider).length
    if (hits > 1) throw new Error(`${p}: provider prefix repeated in "${resolved}"`)
  }
  console.log('setup self-check OK (provider mapping)')
}