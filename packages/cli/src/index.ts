#!/usr/bin/env node
import { WebSocketBridge } from '@openinstinct/core'

console.log(`
  ⚡ OpenInstinct v0.1.0 — local-first AI browser agent
  ──────────────────────────────────────────────────────
  ▸ WebSocket bridge : ws://localhost:8080
  ▸ initialize       : npx openinstinct init
`)

new WebSocketBridge(8080)