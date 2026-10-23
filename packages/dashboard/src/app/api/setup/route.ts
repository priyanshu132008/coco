import * as crypto from 'node:crypto'
import { NextResponse } from 'next/server'
import { aesEncrypt } from '../../../lib/vault'
import { sbUrl, sbKey, sbRemote } from '../../../lib/supabase'
import { resolveModel, type Provider } from '../../../lib/setup'

const PROVIDERS: Provider[] = ['openrouter', 'openai', 'anthropic', 'custom']

/** Read the bot's @username from a token — the setup page greets the user with it. */
async function botName(token: string): Promise<string> {
  const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, { cache: 'no-store' })
  if (!res.ok) throw new Error('Telegram rejected that token.')
  const data = (await res.json()) as { ok?: boolean; result?: { username?: string }; description?: string }
  if (!data.ok || !data.result?.username) throw new Error(data.description || 'Telegram rejected that token.')
  return data.result.username
}

async function saveBot(input: { token: string; apiKey: string; baseUrl?: string; model?: string; provider: Provider }): Promise<void> {
  const model = resolveModel(input)
  const body = {
    token: aesEncrypt(input.token),
    token_hash: crypto.createHash('sha256').update(input.token).digest('hex'),
    api_key: aesEncrypt(input.apiKey),
    model: model,
    api_base: input.baseUrl || null,
  }
  const base = sbUrl().replace(/\/+$/, '')
  const key = sbKey()
  const resp = await fetch(`${base}/rest/v1/bot_credentials`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${key}`,
      // upsert on the token_hash unique constraint — resubmitting the same bot updates it
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(body),
  })
  if (!resp.ok) throw new Error(`Could not save the bot credentials (Supabase ${resp.status}).`)
}

/** Point this bot's webhook at the dynamic per-bot route on this deployment. */
async function registerWebhook(token: string, origin: string): Promise<void> {
  const webhookUrl = `${origin.replace(/\/+$/, '')}/api/telegram/webhook/${encodeURIComponent(token)}`
  await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      url: webhookUrl,
      drop_pending_updates: true,
      allowed_updates: ['message'],
      ...(process.env.TELEGRAM_WEBHOOK_SECRET ? { secret_token: process.env.TELEGRAM_WEBHOOK_SECRET } : {}),
    }),
  }).catch(() => undefined) // registration failing mustn't fail setup — /api/telegram/webhook/setup can re-run
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
  if (!sbRemote()) {
    return NextResponse.json({ error: 'Supabase is not configured — set SUPABASE_URL and SUPABASE_SERVICE_KEY (or the dashboard names NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).' }, { status: 503 })
  }
  if (provider === 'custom' && !baseUrl) {
    return NextResponse.json({ error: 'Custom providers need a base URL.' }, { status: 400 })
  }

  try {
    const name = await botName(token)
    // the only store — serverless filesystems are read-only, and file writes never were
    // multi-tenant (a missing Supabase env must surface as an error, not a fallback write)
    await saveBot({ token, apiKey, baseUrl, model, provider })
    const origin = process.env.NEXT_PUBLIC_APP_URL || `https://${req.headers.get('host')}`
    await registerWebhook(token, origin)
    return NextResponse.json({ botName: name })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Setup failed.' }, { status: 502 })
  }
}