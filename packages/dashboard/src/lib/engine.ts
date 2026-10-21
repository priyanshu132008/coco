import * as fs from 'node:fs'
import * as path from 'node:path'
import { CdpEngineLoop } from '@openinstinct/core'

// server-only engine manager, cached via globalThis so dev HMR keeps the live instance

const MODEL_NAME = 'openinstinct_full_v1.onnx'
let resolved = false

function resolveModelPath(): void {
  if (resolved || process.env.OI_MODEL_PATH) {
    resolved = true
    return
  }
  // next dev runs here from packages/dashboard — repo root is two levels up
  const candidates = [
    path.resolve(process.cwd(), '..', '..', 'model', MODEL_NAME),
    path.resolve(process.cwd(), 'model', MODEL_NAME),
  ]
  const found = candidates.find((p) => fs.existsSync(p))
  if (found) process.env.OI_MODEL_PATH = found
  else console.warn(`[dashboard-engine] model not found in: ${candidates.join(', ')} — heuristic routing will be used`)
  resolved = true
}

export function getEngine(): CdpEngineLoop {
  const g = globalThis as unknown as { __oiEngine?: CdpEngineLoop }
  if (!g.__oiEngine) {
    resolveModelPath()
    g.__oiEngine = new CdpEngineLoop()
    void g.__oiEngine
  }
  return g.__oiEngine
}