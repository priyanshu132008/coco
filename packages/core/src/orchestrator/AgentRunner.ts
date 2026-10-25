import { Orchestrator, type ExecutionHand, type RouteTask } from './Orchestrator.js'
import { DesktopAgent, type AgentResult } from '../desktop/DesktopAgent.js'
import { AndroidBridge, type MobileResult } from '../mobile/AndroidBridge.js'
import { WirelessBridge } from '../mobile/WirelessBridge.js'
import { vault } from '../security/Vault.js'

export interface PlanStep {
  hand: ExecutionHand
  intent: string
  cmds: RouteTask[]
}

export interface StepResult {
  intent: string
  hand: ExecutionHand
  executed: string[]
  verified: boolean
  error?: string
}

export interface RunReport {
  prompt: string
  mode: 'onnx' | 'heuristic'
  steps: StepResult[]
  success: boolean
}

const TRAVEL_URL = process.env.COCO_TRAVEL_URL ?? 'https://www.easemytrip.com'
const DEFAULT_URL = process.env.COCO_DEFAULT_URL ?? 'https://www.google.com'

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)

/**
 * ponytail: keyword-based planner until an LLM/NLU head lands — it maps high-level prompts
 * to sub-task drafts; the ONNX router (when armed) still picks the execution hand.
 */
export function planFromPrompt(prompt: string): PlanStep[] {
  const p = prompt.toLowerCase()
  const plan: PlanStep[] = []
  const route = /([a-z]+)\s+to\s+([a-z]+)/.exec(p)

  if (/\b(book|flight|hotel|website|web|browser|order online)\b/.test(p)) {
    plan.push(
      route
        ? {
            hand: 'desktop',
            intent: `Search ${cap(route[1])} → ${cap(route[2])} on ${TRAVEL_URL}`,
            cmds: [
              { type: 'NAVIGATE', url: TRAVEL_URL },
              { type: 'TYPE', selector: 'input[placeholder*="From" i]', payload: route[1] },
              { type: 'TYPE', selector: 'input[placeholder*="To" i]', payload: route[2] },
              { type: 'SUBMIT' },
            ],
          }
        : { hand: 'desktop', intent: 'Open web task', cmds: [{ type: 'NAVIGATE', url: DEFAULT_URL }] },
    )
  }
  if (/\b(upi|phonepe|paytm|gpay|google pay|razorpay|pay(ment)?)\b/.test(p)) {
    plan.push({
      hand: 'mobile',
      intent: 'Open UPI app to authenticate payment',
      cmds: [{ type: 'NAVIGATE', package: process.env.COCO_UPI_PACKAGE ?? 'com.phonepe.app' }],
    })
  }
  if (/\b(whatsapp|message|text)\b/.test(p)) {
    const details = route ? `${cap(route[1])} → ${cap(route[2])} booked ✅` : 'Details from the web task ✅'
    plan.push({
      hand: 'mobile',
      intent: 'Send confirmation message on WhatsApp',
      cmds: [{ type: 'NAVIGATE', package: 'com.whatsapp' }, { type: 'TYPE', payload: details }],
    })
  }
  if (!plan.length) plan.push({ hand: 'desktop', intent: 'Open web task', cmds: [{ type: 'NAVIGATE', url: DEFAULT_URL }] })
  return plan
}

interface ObsState {
  dom?: string
  shotLen?: number
}

/** Closed-loop runner: observe → route (ONNX when armed) → act → verify → repeat, crossing desktop⇄mobile. */
export class AgentRunner {
  private mode: 'onnx' | 'heuristic' = 'heuristic'

  constructor(
    private orchestrator: Orchestrator = new Orchestrator(),
    private desktop: DesktopAgent = new DesktopAgent(),
    private mobile: AndroidBridge = new WirelessBridge(), // falls back to Wi-Fi ADB when no USB device
    private maxSteps = 32,
  ) {}

  async run(prompt: string, planOverride?: PlanStep[]): Promise<RunReport> {
    this.mode = await this.orchestrator.init()
    const plan = planOverride ?? planFromPrompt(prompt)
    const steps: StepResult[] = []

    for (const step of plan) {
      if (steps.length >= this.maxSteps) break
      // when the model is armed it gets the final say on which hand executes this sub-task
      let hand = step.hand
      if (this.mode === 'onnx') {
        const modelHand = await this.orchestrator.route(this.routeProbe(step))
        if (modelHand !== hand) console.log(`[runner] model rerouted "${step.intent}" → ${modelHand}`)
        hand = modelHand
      }
      if (!(await this.ensureHand(hand))) {
        steps.push({ intent: step.intent, hand, executed: [], verified: false, error: 'execution hand unavailable' })
        continue
      }
      const r = await this.runStep(step, hand)
      steps.push(r)
    }
    const success = steps.length > 0 && steps.every((s) => s.verified)
    console.log(`[runner] ${success ? '✅' : '⚠️'} "${prompt}" — ${steps.filter((s) => s.verified).length}/${steps.length} steps verified (${this.mode})`)
    return { prompt, mode: this.mode, steps, success }
  }

  /** The model sees url/package presence as hand-hint features (Orchestrator.featuresFor). */
  private routeProbe(step: PlanStep): RouteTask {
    return { ...step.cmds[0], type: step.cmds[0]?.type ?? 'NAVIGATE' }
  }

  /** Cross-device gate: mobile hand only runs when a device is actually attached. */
  private async ensureHand(hand: ExecutionHand): Promise<boolean> {
    if (hand === 'mobile') {
      const device = await this.mobile.device().catch(() => null)
      if (!device) {
        console.warn('[runner] no adb device attached — skipping mobile sub-tasks (web-only fallback not possible for this step)')
        return false
      }
    }
    return true
  }

  private async runStep(step: PlanStep, hand: ExecutionHand): Promise<StepResult> {
    let before: ObsState | undefined
    let obs: { screenshot?: Buffer; domTree?: string } = {}
    const executed: string[] = []
    for (const cmd of step.cmds) {
      // multi-modal head sees the latest real observation before every command
      if (this.mode === 'onnx') {
        const inf = await this.orchestrator.inferAction(obs)
        if (inf) console.log(`[runner] model → ${inf.action} (${(Math.max(...inf.probs) * 100).toFixed(0)}% conf) · planned ${cmd.type}`)
      }
      const r = await this.executeWithRecovery(cmd, hand, before)
      executed.push(`${cmd.type}${cmd.selector ? `:${cmd.selector}` : cmd.url ?? cmd.package ?? ''}`)
      if (!r.verified) return { intent: step.intent, hand, executed, verified: false, error: r.error }
      before = { dom: r.domTree, shotLen: r.shotLen }
      obs = { screenshot: r.screenshot, domTree: r.domTree }
    }
    return { intent: step.intent, hand, executed, verified: true }
  }

  /** Attempt each action twice with fresh observation before declaring failure. */
  private async executeWithRecovery(
    cmd: RouteTask,
    hand: ExecutionHand,
    before?: ObsState,
  ): Promise<{ verified: boolean; domTree?: string; shotLen?: number; screenshot?: Buffer; error?: string }> {
    let last: AgentResult | MobileResult | undefined
    let state = before
    let verified = false
    // secrets are stored as `vault:key` in plans and resolved at the last moment before execution
    if (cmd.payload?.startsWith('vault:')) {
      console.log(`[runner] resolving secret ${cmd.payload.slice(6)} from vault`)
      cmd = { ...cmd, payload: vault.get(cmd.payload.slice(6)) ?? '' }
    }
    for (let attempt = 1; attempt <= 2 && !verified; attempt++) {
      if (attempt > 1) {
        await new Promise((r) => setTimeout(r, 1200))
        console.log(`[runner] retrying ${cmd.type} — recovery attempt ${attempt}`)
      }
      last = hand === 'mobile' ? await this.mobile.execute(cmd) : await this.desktop.execute(cmd)
      verified = this.verify(cmd, hand, last, state)
      state = { dom: last.domTree, shotLen: last.screenshot?.length }
    }
    return {
      verified,
      domTree: last?.domTree,
      shotLen: last?.screenshot?.length,
      screenshot: last?.screenshot,
      error: verified ? undefined : last?.error ?? 'verification failed — no state change after retry',
    }
  }

  /** State verification: observation is real (non-empty dom + plausible screenshot) and CLICK/TYPE/SUBMIT visibly advanced state. */
  private verify(cmd: RouteTask, hand: ExecutionHand, result: AgentResult | MobileResult, before?: ObsState): boolean {
    if (!result.ok) return false
    if (!result.screenshot || result.screenshot.length < 1000 || !result.domTree) return false
    try {
      if ((JSON.parse(result.domTree) as unknown[]).length === 0) return false
    } catch {
      return false
    }
    if (cmd.type === 'NAVIGATE') return true
    const changed = result.domTree !== before?.dom || (result.screenshot?.length ?? 0) !== (before?.shotLen ?? 0)
    if (!changed) console.warn(`[runner] ${hand} ${cmd.type} on ${cmd.selector ?? cmd.url ?? cmd.package} produced no visible state change`)
    return changed
  }
}

if (require.main === module) {
  // self-check: prompt → plan segmentation covering both hands (no device needed)
  const plan = planFromPrompt('Book a flight from Mumbai to Delhi and message the details to my friend on WhatsApp')
  const assert = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(`runner self-check failed: ${msg}`)
  }
  assert(plan.length === 2, 'expected desktop + mobile sub-tasks')
  assert(plan[0].hand === 'desktop' && plan[0].cmds.length === 4, 'desktop flight-search draft with 4 commands')
  assert(plan[1].hand === 'mobile' && plan[1].cmds[0].package === 'com.whatsapp', 'whatsapp handoff sub-task')
  assert(planFromPrompt('hello world')[0].hand === 'desktop', 'fallback to desktop default task')
  console.log('[runner] self-check ✓ — prompt segmented into desktop(4 cmds) + mobile(whatsapp)')
}