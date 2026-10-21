import { Platform } from 'react-native'
import { InferenceSession, Tensor } from 'onnxruntime-react-native'

export const ACTION_CLASSES = ['CLICK', 'TYPE', 'PRESS_ENTER', 'SELECT'] as const
export type ModelAction = (typeof ACTION_CLASSES)[number]

const IMG_SIZE = 224
const DOM_TOKENS = 32
const DOM_EMBED_DIM = 768

export interface InferenceOutcome {
  action: ModelAction
  confidence: number
  latencyMs: number
}

/**
 * On-device inference for openinstinct_full_v1.onnx with CoreML (iOS) / NNAPI (Android) acceleration.
 * Used as the fallback when the MacBook host engine (ws) is unreachable — inference travels to the device
 * with the screenshot/dom tensors the WebView bridge already produced; we just feed and softmax them.
 */
export class MobileOnnxRunner {
  private session: InferenceSession | null = null
  private inputNames: string[] = []

  constructor(
    private modelUri: string, // require('./model/openinstinct_full_v1.onnx') or a Metro asset path
    private hostFallbackUrl?: string, // e.g. ws://192.168.1.x:8080
  ) {}

  /** 'host' when the MacBook engine answers first; else loads on-device; null when neither is available. */
  async init(): Promise<'host' | 'ondevice' | null> {
    if (this.hostFallbackUrl && (await this.hostAlive(this.hostFallbackUrl))) return 'host'
    try {
      this.session = await InferenceSession.create(this.modelUri, {
        executionProviders:
          Platform.OS === 'ios' ? (['coreml', 'cpu', 'xnnpack'] as never[]) : (['nnapi', 'cpu', 'xnnpack'] as never[]),
      })
      this.inputNames = this.session.inputNames.slice()
      return 'ondevice'
    } catch (err) {
      console.warn('[mobile-onnx] on-device session failed:', err)
      return null
    }
  }

  /**
   * Runs the multi-modal model on-device. screenshot: Float32Array(3*224*224) CHW in [0,1];
   * dom: Float32Array(32*768) — same tensor layouts as the host orchestrator, produced by the app.
   */
  async infer(screenshot: Float32Array, dom: Float32Array): Promise<InferenceOutcome | null> {
    if (!this.session) return null
    const t0 = Date.now()
    const feeds: Record<string, Tensor> = {}
    for (const name of this.inputNames) {
      if (/screenshot/i.test(name)) feeds[name] = new Tensor('float32', screenshot, [1, 3, IMG_SIZE, IMG_SIZE])
      else if (/dom/i.test(name)) feeds[name] = new Tensor('float32', dom, [1, DOM_TOKENS, DOM_EMBED_DIM])
    }
    if (!Object.keys(feeds).length) return null
    const out = await this.session.run(feeds)
    const logitsKey = Object.keys(out)[0]
    const logits = out[logitsKey].data as Float32Array
    const probs = softmax(Array.from(logits))
    const best = probs.indexOf(Math.max(...probs))
    if (probs[best] < 0.4 && probs.filter((p) => p > 0.2).length > 1) return null // near-uniform → model not confident, let host decide
    return { action: ACTION_CLASSES[best], confidence: probs[best], latencyMs: Date.now() - t0 }
  }

  /** WebSocket probe with a hard timeout — 2.5s of silence counts as the host being offline. */
  private hostAlive(url: string): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false
      const done = (alive: boolean) => {
        if (settled) return
        settled = true
        resolve(alive)
      }
      try {
        const ws = new WebSocket(url)
        ws.onopen = () => {
          ws.close()
          done(true)
        }
        ws.onerror = () => done(false)
      } catch {
        done(false)
      }
      setTimeout(() => done(false), 2500)
    })
  }
}

function softmax(logits: number[]): number[] {
  const max = Math.max(...logits)
  const exps = logits.map((l) => Math.exp(l - max))
  const sum = exps.reduce((a, b) => a + b, 0) || 1
  return exps.map((e) => e / sum)
}