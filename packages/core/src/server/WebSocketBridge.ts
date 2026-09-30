import { WebSocketServer, type WebSocket } from 'ws'
import { StealthBrowser } from '../driver/StealthBrowser.js'

export interface ExecuteIntentMessage {
  type: 'EXECUTE_INTENT'
  intent: string
  url?: string
}

/** Receives EXECUTE_INTENT from agents/dashboard, drives the stealth browser, broadcasts human-readable results. */
export class WebSocketBridge {
  private wss: WebSocketServer
  private browser = new StealthBrowser()

  constructor(port = 8080) {
    this.wss = new WebSocketServer({ port })
    this.wss.on('connection', (client) => {
      client.send(
        '[OpenInstinct] connected — send {"type":"EXECUTE_INTENT","intent":"navigate","url":"https://example.com"}',
      )
      client.on('message', (raw) => this.onMessage(client, String(raw)))
    })
    console.log(`[OpenInstinct] WebSocket bridge listening on ws://localhost:${port}`)
  }

  broadcast(text: string): void {
    for (const client of this.wss.clients) {
      if (client.readyState === client.OPEN) client.send(text)
    }
  }

  private async onMessage(client: WebSocket, raw: string): Promise<void> {
    let msg: ExecuteIntentMessage
    try {
      msg = JSON.parse(raw)
    } catch {
      client.send('[OpenInstinct] malformed message — expected JSON {"type":"EXECUTE_INTENT",...}')
      return
    }
    if (msg.type !== 'EXECUTE_INTENT') {
      client.send(`[OpenInstinct] unknown message type "${msg.type}" — expected EXECUTE_INTENT`)
      return
    }
    if (!msg.url) {
      client.send('[OpenInstinct] EXECUTE_INTENT needs a "url" field')
      return
    }
    try {
      await this.browser.initialize()
      const result = await this.browser.navigateAndExtract(msg.url)
      const nodeCount = (JSON.parse(result.domTree) as unknown[]).length
      this.broadcast(
        `[OpenInstinct] ✅ executed "${msg.intent}" on ${msg.url} — extracted ${nodeCount} interactive nodes, screenshot ${(result.screenshot.length / 1024).toFixed(1)} KB. Available actions: click, type, scroll, extract.`,
      )
    } catch (err) {
      this.broadcast(`[OpenInstinct] ❌ "${msg.intent}" failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}