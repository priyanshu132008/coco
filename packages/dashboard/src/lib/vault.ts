import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

/** Where the assistant's data lives: vault.db and the tasks ledger at the repo root's
 *  .env side. The dashboard runs from packages/dashboard, so the root is two levels up;
 *  COCO_ROOT relocates the data (never the tools). */
function repoRoot(): string {
  return process.env.COCO_ROOT ?? path.resolve(process.cwd(), '..', '..')
}

/** Where the CODE lives — the tools/ helpers ship with the repo even when COCO_ROOT
 *  points the DATA (vault.db, .env, tasks.db) somewhere else. next dev/start run with
 *  cwd = packages/dashboard, so two levels up is the repo root. */
function codeRoot(): string {
  return process.env.COCO_CODE || path.resolve(process.cwd(), '..', '..')
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
  const root = codeRoot()
  for (const v of ['.venv-bu', '.venv']) {
    const p = path.join(root, v, 'bin', 'python')
    if (fs.existsSync(p)) return p
  }
  return 'python3'
}

/** The gateway's task ledger — the driver polls it for a relayed address. */
export function ledgerPath(): string {
  return process.env.COCO_DB_PATH ?? path.join(repoRoot(), 'telegram_gateway', 'tasks.db')
}

/** node:sqlite is new and optional — the chat-reply path still works without it. */
async function sqlite(): Promise<typeof import('node:sqlite') | null> {
  try {
    return await import('node:sqlite')
  } catch {
    return null
  }
}

/** A task waiting on a delivery address for this domain, if any.
 *  The driver is blocked in wait_for_location until a row shows up for its task. */
export async function taskWaitingForLocation(domain: string): Promise<number | null> {
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

/** Mini App vault write — local-first: JSON → tools/vault.py `put` → Fernet → vault.db. */
export function saveToVault(domain: string, fields: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(vaultPython(), [path.join(codeRoot(), 'tools', 'vault.py'), 'put'], {
      // vault.py knows COCO_VAULT_DB / COCO_ENV_PATH, not COCO_ROOT — translate
      cwd: codeRoot(),
      env: {
        ...process.env,
        COCO_VAULT_DB: process.env.COCO_VAULT_DB || path.join(repoRoot(), 'vault.db'),
        COCO_ENV_PATH: process.env.COCO_ENV_PATH || path.join(repoRoot(), '.env'),
      },
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
  const dbPath = '/tmp/coco_relay_check.db'
  fs.rmSync(dbPath, { force: true })
  process.env.COCO_DB_PATH = dbPath
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
  delete process.env.COCO_DB_PATH

  console.log('vault self-check OK (gate allowlist + aliases + address join + location relay)')
}
