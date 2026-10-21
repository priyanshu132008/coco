import * as fs from 'node:fs'
import * as path from 'node:path'

/** Where the assistant's real configuration lives: the repo root's .env and config.json.
 *  The dashboard runs from packages/dashboard, so the root is two levels up. */
export function repoRoot(): string {
  return process.env.OI_ROOT ?? path.resolve(process.cwd(), '..', '..')
}

export type Provider = 'openrouter' | 'openai' | 'anthropic' | 'custom'

/** Provider → the config.json fields byok.py expects, and the env key its key lives in.
 *  `model` is the BARE model name: byok.py prefixes the provider itself (except for
 *  provider "openai", which it passes through verbatim) — never pre-prefix it here. */
const PROVIDERS: Record<Provider, { provider: string; model: string; keyEnv: string }> = {
  openrouter: { provider: 'openrouter', model: 'auto', keyEnv: 'OPENROUTER_API_KEY' },
  openai: { provider: 'openai', model: 'gpt-4o', keyEnv: 'OPENAI_API_KEY' },
  anthropic: { provider: 'anthropic', model: 'claude-sonnet-5-5', keyEnv: 'ANTHROPIC_API_KEY' },
  // custom = any OpenAI-compatible gateway: the base URL and model name come from the form
  custom: { provider: 'openai', model: 'gpt-4o', keyEnv: 'OPENAI_API_KEY' },
}

export interface SetupInput {
  token: string
  provider: Provider
  apiKey: string
  baseUrl?: string
  model?: string
}

/** Merge keys into a .env file, leaving every other line untouched. */
export function mergeEnv(existing: string, entries: Record<string, string>): string {
  const wanted = new Set(Object.keys(entries))
  const kept = existing
    .split('\n')
    .filter((line) => {
      const m = /^([A-Z_][A-Z0-9_]*)=/.exec(line)
      return !(m && wanted.has(m[1]))
    })
    .join('\n')
    .replace(/\n+$/, '')
  const added = Object.entries(entries).map(([k, v]) => `${k}=${v}`)
  return [kept, ...added].filter(Boolean).join('\n') + '\n'
}

/** The .env + config.json writes a setup submission implies. */
export function planSetup(input: SetupInput): { env: Record<string, string>; config: { provider: string; active_model: string } } {
  const p = PROVIDERS[input.provider]
  const env: Record<string, string> = {
    TELEGRAM_BOT_TOKEN: input.token,
    [p.keyEnv]: input.apiKey,
  }
  if (input.provider === 'custom') {
    if (input.baseUrl) env.OPENAI_API_BASE = input.baseUrl
  }
  const config = {
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
  return { env, config }
}

/** Write .env + config.json, keeping a copy of the previous config. */
export function applySetup(input: SetupInput): void {
  const root = repoRoot()
  const { env, config } = planSetup(input)
  const envPath = path.join(root, '.env')
  const configPath = path.join(root, 'config.json')
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : ''
  fs.writeFileSync(envPath, mergeEnv(existing, env), { mode: 0o600 })
  if (fs.existsSync(configPath)) fs.copyFileSync(configPath, `${configPath}.bak`)
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
}

if (process.argv[1]?.endsWith('setup.ts')) {
  // self-check: the .env merge must replace our keys, keep the rest, and not duplicate
  const before = 'OLLAMA_API_KEY=abc\nTELEGRAM_BOT_TOKEN=old\n# a comment\nOI_VAULT_KEY=zzz\n'
  const after = mergeEnv(before, { TELEGRAM_BOT_TOKEN: 'new', OPENAI_API_KEY: 'k' })
  const lines = after.trim().split('\n')
  if (lines.filter((l) => l.startsWith('TELEGRAM_BOT_TOKEN=')).length !== 1) throw new Error('token not replaced exactly once')
  if (!after.includes('TELEGRAM_BOT_TOKEN=new')) throw new Error('token not updated')
  if (!after.includes('OLLAMA_API_KEY=abc') || !after.includes('# a comment')) throw new Error('unrelated lines dropped')
  if (!after.includes('OPENAI_API_KEY=k')) throw new Error('new key not added')
  const { env, config } = planSetup({ token: 't', provider: 'anthropic', apiKey: 'k' })
  if (env.ANTHROPIC_API_KEY !== 'k') throw new Error('anthropic key env wrong')
  if (config.active_model !== 'claude-sonnet-5-5' || config.provider !== 'anthropic') throw new Error('anthropic config wrong')
  const custom = planSetup({ token: 't', provider: 'custom', apiKey: 'k', baseUrl: 'http://x/v1', model: 'my-model' })
  if (custom.env.OPENAI_API_BASE !== 'http://x/v1') throw new Error('custom base url missing')
  // byok.py hands "openai" providers the model verbatim — keep the "openai/" prefix so
  // LiteLLM can still resolve the provider for a model name it has never heard of
  if (custom.config.active_model !== 'openai/my-model') throw new Error('custom model not used')
  // the provider prefix is added by byok.py, never baked into active_model — a doubled
  // prefix ("openrouter/openrouter/auto") is the bug this catches
  for (const p of Object.keys(PROVIDERS) as Provider[]) {
    const plan = planSetup({ token: 't', provider: p, apiKey: 'k' })
    const { provider, active_model: model } = plan.config
    // byok.py: provider "openai" passes the model through, everything else is prefixed
    const resolved = provider === 'openai' ? model : `${provider}/${model}`
    const hits = resolved.split('/').filter((part) => part === provider).length
    if (hits > 1) throw new Error(`${p}: provider prefix repeated in "${resolved}"`)
  }
  console.log('setup self-check OK (env merge + provider mapping)')
}
