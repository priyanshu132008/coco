/** Telegram webhook receiver (hosted / Vercel) — INSERTs pending tasks into Supabase
 *  and routes chat decisions; the Python worker (tools/worker.py on Render) claims,
 *  executes and relays to the chat. Long-blocking work never happens here: the route
 *  must answer Telegram's webhook in well under a second. */
import { NextResponse } from 'next/server'
import {
  addRetry,
  createPendingTask,
  decideGate,
  isApprove,
  isDeny,
  isRetry,
  isStop,
  latestActive,
  otpCode,
  stopActiveTasks,
  tg,
} from '../../../../lib/telegram'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request): Promise<NextResponse> {
  // webhook secret (optional) — Telegram echoes it back in this header on every update
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET
  if (secret && req.headers.get('x-telegram-bot-api-secret-token') !== secret) {
    return NextResponse.json({ ok: false }, { status: 401 })
  }
  if (!process.env.TELEGRAM_BOT_TOKEN) {
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
  const chat = String(chatId)

  try {
    // explicit short-circuit first — before any DB write, task creation, or spawn:
    // slash commands are never goals, so execution stops completely here
    if (text === '/vault' || text === '/start') {
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || `https://${req.headers.get('host')}`
      await tg('sendMessage', {
        chat_id: chatId,
        text: '🔒 Open your secure credential and address vault:',
        reply_markup: {
          inline_keyboard: [[{ text: '🔒 Open Secure Vault', web_app: { url: `${appUrl}/vault` } }]],
        },
      })
      return NextResponse.json({ ok: true })
    }

    // cancellation: never becomes a task — flip the active rows; the worker SIGINTs its child
    if (isStop(text)) {
      const n = await stopActiveTasks(chat)
      await tg('sendMessage', {
        chat_id: chatId,
        text: n ? '🛑 Task cancelled. Agent stopped immediately.' : 'No running task to stop.',
      })
      return NextResponse.json({ ok: true })
    }

    // gate decisions: the worker tags the active task with task.gate when it asks for
    // something — approve/deny, an OTP, a delivery address, or a post-CAPTCHA retry
    const task = await latestActive(chat)
    if (task) {
      const gate = task.gate as string | null
      if (gate === 'approval' && (isApprove(text) || isDeny(text))) {
        await decideGate(task, { status: isApprove(text) ? 'approved' : 'denied' })
        return NextResponse.json({ ok: true })
      }
      if (gate === 'code' && otpCode(text)) {
        const code = otpCode(text) as string
        await decideGate(task, { code })
        await tg('sendMessage', { chat_id: chatId, text: 'Code received — typing it in.' })
        return NextResponse.json({ ok: true })
      }
      if (gate === 'location' && text.length >= 4 && !text.startsWith('/')) {
        await decideGate(task, { location: text })
        await tg('sendMessage', { chat_id: chatId, text: '📍 Address saved — the agent is typing it in.' })
        return NextResponse.json({ ok: true })
      }
      if (gate === 'captcha' && isRetry(text)) {
        await addRetry(Number(task.id))
        await tg('sendMessage', { chat_id: chatId, text: `🔄 Retrying ${String(task.gate_domain || 'the site')}…` })
        return NextResponse.json({ ok: true })
      }
      if (gate && (isApprove(text) || isDeny(text) || otpCode(text) || isRetry(text))) {
        // a decision-shaped reply with no matching gate — don't turn it into a goal
        await tg('sendMessage', { chat_id: chatId, text: "Noted — but I wasn't asking for that just now." })
        return NextResponse.json({ ok: true })
      }
    }

    // anything else is a goal → Supabase row ('pending') → the Render worker picks it up
    const taskId = await createPendingTask(chat, text)
    await tg('sendMessage', { chat_id: chatId, text: `Task #${taskId} received. Booting agent...` })
    return NextResponse.json({ ok: true, task_id: taskId })
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    console.error('[telegram-webhook] failed:', e)
    if (chatId) await tg('sendMessage', { chat_id: chatId, text: `Failed to enqueue the task: ${reason}` })
    return NextResponse.json({ ok: false, error: reason }, { status: 500 })
  }
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ ok: true, webhook: 'armed', bot: process.env.TELEGRAM_BOT_TOKEN ? 'configured' : 'missing' })
}