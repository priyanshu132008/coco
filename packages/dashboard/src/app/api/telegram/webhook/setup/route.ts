/** One-shot webhook registration against api.telegram.org (Phase 3 setup).
 *  GET /api/telegram/webhook/setup            → setWebhook to this deployment's URL
 *  GET /api/telegram/webhook/setup?url=...    → explicit URL override
 *  GET /api/telegram/webhook/setup?mode=delete → deleteWebhook (back to long polling) */
import { NextResponse } from 'next/server'
import { publicUrl, tg } from '../../../../../lib/telegram'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request): Promise<NextResponse> {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    return NextResponse.json({ error: 'TELEGRAM_BOT_TOKEN missing' }, { status: 500 })
  }
  const { searchParams } = new URL(req.url)
  if (searchParams.get('mode') === 'delete') {
    await tg('deleteWebhook', { drop_pending_updates: true })
    return NextResponse.json({ ok: true, mode: 'deleted' })
  }

  // Render injects RENDER_EXTERNAL_URL; query ?url= wins when neither env is usable
  const base = searchParams.get('url') || publicUrl()
  if (!base) {
    return NextResponse.json({ error: 'no public URL — pass ?url=https://<host> or set OI_PUBLIC_URL' }, { status: 400 })
  }
  const webhookUrl = `${base.replace(/\/+$/, '')}/api/telegram/webhook`
  await tg('setWebhook', {
    url: webhookUrl,
    ...(process.env.TELEGRAM_WEBHOOK_SECRET ? { secret_token: process.env.TELEGRAM_WEBHOOK_SECRET } : {}),
    drop_pending_updates: true,
    allowed_updates: ['message'],
  })
  return NextResponse.json({ ok: true, url: webhookUrl })
}