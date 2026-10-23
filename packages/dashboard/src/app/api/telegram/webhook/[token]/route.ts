/** Multi-tenant webhook: each user bot gets its own URL —
 *  /api/telegram/webhook/<bot_token> — so the bot is known from the URL alone,
 *  no env reads. The token is resolved to its bot_credentials row by sha256
 *  (bot_credentials.token_hash); unknown tokens are rejected before anything runs. */
import { NextResponse } from 'next/server'
import { botForToken } from '../../../../../lib/telegram'
import { handleUpdate } from '../../../../../lib/webhook'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request, ctx: { params: { token: string } }): Promise<NextResponse> {
  let update: { message?: { chat?: { id?: number }; text?: string } }
  try {
    update = await req.json()
  } catch {
    return NextResponse.json({ ok: true }) // not a parseable update — ack, nothing to do
  }
  const chatId = update?.message?.chat?.id
  const text = (update?.message?.text || '').trim()
  if (!chatId || !text) return NextResponse.json({ ok: true })

  const token = decodeURIComponent(ctx.params.token)
  const bot = await botForToken(token)
  if (!bot) return NextResponse.json({ error: 'unknown bot token' }, { status: 401 })

  const origin = process.env.NEXT_PUBLIC_APP_URL || `https://${req.headers.get('host')}`
  return handleUpdate(chatId, text, token, bot.id, origin)
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ ok: true, webhook: 'armed (per-bot)' })
}