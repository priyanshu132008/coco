#!/usr/bin/env node
import { CdpEngineLoop, WebSocketBridge } from '@coco/core'
import { dirname, join } from 'path'
import { spawn } from 'child_process'

const HELP = `
  ⚡ Coco v0.1.0 — local AI browser agent
  ──────────────────────────────────────────────────────
  coco start            launch the local stack: dashboard on http://127.0.0.1:8081
                        (vault + key setup UI, opened in your browser) and the
                        Telegram bot (long polling — no public IP or tunnels needed)
  coco configure        open the key-setup page (LLM provider key, bot token)
  coco health           check .env, vault key, SQLite files and keys; prints fixes
  coco run "<prompt>"    attach to your real Chrome (CDP :9222), run the model loop,
                         stream live frames to ws://localhost:8080
  coco serve             legacy EXECUTE_INTENT bridge on :8080
  coco help              this message
`

const args = process.argv.slice(2)
const cmd = args[0] ?? 'help'

// Repo root — the python venvs and the gateway live there (this binary is built to <root>/dist).
const ROOT = process.env.COCO_HOME || join(dirname(process.argv[1]), '..')
const PY = process.env.COCO_VAULT_PYTHON || '.venv-bu/bin/python'
const DASHBOARD = 'http://127.0.0.1:8081'

// Start the dashboard if nothing is listening on :8081, then open the URL.
// Fresh instance → vault_server auto-opens via webbrowser (COCO_OPEN_BROWSER);
// already-running → open from here.
async function serveOrOpen(path: string): Promise<void> {
  const up = await new Promise<boolean>((resolve) => {
    import('http').then(({ get }) => {
      const req = get(DASHBOARD + path, (r) => {
        r.resume()
        resolve(true)
      })
      req.on('error', () => resolve(false))
      req.setTimeout(800, () => { req.destroy(); resolve(false) })
    })
  })
  if (!up) {
    spawn(join(ROOT, PY), [join(ROOT, 'tools/vault_server.py')], {
      stdio: 'ignore', cwd: ROOT,
      env: { ...process.env, COCO_OPEN_BROWSER: '1' },
    })
    await new Promise((r) => setTimeout(r, 1500))
  } else {
    const url = `${DASHBOARD}${path}`
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
    spawn(opener, [url], { shell: process.platform === 'win32' })
      .on('error', () => console.log(`▸ open ${url} manually in your browser`))
  }
}

async function startCommand(): Promise<void> {
  console.log('  ⚡ Coco v0.1.0 — local stack')
  await serveOrOpen('/')
  console.log(`▸ dashboard/vault: ${DASHBOARD}/  (setup: ${DASHBOARD}/setup)`)
  const gw = spawn('node', [join(ROOT, 'telegram_gateway/gateway.js')], {
    cwd: ROOT, stdio: 'inherit',
    env: { ...process.env, COCO_OPEN_BROWSER: '' }, // daemon-spawned UI never pops a browser
  })
  gw.on('exit', (code) => {
    if (code) console.error(`✖ gateway exited (${code}) — check TELEGRAM_BOT_TOKEN in .env`)
    process.exitCode = code ?? 1
  })
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

if (cmd === 'start') {
  void startCommand()
} else if (cmd === 'configure') {
  console.log('▸ opening the key setup page…')
  void serveOrOpen('/setup')
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