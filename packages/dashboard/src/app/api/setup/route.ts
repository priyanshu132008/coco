import { NextResponse } from 'next/server'
import { applySetup, type Provider } from '../../../lib/setup'

const PROVIDERS: Provider[] = ['openrouter', 'openai', 'anthropic', 'custom']

/** Read the bot's @username from a token — the setup page greets the user with it. */
async function botName(token: string): Promise<string> {
  const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, { cache: 'no-store' })
  if (!res.ok) throw new Error('Telegram rejected that token.')
  const data = (await res.json()) as { ok?: boolean; result?: { username?: string }; description?: string }
  if (!data.ok || !data.result?.username) throw new Error(data.description || 'Telegram rejected that token.')
  return data.result.username
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
    applySetup({ token, provider, apiKey, baseUrl, model })
    return NextResponse.json({ botName: name })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Setup failed.' }, { status: 502 })
  }
}
