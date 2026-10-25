import * as fs from 'node:fs'
import * as path from 'node:path'

/** The root .env — the same file the gateway (require('dotenv')) and the Python tools
 *  (dotenv/set_key) read. next dev/start run with cwd = packages/dashboard, so the root
 *  is two levels up. COCO_ROOT relocates the data. */
export function envPath(): string {
  return process.env.COCO_ENV_PATH || path.join(repoRoot(), '.env')
}

export function repoRoot(): string {
  return process.env.COCO_ROOT || path.resolve(process.cwd(), '..', '..')
}

/** Dotenv parse — only what set_key-style writes need: `KEY=VALUE` lines and #-comments.
 *  Values with a `#` keep it (quote-stripping like dotenv's basic mode). */
function parse(content: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of content.split('\n')) {
    const key = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1]
    if (!key) continue
    const raw = line.slice(line.indexOf('=') + 1).trim()
    if (!raw || raw === '""' || raw === "''") continue
    const value = (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
      ? raw.slice(1, -1)
      : raw
    out[key] = value
  }
  return out
}

/** Upsert KEY=VALUE lines into .env — only the keys given in `vars` are touched.
 *  The Python side writes through dotenv's set_key; this is the same file format. */
export function writeEnv(vars: Record<string, string>): void {
  const file = envPath()
  fs.writeFileSync(file, serialize(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '', vars), 'utf8')
}

/** New content = existing lines minus the upserted keys, plus the new values last.
 *  A malformed .env falls back to dotenv's tolerant loader — still parseable. */
export function serialize(content: string, vars: Record<string, string>): string {
  const keys = Object.keys(vars)
  const keep = content
    .split('\n')
    .filter((line) => line.trim() && !keys.some((k) => new RegExp(`^\\s*(?:export\\s+)?${k}\\s*=`).test(line)))
  return [...keep, keys.map((k) => `${k}=${vars[k]}`).join('\n')].join('\n') + '\n'
}

/** Read a merged .env view — process.env over the file, like dotenv's load order. */
export function readEnv(): Record<string, string> {
  const disk = fs.existsSync(envPath()) ? parse(fs.readFileSync(envPath(), 'utf8')) : {}
  const live: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) live[k] = v
  return { ...live, ...disk }
}

if (process.argv[1]?.endsWith('env.ts')) {
  // round-trip + key-preserving upsert, against a throwaway .env
  fs.writeFileSync('/tmp/coco_env_check.env', 'TELEGRAM_BOT_TOKEN=old\n# comment\nOTHER=x\n', 'utf8')
  process.env.COCO_ENV_PATH = '/tmp/coco_env_check.env'
  writeEnv({ TELEGRAM_BOT_TOKEN: 'new' })
  const disk = fs.readFileSync('/tmp/coco_env_check.env', 'utf8')
  if (disk !== '# comment\nOTHER=x\nTELEGRAM_BOT_TOKEN=new\n') throw new Error('writeEnv mangled the file: ' + JSON.stringify(disk))
  if (readEnv().TELEGRAM_BOT_TOKEN !== 'new' || readEnv().OTHER !== 'x') throw new Error('readEnv wrong')
  // a value already containing `#` must survive a parse/serialize round-trip untouched
  writeEnv({ OTHER: 'val#ue' })
  if (parse(fs.readFileSync('/tmp/coco_env_check.env', 'utf8')).OTHER !== 'val#ue') throw new Error('inline # lost')
  fs.rmSync('/tmp/coco_env_check.env', { force: true })
  console.log('env self-check OK (.env upsert + read merge)')
}