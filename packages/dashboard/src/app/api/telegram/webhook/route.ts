/** Platform webhook receiver (hosted / Vercel) — the single-bot fallback. If the env
 *  token matches a registered bot_credentials row the task carries that bot_id; user
 *  bots use /api/telegram/webhook/[bot_token] instead. INSERTs pending tasks into
 *  Supabase and routes chat decisions; the Python worker (tools/worker.py on Render)
 *  claims, executes and relays to the chat — long-blocking work never happens here. */
import { NextResponse } from 'next/server'
import { botForToken } from '../../../../lib/telegram'
import { handleUpdate } from '../../../../lib/webhook'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request): Promise<NextResponse> {
  // webhook secret (optional) — Telegram echoes it back in this header on every update
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET
  if (secret && req.headers.get('x-telegram-bot-api-secret-token') !== secret) {
    return NextResponse.json({ ok: false }, { status: 401 })
  }
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  if (!botToken) {
    return NextResponse.json({ error: 'TELEGRAM_BOT_TOKEN missing' }, { status: 500 })
  }

  let update: { message?: { chat?: { id?: number }; text?: string } }
  try {
    update = await req.json()
  } catch {
    return NextResponse.json({ ok: true }) // not a parseable update — ack, nothing to do
  }
  const chatId = update?.message?.chat?.id
  const text = (update?.message?.text || '').trim()
  if (!chatId || !text) return NextResponse.json({ ok: true })

  const bot = await botForToken(botToken).catch(() => null)
  const origin = process.env.NEXT_PUBLIC_APP_URL || `https://${req.headers.get('host')}`
  return handleUpdate(chatId, text, botToken, bot?.id, origin)
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ ok: true, webhook: 'armed', bot: process.env.TELEGRAM_BOT_TOKEN ? 'configured' : 'missing' })
}