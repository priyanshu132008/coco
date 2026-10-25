#!/usr/bin/env node
import { CdpEngineLoop, WebSocketBridge } from '@coco/core'
import { dirname, join } from 'path'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'fs'
import { homedir } from 'os'
import { spawn, spawnSync } from 'child_process'

const HELP = `
  ⚡ Coco v0.1.0 — local AI browser agent
  ──────────────────────────────────────────────────────
  coco configure        boot the dashboard (Next.js on http://localhost:3000) and open
                        http://localhost:3000/setup — enter the bot token + LLM key once
  coco online           run the Telegram gateway + local task workers only. No windows.
  coco stop             kill the gateway, task workers and dashboard
  coco health           check .env, vault key, SQLite files and keys; prints fixes
  coco run "<prompt>"    attach to your real Chrome (CDP :9222), run the model loop,
                         stream live frames to ws://localhost:8080
  coco serve            legacy EXECUTE_INTENT bridge on :8080
  coco help             this message
`

const args = process.argv.slice(2)
const cmd = args[0] ?? 'help'

/** The repo root holding tools/, telegram_gateway/ and packages/dashboard/.
 *  A global install (e.g. /opt/homebrew/bin/coco) symlinks the binary — realpath traces
 *  it back to the codebase; `npm i -g .` copies instead, so when the traced root is a
 *  package skeleton without the tools, fall back to where the user invoked it from. */
function repoRoot(): string {
  if (process.env.COCO_HOME) return process.env.COCO_HOME
  let fromBin: string | null = join(dirname(process.argv[1]), '..')
  try {
    fromBin = join(dirname(realpathSync(process.argv[1])), '..')
  } catch {
    // argv[1] missing/not a path (eval'ed) → cwd below
  }
  for (const candidate of [fromBin, process.cwd()]) {
    if (existsSync(join(candidate, 'tools', 'health.py'))) return candidate
  }
  console.error('✖ Coco code not found — run coco from the cloned repo, or set COCO_HOME to it.')
  process.exit(1)
}

// Repo root — the python venvs and the gateway live there (this binary is built to <root>/dist).
const ROOT = repoRoot()
const PY = process.env.COCO_VAULT_PYTHON || '.venv-bu/bin/python'
const DASHBOARD = 'http://localhost:3000'
const DASHBOARD_DIR = join(ROOT, 'packages', 'dashboard')

/** Spawn the Next.js dashboard (next dev on :3000) and resolve once it answers HTTP. */
async function ensureDashboard(): Promise<void> {
  if (await isUp(DASHBOARD)) return
  // deps pruned by a workspace install while the app was deleted → restore before next
  if (!joinFileSync(DASHBOARD_DIR, 'node_modules', 'next') && !joinFileSync(ROOT, 'node_modules', 'next')) {
    console.log('▸ installing dashboard dependencies (first run)…')
    require('child_process').spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: ROOT, stdio: 'inherit' })
  }
  const nextBin = joinFileSync(DASHBOARD_DIR, 'node_modules', 'next', 'dist', 'bin', 'next')
    || joinFileSync(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next')
  if (!nextBin) {
    console.error(`✖ next not found — run "npm install" in ${ROOT}`)
    process.exitCode = 1
    return
  }
  if (!joinFileSync(ROOT, 'packages', 'core', 'dist', 'index.js')) {
    console.log('▸ building @coco/core (first run)…')
    require('child_process').spawnSync('npm', ['run', 'build:core'], { cwd: ROOT, stdio: 'inherit' })
  }
  const next = spawn(process.execPath, [nextBin, 'dev', '-p', '3000'], {
    cwd: DASHBOARD_DIR,
    env: { ...process.env, BROWSER: 'none' }, // next may try to auto-open — the CLI opens below
    stdio: 'inherit',
    detached: true,
  })
  next.on('error', () => {
    console.error(`✖ could not start the dashboard — run "npm install" in ${DASHBOARD_DIR}`)
    process.exitCode = 1
  })
  // next dev compiles pages on first hit — until :3000 answers, nothing to show yet
  for (let i = 0; i < 90; i += 1) {
    await new Promise((r) => setTimeout(r, 1000))
    if (await isUp(DASHBOARD)) {
      console.log(`▸ dashboard ready: ${DASHBOARD}`)
      return
    }
  }
  console.error('✖ dashboard did not come up on :3000 within 90s — check its output above')
  process.exitCode = 1
}

const joinFileSync = (...parts: string[]): string => {
  try {
    require('fs').accessSync(require('path').join(...parts))
    return join(...parts)
  } catch {
    return ''
  }
}

/** True when something answers on `base` (any HTTP response counts, 404s included). */
async function isUp(base: string): Promise<boolean> {
  return new Promise((resolve) => {
    import('http').then(({ get }) => {
      const req = get(base, (r) => {
        r.resume()
        resolve(true)
      })
      req.on('error', () => resolve(false))
      req.setTimeout(800, () => { req.destroy(); resolve(false) })
    })
  })
}

/** Open a browser tab — native opener, the npm `open` package carries no weight here. */
function openBrowser(url: string): void {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  spawn(opener, [url], { shell: process.platform === 'win32' })
    .on('error', () => console.log(`▸ open ${url} manually in your browser`))
}

// Bring the dashboard up if needed, then open `path` in the browser.
async function serveOrOpen(path: string): Promise<void> {
  await ensureDashboard()
  if (process.exitCode) return // dashboard failed to boot — don't open a dead URL
  openBrowser(DASHBOARD + path)
}

/** Run the long-polling gateway + its local python workers. The gateway exits 3 when
 *  /api/setup changed the bot token in .env — respawn it so the new token takes effect.
 *  An inherited TELEGRAM_BOT_TOKEN would beat dotenv's no-override load, so strip it and
 *  let the gateway read .env fresh every boot. No browser windows — that's `configure`. */
function spawnGateway(): void {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { TELEGRAM_BOT_TOKEN, ...rest } = process.env
  const gw = spawn('node', [join(ROOT, 'telegram_gateway/gateway.js')], {
    cwd: ROOT, stdio: 'inherit', env: { ...rest, BROWSER: 'none' },
  })
  gw.on('exit', (code, signal) => {
    if (code === 3) {
      console.log('▸ .env updated — gateway restarted with the new bot token')
      spawnGateway()
      return
    }
    if (signal) {
      console.log('▸ gateway stopped') // coco stop / external SIGTERM — deliberate, not a failure
      return
    }
    if (code) console.error(`✖ gateway exited (${code}) — check TELEGRAM_BOT_TOKEN in .env`)
    process.exitCode = code ?? 1
  })
}

/** coco online — the bot only. Long polling + per-task python runner subprocesses. */
function onlineCommand(): void {
  console.log('  ⚡ Coco is online and listening…')
  console.log('  · Telegram: message your bot (Ctrl-C to stop; `coco stop` kills cleanly)')
  console.log('  · Tasks: the runner runs each goal as an isolated subprocess (5 min hard cap, COCO_TASK_TIMEOUT)') // prettier-ignore
  spawnGateway()
}

/** coco stop — kill every stack process: gateway, python runners, Next dashboard. */
function stopCommand(): void {
  if (process.platform === 'win32') {
    console.error('✖ coco stop is not implemented on Windows — kill the node/python processes manually.')
    process.exitCode = 1
    return
  }
  // The gateway may run under launchd KeepAlive — pkill alone is whack-a-mole: launchd
  // respawns it instantly. Boot any LaunchAgents unit that runs gateway.js out first.
  if (process.platform === 'darwin') {
    try {
      const uid = process.getuid?.() ?? 501
      for (const f of readdirSync(join(homedir(), 'Library/LaunchAgents'))) {
        if (!f.endsWith('.plist')) continue
        const body = readFileSync(join(homedir(), 'Library/LaunchAgents', f), 'utf8')
        if (!body.includes('telegram_gateway/gateway.js')) continue
        const label = f.replace(/\.plist$/, '')
        spawnSync('launchctl', ['bootout', `gui/${uid}/${label}`], { stdio: 'ignore' })
        console.log(`✔ stopped launchd service ${label} (KeepAlive would respawn it)`)
        stopped += 1
      }
    } catch {
      // no LaunchAgents dir / unreadable — plain pkill below still applies
    }
  }
  const targets: [string, string][] = [
    ['gateway', 'telegram_gateway/gateway.js'],
    ['browser driver (worker)', 'tools/browser_driver.py'],
    ['agent runner (worker)', 'tools/agent_runner.py'],
    ['dashboard (next :3000)', 'dist/bin/next dev -p 3000'],
  ]
  let stopped = 0
  for (const [label, pattern] of targets) {
    if (spawnSync('pkill', ['-f', pattern], { stdio: 'ignore' }).status === 0) {
      console.log(`✔ stopped ${label}`)
      stopped += 1
    }
  }
  // sweep: pattern kills can miss, but nothing legit should still hold :3000
  const pids = spawnSync('bash', ['-c', 'lsof -tiTCP:3000 -sTCP:LISTEN || true'], { stdio: 'pipe' })
    .stdout.toString()
    .trim()
  for (const pid of pids.split('\n').filter(Boolean)) {
    try {
      process.kill(Number(pid), 'SIGTERM')
      console.log(`✔ stopped dashboard pid ${pid} (:3000 listener)`)
      stopped += 1
    } catch {
      // pid vanished between lsof and kill — nothing to stop
    }
  }
  console.log(stopped ? `Coco stack stopped (${stopped} processes).` : 'Coco is not running.')
}

async function runCommand(prompt: string): Promise<void> {
  console.log('  ⚡ Coco v0.1.0 — live-hook AI browser agent')
  console.log('  ──────────────────────────────────────────────────────')
  console.log(`▸ prompt: "${prompt}"`)
  console.log('▸ engine: ws://localhost:8080')
  const loop = new CdpEngineLoop()
  try {
    const r = await loop.run(prompt)
    console.log(`✔ done — ${r.steps} steps${r.hitl ? ' (incl. human-in-the-loop pause)' : ''}`)
    await loop.stop()
  } catch (err) {
    console.error(`✖ ${err instanceof Error ? err.message : err}`)
    process.exitCode = 1
  }
}

if (cmd === 'configure') {
  console.log('▸ booting the dashboard — the setup page is linked from the home page')
  void serveOrOpen('/')
} else if (cmd === 'online') {
  onlineCommand()
} else if (cmd === 'stop') {
  stopCommand()
} else if (cmd === 'health') {
  const pyBin = PY.startsWith('/') ? PY : join(ROOT, PY)
  const h = spawn(pyBin, [join(ROOT, 'tools/health.py')], { cwd: ROOT, stdio: 'inherit' })
  h.on('exit', (code) => { process.exitCode = code ?? 1 })
} else if (cmd === 'run') {
  void runCommand(args[1] ?? 'Explore the current page')
} else if (cmd === 'serve') {
  console.log('  ⚡ Coco v0.1.0 — WebSocket bridge on ws://localhost:8080 (EXECUTE_INTENT protocol)')
  new WebSocketBridge(8080)
} else {
  console.log(HELP)
}