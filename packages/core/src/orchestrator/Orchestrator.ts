import * as fs from 'node:fs'
import * as path from 'node:path'
import type { InferenceSession, Tensor } from 'onnxruntime-node'
import { screenshotTensor, domTensor } from './tensors.js'
import { DesktopAgent, type AgentCommand, type AgentResult } from '../desktop/DesktopAgent.js'
import { AndroidBridge, type MobileResult } from '../mobile/AndroidBridge.js'

export type ExecutionHand = 'desktop' | 'mobile'

/** Output head classes of coco_full_v1.onnx (action_logits [1,4]) — the 4 action classes of our dataset schema. */
export const ACTION_CLASSES = ['CLICK', 'TYPE', 'PRESS_ENTER', 'SELECT'] as const
export type NextAction = (typeof ACTION_CLASSES)[number]

export interface RouteTask extends AgentCommand {
  package?: string
}

export type ExecutionResult = (AgentResult | MobileResult) & { hand: ExecutionHand }

export interface Observation {
  screenshot?: Buffer
  domTree?: string
}

export interface ActionInference {
  action: NextAction
  probs: number[]
  logits: number[]
}

/**
 * Routes decisions to the desktop (web) or mobile (ADB) execution hand.
 * Model: model/coco_full_v1.onnx (multi-modal) — screenshot [1,3,224,224] +
 * dom_structure [1,32,768] → action_logits [1,4].
 * Hand routing uses model inference only when the output head is 2-class;
 * with the current 4-class action head the URL-vs-package heuristic selects the hand.
 */
export class Orchestrator {
  private session: InferenceSession | null = null
  /** What outputNames[0] means: 'hand' = [desktop,mobile] router, 'action' = 4-class action head. */
  private headKind: 'hand' | 'action' | 'unknown' = 'unknown'
  private desktop = new DesktopAgent()
  private mobile = new AndroidBridge()

  modelPath(): string {
    return process.env.COCO_MODEL_PATH ?? path.join(process.cwd(), 'model', 'coco_full_v1.onnx')
  }

  /** Loads the model iff it exists. Returns how decisions will be routed. */
  async init(): Promise<'onnx' | 'heuristic'> {
    const file = this.modelPath()
    if (!fs.existsSync(file) || this.session) return this.session ? 'onnx' : 'heuristic'
    try {
      const ort = await import('onnxruntime-node')
      // load from path (not bytes) so external *.onnx.data weights resolve relative to the model dir
      const session = (this.session = await ort.InferenceSession.create(file))
      this.headKind = this.classifyHead(session)
      const describe = (meta: unknown) => {
        try {
          const m = meta as { type?: string; shape?: (number | string)[] }
          return `${m.type || '?'}[${(m.shape ?? []).map(String).join('×')}]`
        } catch {
          return '?'
        }
      }
      console.log(
        `[orchestrator] ONNX router armed: ${path.basename(file)} (head: ${this.headKind})\n` +
          `  inputs : ${session.inputNames.map((n) => `${n} ${describe(session.inputMetadata[session.inputNames.indexOf(n)])}`).join(', ')}\n` +
          `  outputs: ${session.outputNames.map((n) => `${n} ${describe(session.outputMetadata[session.outputNames.indexOf(n)])}`).join(', ')}`,
      )
      return 'onnx'
    } catch (err) {
      console.warn(`[orchestrator] model load failed (${err instanceof Error ? err.message : err}) — heuristic routing`)
      return 'heuristic'
    }
  }

  /** Detect whether outputNames[0] is a 2-class hand router or a 4-class action head. */
  private classifyHead(session: InferenceSession): 'hand' | 'action' | 'unknown' {
    try {
      const meta = session.outputMetadata[0] as { shape?: (number | string)[] }
      const last = (meta.shape ?? []).at(-1)
      if (last === 2) return 'hand'
      if (last === 4) return 'action'
    } catch {
      // fall through
    }
    return 'unknown'
  }

  async route(task: RouteTask, obs?: Observation): Promise<ExecutionHand> {
    if (this.session && this.headKind === 'hand') {
      try {
        const inf = await this.inferAction(obs ?? {})
        if (inf) return inf.logits.indexOf(Math.max(...inf.logits)) === 1 ? 'mobile' : 'desktop'
      } catch (err) {
        console.warn(`[orchestrator] hand inference failed, heuristic fallback: ${err instanceof Error ? err.message : err}`)
      }
    }
    return task.package && !task.url ? 'mobile' : 'desktop'
  }

  /** Full multi-modal pass: screenshot → [1,3,224,224], domTree → [1,32,768], softmax over action_logits. */
  async inferAction(obs: Observation): Promise<ActionInference | null> {
    if (!this.session || !obs.screenshot || !obs.domTree) return null
    const s = this.session
    try {
      const ort = await import('onnxruntime-node')
      const feeds: Record<string, Tensor> = {}
      for (const name of s.inputNames) {
        if (name === 'screenshot') feeds[name] = new ort.Tensor('float32', screenshotTensor(obs.screenshot), [1, 3, 224, 224])
        else if (name === 'dom_structure') feeds[name] = new ort.Tensor('float32', domTensor(obs.domTree), [1, 32, 768])
      }
      if (Object.keys(feeds).length < s.inputNames.length) {
        throw new Error(`model expects [${s.inputNames.join(', ')}] — can build only [${Object.keys(feeds).join(', ')}]`)
      }
      const out = await s.run(feeds)
      const logits = Array.from(out[s.outputNames[0]].data as Float32Array)
      const max = Math.max(...logits)
      const denom = logits.reduce((acc, v) => acc + Math.exp(v - max), 0)
      const probs = logits.map((l) => Math.exp(l - max) / denom)
      return { action: ACTION_CLASSES[probs.indexOf(Math.max(...probs))], probs, logits }
    } catch (err) {
      console.warn(`[orchestrator] inference failed: ${err instanceof Error ? err.message : err}`)
      return null
    }
  }

  async execute(task: RouteTask, obs?: Observation): Promise<ExecutionResult> {
    const hand = await this.route(task, obs)
    const result = hand === 'mobile' ? await this.mobile.execute(task) : await this.desktop.execute(task)
    return { ...result, hand }
  }
}