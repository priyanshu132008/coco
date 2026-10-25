#!/usr/bin/env node
import { CdpEngineLoop, WebSocketBridge } from '@openinstinct/core'
import { dirname, join } from 'path'
import { spawn } from 'child_process'

const HELP = `
  ⚡ OpenInstinct v0.1.0 — live-hook AI browser agent
  ──────────────────────────────────────────────────────
  openinstinct start            launch the local stack: dashboard on http://127.0.0.1:8081
                                (vault + key setup UI) and the Telegram bot (long polling,
                                no public IP or tunnels needed)
  openinstinct run "<prompt>"    attach to your real Chrome (CDP :9222), run the model loop,
                                 stream live frames to ws://localhost:8080
  openinstinct serve             legacy EXECUTE_INTENT bridge on :8080
  openinstinct help              this message
`

const args = process.argv.slice(2)
const cmd = args[0] ?? 'help'

// Repo root — the python venvs and the gateway live there (this binary is built to <root>/dist).
const ROOT = process.env.OI_HOME || join(dirname(process.argv[1]), '..')

async function startCommand(): Promise<void> {
  console.log('  ⚡ OpenInstinct v0.1.0 — local stack')
  const py = process.env.OI_VAULT_PYTHON || '.venv-bu/bin/python'
  const pyBin = py.startsWith('/') ? py : ROOT + py

  // local dashboard/vault UI on :8081 (loopback); the gateway also spawns its own — fine
  try {
    const ui = spawn(pyBin, [ROOT + 'tools/vault_server.py'], { stdio: 'ignore' }).on('exit', () => {})
  } catch {}

  console.log('▸ dashboard/vault: http://127.0.0.1:8081/  (setup: http://127.0.0.1:8081/setup)')
  const gw = spawn('node', [ROOT + 'telegram_gateway/gateway.js'], { cwd: ROOT, stdio: 'inherit' })
  gw.on('exit', (code) => {
    if (code) console.error(`✖ gateway exited (${code}) — check TELEGRAM_BOT_TOKEN in .env`)
    process.exitCode = code ?? 1
  })
}

async function runCommand(prompt: string): Promise<void> {
  console.log('  ⚡ OpenInstinct v0.1.0 — live-hook AI browser agent')
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
} else if (cmd === 'run') {
  void runCommand(args[1] ?? 'Explore the current page')
} else if (cmd === 'serve') {
  console.log('  ⚡ OpenInstinct v0.1.0 — WebSocket bridge on ws://localhost:8080 (EXECUTE_INTENT protocol)')
  new WebSocketBridge(8080)
} else {
  console.log(HELP)
}