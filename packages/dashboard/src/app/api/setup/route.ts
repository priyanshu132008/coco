import { NextResponse } from 'next/server'
import { writeEnv } from '../../../lib/env'
import { resolveModel, type Provider } from '../../../lib/setup'
import { writeConfigJson } from '../../../lib/configJson'

const PROVIDERS: Provider[] = ['openrouter', 'openai', 'anthropic', 'custom']

/** Read the bot's @username from a token — the setup page greets the user with it. */
async function botName(token: string): Promise<string> {
  const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, { cache: 'no-store' })
  if (!res.ok) throw new Error('Telegram rejected that token.')
  const data = (await res.json()) as { ok?: boolean; result?: { username?: string }; description?: string }
  if (!data.ok || !data.result?.username) throw new Error(data.description || 'Telegram rejected that token.')
  return data.result.username
}

/** Provider → the .env name its API key goes under. LiteLLM (byok.py) reads these verbatim;
 *  custom gateways are OpenAI-compatible, so the key rides OPENAI_API_KEY + OPENAI_API_BASE. */
const KEY_ENV: Record<Provider, string> = {
  openrouter: 'OPENROUTER_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  custom: 'OPENAI_API_KEY',
}

export async function POST(req: Request): Promise<NextResponse> {
  let body: { token?: unknown; provider?: unknown; apiKey?: unknown; baseUrl?: unknown; model?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'body must be JSON' }, { status: 400 })
  }
  const token = typeof body.token === 'string' ? body.token.trim() : ''
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
  const provider = PROVIDERS.includes(body.provider as Provider) ? (body.provider as Provider) : null
  const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : undefined
  const model = typeof body.model === 'string' ? body.model.trim() : undefined

  if (!token) return NextResponse.json({ error: 'Telegram Bot Token is required.' }, { status: 400 })
  if (!provider) return NextResponse.json({ error: 'Pick a provider.' }, { status: 400 })
  if (!apiKey) return NextResponse.json({ error: 'API Key is required.' }, { status: 400 })
  if (provider === 'custom' && !baseUrl) {
    return NextResponse.json({ error: 'Custom providers need a base URL.' }, { status: 400 })
  }

  try {
    const name = await botName(token)
    // local-first: the .env beside vault.db is the only store — the same file the gateway,
    // runner and health tool read; config.json carries the resolved LiteLLM model.
    const env: Record<string, string> = { TELEGRAM_BOT_TOKEN: token }
    if (provider === 'custom') env.OPENAI_API_BASE = baseUrl as string
    env[KEY_ENV[provider]] = apiKey
    writeEnv(env)
    writeConfigJson({ token, provider, apiKey, baseUrl, model })
    return NextResponse.json({ botName: name, model: resolveModel({ token, provider, apiKey, baseUrl, model }) })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Setup failed.' }, { status: 502 })
  }
}