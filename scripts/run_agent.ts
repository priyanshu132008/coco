#!/usr/bin/env node
import * as fs from 'node:fs'
import { Orchestrator, AgentRunner, AndroidBridge } from '@openinstinct/core'

const log = (tag: string, msg: string) => console.log(`[agent] ${tag} ${msg}`)

async function preflight(adb: AndroidBridge, orch: Orchestrator, prompt: string) {
  console.log(`
  ⚡ OpenInstinct live run
  ────────────────────────
  ▸ prompt : "${prompt}"
`)
  const modelFile = orch.modelPath().split('/').pop()
  if (fs.existsSync(orch.modelPath())) log('model ', `${modelFile} found — ONNX routing armed`)
  else log('model ', `no model at ${orch.modelPath()} — heuristic routing for this run`)
  const device = await adb.device().catch(() => null)
  if (device) log('adb   ', `device attached: ${device} — mobile hand ready`)
  else log('adb   ', 'no device attached — mobile sub-tasks will be skipped')
  const { chromium } = await import('playwright-extra')
  const exe = chromium.executablePath()
  if (!fs.existsSync(exe)) {
    log('web   ', `chromium binary missing — run: npx playwright install chromium`)
    process.exit(1)
  }
  log('web   ', `chromium ready (stealth stack)`)
}

async function run() {
  const prompt = process.argv.slice(2).join(' ').trim()
  if (!prompt) {
    console.log('usage: npm run agent -- "book a flight from mumbai to delhi and message the details on whatsapp"')
    process.exit(1)
  }

  const orch = new Orchestrator()
  const adb = new AndroidBridge()
  await preflight(adb, orch, prompt)

  const runner = new AgentRunner(orch)
  const report = await runner.run(prompt)

  console.log('\n──── run report ────')
  for (const s of report.steps) {
    console.log(`  ${s.verified ? '✅' : '❌'} [${s.hand}] ${s.intent}${s.error ? ` — ${s.error}` : ''}`)
    console.log(`     ${s.executed.join(' → ')}`)
  }
  console.log(`  mode: ${report.mode} | steps verified: ${report.steps.filter((s) => s.verified).length}/${report.steps.length}`)
  process.exit(report.success ? 0 : 1)
}

run().catch((err: unknown) => {
  console.error('[agent] fatal:', err instanceof Error ? err.message : err)
  process.exit(1)
})