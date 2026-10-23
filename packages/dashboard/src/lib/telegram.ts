/** Supabase task ledger for serverless hosting (Vercel) — no sqlite, no child processes.
 *
 *  The webhook INSERTs tasks with status 'pending'; a Python worker (tools/worker.py on
 *  Render) claims them, runs the agent and relays Telegram messages itself. Chat decisions
 *  (approve/deny/OTP/address/retry) route through task.gate set by the worker.
 *  Same PostgREST tables the Python side reads (supabase/schema.sql). Multi-tenant: each
 *  update names its bot via the webhook URL — /api/telegram/webhook/[bot_token] — and the
 *  task row carries that bot's id (bot_id), so two users' chats never collide. */
import * as crypto from 'node:crypto'
import { sbUrl, sbKey } from './supabase'
export const ROOT = process.cwd()

/** One PostgREST call against Supabase with the service key. */
async function sb<T = Record<string, unknown>>(
  method: string,
  table: string,
  opts: { filters?: string; select?: string; body?: unknown; prefer?: string } = {},
): Promise<T[]> {
  const base = sbUrl()
  const key = sbKey()
  if (!base || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY missing')
  const params: string[] = []
  if (opts.filters) params.push(opts.filters)
  if (opts.select) params.push(`select=${opts.select}`)
  const resp = await fetch(
    `${base.replace(/\/+$/, '')}/rest/v1/${table}${params.length ? `?${params.join('&')}` : ''}`,
    {
      method,
      headers: {
        'content-type': 'application/json',
        apikey: key,
        Authorization: `Bearer ${key}`,
        ...(opts.prefer ? { Prefer: opts.prefer } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    },
  )
  if (!resp.ok) throw new Error(`Supabase ${method} ${table} → ${resp.status}`)
  return (await resp.json()) as T[]
}

const STOP_RE = /^\/?(stop|stoppp|cancel)[\s!.]*$/i
const APPROVE_RE = /^(yes|approve|approved|confirm|ok|go)\b/i
const DENY_RE = /^(no|deny|denied)\b/i
const CODE_RE = /^\s*(?:otp\s*)?(\d{6})\s*$/i
const RETRY_RE = /^\/?(retry|again|resume)\b/i

export const isStop = (text: string): boolean => STOP_RE.test(text)
export const isApprove = (text: string): boolean => APPROVE_RE.test(text)
export const isDeny = (text: string): boolean => DENY_RE.test(text)
export const otpCode = (text: string): string | null => text.match(CODE_RE)?.[1] ?? null
export const isRetry = (text: string): boolean => RETRY_RE.test(text)

/** sha256 hex of a bot token — the lookup key bot_credentials.token_hash stores. */
export function botTokenHash(token: string): string {
  return crypto.createHash('sha256').update(token.trim()).digest('hex')
}

/** The bot row (id + model) for a plaintext token, via its hash — null when unregistered. */
export async function botForToken(token: string): Promise<{ id: number } | null> {
  const rows = await sb<{ id: number }>('GET', 'bot_credentials', {
    filters: `token_hash=eq.${botTokenHash(token)}`,
    select: 'id',
  })
  return rows[0] ?? null
}

async function tasksFor(chatId: string, filters: string): Promise<Record<string, unknown>[]> {
  return sb('GET', 'tasks', { filters: `phone_number=eq.${chatId}${filters ? `&${filters}` : ''}`, select: 'id,status,gate,gate_domain' })
}

/** The newest task of this chat that is still alive (the worker may still be claiming it). */
export async function latestActive(chatId: string): Promise<Record<string, unknown> | null> {
  const rows = await tasksFor(chatId, "status=in.(pending,running,booting)&order=id.desc")
  return rows[0] ?? null
}

/** /stop: flip every active task to 'cancelled' — the worker SIGINTs its own runner. */
export async function stopActiveTasks(chatId: string): Promise<number> {
  const rows = await tasksFor(chatId, "status=in.(pending,running,booting)")
  for (const row of rows) {
    await sb('PATCH', 'tasks', { filters: `id=eq.${row.id}`, body: { status: 'cancelled' } })
  }
  return rows.length
}

/** The webhook's one job for a goal: INSERT pending — the worker on Render does the rest.
 *  bot_id ties the task to the bot the message arrived on (null = platform default bot). */
export async function createPendingTask(chatId: string, goal: string, botId?: number | null): Promise<number> {
  const out = await sb('POST', 'tasks', {
    body: { phone_number: chatId, goal, status: 'pending', ...(botId ? { bot_id: botId } : {}) },
    select: 'id',
    prefer: 'return=representation',
  })
  const id = (out[0] as { id?: number } | undefined)?.id
  if (!id) throw new Error('tasks insert returned no id')
  return Number(id)
}

/** Gate decision from the chat → the ledger row the Python driver polls. Clearing `gate`
 *  is what keeps a stray "approve" from pre-approving the next checkout. */
export async function decideGate(
  task: Record<string, unknown>,
  decision: { status?: string; code?: string; location?: string },
): Promise<void> {
  const task_id = Number(task.id)
  const body: Record<string, unknown> = { gate: null }
  if (decision.status) body.status = decision.status
  await sb('PATCH', 'tasks', { filters: `id=eq.${task_id}`, body })
  if (decision.code) {
    await sb('POST', 'pending_codes', { body: { task_id, domain: task.gate_domain ?? null, code: decision.code } })
  }
  if (decision.location) {
    await sb('POST', 'pending_locations', { body: { task_id, location: decision.location } })
  }
}

/** chat 'retry' after a Cloudflare pause → the row wait_for_retry polls. */
export async function addRetry(taskId: number): Promise<void> {
  await sb('POST', 'retries', { body: { task_id: taskId } })
}

/** Public origin: Render injects RENDER_EXTERNAL_URL; ?url= overrides in the setup route. */
export function publicUrl(): string | undefined {
  return process.env.OI_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || undefined
}

export const vaultUrl = (): string =>
  process.env.OI_VAULT_URL || (publicUrl() ? `${publicUrl()}/vault` : 'http://localhost:3000/vault')

/** Best-effort reply — a failed sendMessage must never fail the webhook (Telegram redelivers).
 *  token: the sending bot's token (multi-tenant default is the platform env token). */
export async function tg(method: string, body: Record<string, unknown>, token = process.env.TELEGRAM_BOT_TOKEN): Promise<void> {
  if (!token) return
  await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {})
}