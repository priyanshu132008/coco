import { CdpEngineLoop } from '@coco/core'

// server-only engine manager, cached via globalThis so dev HMR keeps the live instance

export function getEngine(): CdpEngineLoop {
  const g = globalThis as unknown as { __cocoEngine?: CdpEngineLoop }
  if (!g.__cocoEngine) {
    g.__cocoEngine = new CdpEngineLoop()
    void g.__cocoEngine
  }
  return g.__cocoEngine
}