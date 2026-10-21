import { spawn } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

/** Where the assistant's real configuration lives: the repo root's .env and vault.db.
 *  The dashboard runs from packages/dashboard, so the root is two levels up. */
function repoRoot(): string {
  return process.env.OI_ROOT ?? path.resolve(process.cwd(), '..', '..')
}

export type Gate = 'credentials' | 'location' | 'card' | '2fa' | 'all'

/** The vault columns each gate may write — anything else in the body is dropped. */
export const GATE_FIELDS: Record<Gate, string[]> = {
  credentials: ['username', 'password'],
  location: ['address'],
  card: ['pan', 'cvv', 'expiry', 'upi'],
  '2fa': ['totp'],
  all: ['username', 'password', 'address', 'pan', 'cvv', 'expiry', 'upi', 'totp'],
}

/** Gate names the gateway and links may use → the gate we act on. */
const GATE_ALIASES: Record<string, Gate> = {
  credentials: 'credentials',
  credential: 'credentials',
  login: 'credentials',
  location: 'location',
  address: 'location',
  card: 'card',
  payment: 'card',
  '2fa': '2fa',
  totp: '2fa',
  all: 'all',
}

/** An unknown gate falls back to 'all' — the form then shows every field. */
export function resolveGate(raw: unknown): Gate {
  const key = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return GATE_ALIASES[key] ?? 'all'
}

/** Only the gate's own fields, only strings, only non-empty ones. */
export function pickFields(gate: Gate, body: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of GATE_FIELDS[gate]) {
    const v = body[name]
    if (typeof v === 'string' && v.trim()) out[name] = v.trim()
  }
  return out
}

/** The vault has one address column — a separate pincode rides along in it. */
export function joinAddress(address: string, pincode: string): string {
  if (!address) return pincode
  if (!pincode) return address
  return address.includes(pincode) ? address : `${address}, ${pincode}`
}

/** The venv that has cryptography + dotenv — the same one the runner uses. */
export function vaultPython(): string {
  const root = repoRoot()
  for (const v of ['.venv', '.venv-bu']) {
    const p = path.join(root, v, 'bin', 'python')
    if (fs.existsSync(p)) return p
  }
  return 'python3'
}

/** The gateway's task ledger — the driver polls it for a relayed address. */
export function ledgerPath(): string {
  return process.env.OI_DB_PATH ?? path.join(repoRoot(), 'telegram_gateway', 'tasks.db')
}

/** node:sqlite is new and optional — the chat-reply path still works without it. */
async function sqlite(): Promise<typeof import('node:sqlite') | null> {
  try {
    return await import('node:sqlite')
  } catch {
    return null
  }
}

/** Supabase REST + AES-256-GCM vault storage. The ciphertext format (base64 of
 *  nonce(12) || ciphertext || tag) is shared with tools/vault.py's `_decrypt` — locked
 *  by an embedded test vector on both sides. When Supabase is not configured the
 *  gateway-era local paths (tools/vault.py `put`, tasks.db) still run. */
const remote = (): boolean => Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)

async function sb<T = Record<string, unknown>>(
  method: string,
  table: string,
  opts: { filters?: string; select?: string; body?: unknown } = {},
): Promise<T[]> {
  const base = process.env.SUPABASE_URL!.replace(/\/+$/, '')
  const key = process.env.SUPABASE_SERVICE_KEY!
  const params: string[] = []
  if (opts.filters) params.push(opts.filters)
  if (opts.select) params.push(`select=${opts.select}`)
  const resp = await fetch(`${base}/rest/v1/${table}${params.length ? `?${params.join('&')}` : ''}`, {
    method,
    headers: {
      'content-type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${key}`,
      ...(method !== 'GET' ? { Prefer: 'return=representation' } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  })
  if (!resp.ok) throw new Error(`Supabase ${method} ${table} → ${resp.status}`)
  return (await resp.json()) as T[]
}

/** AES-256-GCM over OI_VAULT_KEY (base64 of the 32 raw bytes the Fernet key wraps). */
function aesEncrypt(plain: string): string {
  const keyB64 = process.env.OI_VAULT_KEY
  if (!keyB64) throw new Error('OI_VAULT_KEY missing — cannot encrypt vault fields')
  const key = Buffer.from(keyB64, 'base64').subarray(0, 32)
  if (key.length !== 32) throw new Error('OI_VAULT_KEY is not 32 bytes of key material')
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final(), cipher.getAuthTag()])
  return Buffer.concat([iv, ct]).toString('base64')
}
/** A task waiting on a delivery address for this domain, if any.
 *  The driver is blocked in wait_for_location until a row shows up for its task. */
export async function taskWaitingForLocation(domain: string): Promise<number | null> {
  if (remote()) {
    const rows = await sb<{ id: number }>('GET', 'tasks', {
      filters: `status=in.(running,booting)&goal=ilike.%25${domain}%25&order=id.desc`,
      select: 'id',
    })
    return rows[0] ? Number(rows[0].id) : null
  }
  const sq = await sqlite()
  if (!sq) return null
  let conn: import('node:sqlite').DatabaseSync | null = null
  try {
    conn = new sq.DatabaseSync(ledgerPath())
    const row = conn
      .prepare(
        "SELECT t.id FROM tasks t WHERE t.status IN ('running','booting') AND t.goal LIKE ? ORDER BY t.id DESC LIMIT 1"
      )
      .get(`%${domain}%`) as { id?: number } | undefined
    return row?.id ?? null
  } catch {
    return null
  } finally {
    conn?.close()
  }
}

/** Hand the address to the blocked driver the same way a chat reply would. */
export async function relayLocation(taskId: number, address: string): Promise<void> {
  if (remote()) {
    await sb('POST', 'pending_locations', { body: { task_id: taskId, location: address } })
    return
  }
  const sq = await sqlite()
  if (!sq) return
  const db = new sq.DatabaseSync(ledgerPath())
  try {
    db.prepare(
      "INSERT INTO pending_locations (task_id, location, created_at) VALUES (?, ?, datetime('now'))"
    ).run(taskId, address)
  } finally {
    db.close()
  }
}

/** Mini App vault write. Supabase (Vercel): AES-GCM in Node, no repo files needed.
 *  Local (gateway-era): JSON → tools/vault.py `put` → Fernet → vault.db. */
export function saveToVault(domain: string, fields: Record<string, string>): Promise<void> {
  if (remote()) {
    const cols: Record<string, string> = {
      username: 'enc_username', password: 'enc_password', totp: 'enc_totp', address: 'enc_address',
      upi: 'enc_upi', pan: 'enc_pan', cvv: 'enc_cvv', expiry: 'enc_expiry',
    }
    const enc: Record<string, string> = {}
    for (const [k, col] of Object.entries(cols)) {
      if (typeof fields[k] === 'string' && fields[k].trim()) enc[col] = aesEncrypt(fields[k].trim())
    }
    if (!Object.keys(enc).length) return Promise.resolve()
    const domainStr = domain.trim().toLowerCase()
    return sb('POST', 'accounts', {
      body: { domain: domainStr, label: 'mini-app', kind: 'custom', is_default: 1, ...enc },
      select: 'id',
    }).then(() => undefined)
  }
  return new Promise((resolve, reject) => {
    const child = spawn(vaultPython(), [path.join(repoRoot(), 'tools', 'vault.py'), 'put'], {
      cwd: repoRoot(),
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let err = ''
    child.stderr.on('data', (d) => {
      err += d.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(err.trim() || `vault helper exited ${code}`))
    })
    child.stdin.end(JSON.stringify({ domain, fields }))
  })
}

if (process.argv[1]?.endsWith('vault.ts')) {
  // self-check: the gate allowlist is a trust boundary — nothing outside it may be written
  const creds = pickFields('credentials', { username: 'a@b.c', password: 'pw', totp: 'SEED', address: 'x' })
  if (Object.keys(creds).join() !== 'username,password') throw new Error('credentials gate leaked: ' + JSON.stringify(creds))
  const card = pickFields('card', { pan: '4111', cvv: '123', expiry: '09/27', upi: 'a@bank', password: 'pw' })
  if (Object.keys(card).join() !== 'pan,cvv,expiry,upi') throw new Error('card gate leaked: ' + JSON.stringify(card))
  if (Object.keys(pickFields('2fa', { totp: 'SEED' })).join() !== 'totp') throw new Error('2fa gate wrong')
  if (Object.keys(pickFields('location', { address: 'a', pincode: '400001' })).join() !== 'address') {
    throw new Error('location gate wrong')
  }
  if (Object.keys(pickFields('all', { username: 'a', password: 'b', address: 'c', pan: 'd', cvv: 'e', expiry: 'f', upi: 'g', totp: 'h' })).length !== 8) {
    throw new Error('all gate incomplete')
  }
  if (Object.keys(pickFields('credentials', { username: '   ', password: '' })).length !== 0) throw new Error('blank fields kept')
  if (resolveGate('PAYMENT') !== 'card') throw new Error('gate alias failed')
  if (resolveGate('nonsense') !== 'all') throw new Error('unknown gate should fall back to all')
  if (joinAddress('Flat 4B, Mumbai', '400076') !== 'Flat 4B, Mumbai, 400076') throw new Error('pincode not joined')
  if (joinAddress('Flat 4B, 400076', '400076') !== 'Flat 4B, 400076') throw new Error('pincode duplicated')
  if (joinAddress('', '400076') !== '400076') throw new Error('pincode alone lost')

  // the relay is the one piece with real logic — check it against a throwaway ledger
  const { DatabaseSync } = await import('node:sqlite')
  const dbPath = '/tmp/oi_relay_check.db'
  fs.rmSync(dbPath, { force: true })
  process.env.OI_DB_PATH = dbPath
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, goal TEXT, status TEXT)')
  db.exec('CREATE TABLE pending_locations (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER, location TEXT, created_at TEXT)')
  db.prepare("INSERT INTO tasks (goal, status) VALUES ('order on shop.example.com', 'running')").run()
  db.prepare("INSERT INTO tasks (goal, status) VALUES ('order on other.com', 'done')").run()

  const id = await taskWaitingForLocation('shop.example.com')
  if (id !== 1) throw new Error(`expected task 1, got ${id}`)
  if ((await taskWaitingForLocation('other.com')) !== null) throw new Error('a finished task must not be matched')
  if ((await taskWaitingForLocation('nothing.com')) !== null) throw new Error('unknown domain should match no task')

  await relayLocation(id, 'Flat 4B, Mumbai, 400076')
  const row = db.prepare('SELECT task_id, location FROM pending_locations WHERE task_id = ?').get(id) as
    | { task_id: number; location: string }
    | undefined
  if (!row || row.location !== 'Flat 4B, Mumbai, 400076') throw new Error('relay did not land: ' + JSON.stringify(row))
  db.close()
  fs.rmSync(dbPath, { force: true })

  // AES-GCM contract with tools/vault.py — vault.py's self-check decrypts this exact vector
  process.env.OI_VAULT_KEY = 'T2RlbjIzNDU2Nzg5MDEyMzQ1Njc4OTBvbmluc3RpbmM='
  const raw = Buffer.from('AAECAwQFBgcICQoL9y2HsHJKjOgpHkvjlqHgrYhvIYJkFQA3H54orcfUjQpEYkc=', 'base64')
  const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(process.env.OI_VAULT_KEY, 'base64').subarray(0, 32), raw.subarray(0, 12))
  d.setAuthTag(raw.subarray(raw.length - 16))
  if (Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString('utf8') !== 'mini-app-aes-vector') {
    throw new Error('AES-GCM contract drifted')
  }
  const round = aesEncrypt('roundtrip')
  const rd = crypto.createDecipheriv('aes-256-gcm', Buffer.from(process.env.OI_VAULT_KEY, 'base64').subarray(0, 32), Buffer.from(round, 'base64').subarray(0, 12))
  rd.setAuthTag(Buffer.from(round, 'base64').subarray(Buffer.from(round, 'base64').length - 16))
  if (Buffer.concat([rd.update(Buffer.from(round, 'base64').subarray(12, Buffer.from(round, 'base64').length - 16)), rd.final()]).toString('utf8') !== 'roundtrip') {
    throw new Error('aesEncrypt roundtrip broke')
  }
  delete process.env.OI_VAULT_KEY

  console.log('vault self-check OK (gate allowlist + aliases + address join + location relay + AES contract)')
}
