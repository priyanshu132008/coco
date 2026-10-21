#!/usr/bin/env node
import { CdpEngineLoop, WebSocketBridge } from '@openinstinct/core'

const HELP = `
  ⚡ OpenInstinct v0.1.0 — live-hook AI browser agent
  ──────────────────────────────────────────────────────
  openinstinct run "<prompt>"    attach to your real Chrome (CDP :9222), run the model loop,
                                 stream live frames to ws://localhost:8080 → dashboard on :3000
  openinstinct serve             legacy EXECUTE_INTENT bridge on :8080
  openinstinct help              this message
`

const args = process.argv.slice(2)
const cmd = args[0] ?? 'help'

async function runCommand(prompt: string): Promise<void> {
  console.log('  ⚡ OpenInstinct v0.1.0 — live-hook AI browser agent')
  console.log('  ──────────────────────────────────────────────────────')
  console.log(`▸ prompt: "${prompt}"`)
  console.log('▸ engine: ws://localhost:8080  ·  dashboard: npm run dev:dashboard → http://localhost:3000')
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

if (cmd === 'run') {
  void runCommand(args[1] ?? 'Explore the current page')
} else if (cmd === 'serve') {
  console.log('  ⚡ OpenInstinct v0.1.0 — WebSocket bridge on ws://localhost:8080 (EXECUTE_INTENT protocol)')
  new WebSocketBridge(8080)
} else {
  console.log(HELP)
}