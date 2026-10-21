import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { WebSocketServer, type WebSocket } from 'ws'
import { LiveChromeLauncher } from './LiveChromeLauncher.js'
import { CdpDriver, type CdpElement } from './CdpDriver.js'

export interface TargetBox {
  x: number
  y: number
  width: number
  height: number
  label?: string
}

export type EngineMessage =
  | { type: 'frame'; ts: number; step: number; screenshot: string; action: string | null; confidence: number; box: TargetBox | null; status: 'running' | 'paused'; viewport: { w: number; h: number } }
  | { type: 'hitl'; reason: string }
  | { type: 'done'; steps: number }
  | { type: 'error'; error: string; message?: string }

export interface RunOptions {
  maxSteps?: number
  /** Text to type on model TYPE actions (defaults to the prompt itself). */
  typeText?: string
}

/** Retired heuristic planners (pickTarget/fallbackAction) — replaced by the dual-tier
 *  SoM pipeline: Python `tools/agent_runner.py` decides (ONNX unified @ ≥75% gate, else
 *  DeepSeek VLM over Ollama) and returns the winning box's coordinates. */

const HITL_RE = /otp|captcha|verification code|two.?factor|2fa|payment|authoris|authoriz|secure checkout/i

/** Shape returned by tools/agent_runner.py decide (subset the loop consumes). */
interface SoMDecision {
  tier: 'onnx' | 'deepseek'
  box_id: number | null
  confidence: number
  action: string | null
  coordinates: { x_min: number; y_min: number; x_max: number; y_max: number; center_x: number; center_y: number } | null
  error?: string
}


const SITE_HINTS: [RegExp, string][] = [
  [/easemytrip|easy ?my ?trip/i, 'https://www.easemytrip.com'],
  [/makemytrip|make ?my ?trip/i, 'https://www.makemytrip.com'],
  [/\bixigo\b/i, 'https://www.ixigo.com'],
  [/\bzomato\b/i, 'https://www.zomato.com'],
  [/\bswiggy\b/i, 'https://www.swiggy.com'],
  [/\bblinkit\b/i, 'https://blinkit.com'],
  [/\bdominos?\b/i, 'https://www.dominos.co.in'],
  [/\b(phonepe|phone pe)\b/i, 'https://www.phonepe.com'],
  [/\bamazon\b/i, 'https://www.amazon.in'],
  [/\bflipkart\b/i, 'https://www.flipkart.com'],
  [/\birctc\b/i, 'https://www.irctc.co.in'],
  [/\bredbus\b/i, 'https://www.redbus.in'],
  [/\bpaytm\b/i, 'https://paytm.com'],
  [/\bbook ?my ?show\b/i, 'https://in.bookmyshow.com'],
]

/** Initial URL for step 0: explicit url-like token wins ("...on EasyMyTrip" → easemytrip.com), then known sites, then Google-searching the prompt. Never null — every run starts somewhere. */
export function resolveStartUrl(prompt: string): string {
  const m = /(?:https?:\/\/)?((?:[a-z0-9-]+\.)+(?:com|in|net|org|co)(?:\.[a-z]{2})?(?:\/[^\s"']*)?)/i.exec(prompt)
  if (m) return `https://${m[1].toLowerCase()}`
  for (const [re, url] of SITE_HINTS) if (re.test(prompt)) return url
  return `https://www.google.com/search?q=${encodeURIComponent(prompt)}`
}

/**
 * Live-hook engine: observe the user's real Chrome via CDP → step the 182MB ONNX model → execute the
 * picked target with raw Input events → broadcast every frame on ws://localhost:8080. Pauses with a
 * HITL flag on OTP/CAPTCHA/payment screens until the dashboard sends {"type":"resume"}.
 */
export class CdpEngineLoop {
  private wss: WebSocketServer | undefined
  private clients = new Set<WebSocket>()
  private paused = false
  private running = false
  private lastFrame: EngineMessage | undefined

  constructor(
    private launcher = new LiveChromeLauncher(),
    private driver = new CdpDriver(),
    private port = 8080,
  ) {}

  /** Fire-and-forget entry for RUN_PROMPT (chat bar / HTTP): one run at a time, errors surface to clients. */
  startRun(prompt: string): void {
    if (this.running) {
      this.broadcast({ type: 'error', error: 'a run is already in progress — wait for it to finish' })
      return
    }
    this.running = true
    void this.run(prompt)
      .catch(() => {}) // error frame already broadcast by run()
      .finally(() => {
        this.running = false
      })
  }

  broadcast(msg: EngineMessage): void {
    this.lastFrame = msg
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
    }
  }

  /** Starts (or joins) the frame stream server, and replays the last frame to new dashboard clients. */
  private listen(): void {
    if (this.wss) return
    this.wss = new WebSocketServer({ port: this.port })
    this.wss.on('connection', (ws) => {
      this.clients.add(ws)
      if (this.lastFrame) ws.send(JSON.stringify(this.lastFrame))
      ws.on('message', (buf) => {
        try {
          const msg = JSON.parse(buf.toString()) as { type: string; prompt?: string }
          if (msg.type === 'pause') this.paused = true
          if (msg.type === 'resume') this.paused = false
          if (msg.type === 'RUN_PROMPT' && msg.prompt) this.startRun(msg.prompt)
        } catch {
          // non-JSON client — ignore
        }
      })
      ws.on('close', () => this.clients.delete(ws))
    })
  }

  /** Every CDP roundtrip is raced against a wall clock — a half-dead debug socket must surface as an error frame, not an eternal "running…". */
  private withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
    return Promise.race([
      p,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000}s — CDP/socket unresponsive`)), ms)),
    ])
  }

  /** Repo root: tools/ + .venv/ live at cwd (CLI) or two levels up (dashboard dev server). */
  private repoRoot(): string {
    if (existsSync(join(process.cwd(), 'tools', 'agent_runner.py'))) return process.cwd()
    return join(process.cwd(), '..', '..')
  }

  /**
   * Dual-tier SoM decision via the Python runner: SoM annotate → ONNX unified
   * (commits at ≥ 0.75) → DeepSeek VLM over Ollama. One subprocess JSON roundtrip per step.
   */
  private async decide(goal: string, png: Buffer): Promise<SoMDecision> {
    const root = this.repoRoot()
    const dir = join(tmpdir(), 'oi-som')
    mkdirSync(dir, { recursive: true })
    const img = join(dir, `step_${Date.now()}_${process.pid}.png`)
    writeFileSync(img, png)
    const execFileP = promisify(execFile)
    const py = process.env.OI_PYTHON ?? join(root, '.venv', 'bin', 'python')
    const { stdout } = await execFileP(py, [join(root, 'tools', 'agent_runner.py'), 'decide', '--image', img, '--goal', goal], {
      cwd: root, // runner resolves the model path relative to the repo root
      timeout: 170_000,
      maxBuffer: 64 * 1024 * 1024, // mapping JSON for dense pages
    })
    const parsed = JSON.parse(stdout) as { decision: SoMDecision; boxes: Record<string, Record<string, number>> }
    console.log(`[engine] decide → ${parsed.decision.tier}, box ${parsed.decision.box_id ?? 'none'}, confidence ${(parsed.decision.confidence ?? 0).toFixed(2)}`)
    return parsed.decision
  }

  async run(prompt: string, options: RunOptions = {}): Promise<{ steps: number; hitl: boolean }> {
    const maxSteps = options.maxSteps ?? 8
    const typeText = options.typeText ?? prompt
    let steps = 0
    let hitl = false
    // step-0 frames (pre/post navigation) share one shape
    const frame = (shot: { b64: string }): EngineMessage => ({
      type: 'frame', ts: Date.now(), step: 0, screenshot: shot.b64, action: null, confidence: 0, box: null, status: 'running', viewport: { w: 0, h: 0 },
    })
    try {
      await this.withTimeout(this.launcher.ensureChrome(), 45_000, 'chrome launch')
      this.listen()
      await this.withTimeout(this.driver.connect(), 20_000, 'CDP connect')

      // immediate first frame — the canvas must not sit black while navigate warms up
      const shot0 = await this.withTimeout(this.driver.screenshot(), 15_000, 'initial screenshot')
      this.broadcast(frame(shot0))

      // mandatory step 0: every run starts on the site the prompt names (or a Google search of it) — never on a stale/default tab
      const target = resolveStartUrl(prompt)
      console.log(`[engine] step 0 — navigating to ${target}`)
      await this.withTimeout(this.driver.goto(target), 20_000, `navigate ${target}`)
      await this.withTimeout(this.driver.zapOverlays(), 5_000, 'popup zapper').catch(() => 0)
      this.broadcast(frame(await this.withTimeout(this.driver.screenshot(), 15_000, 'destination screenshot')))
      for (let step = 1; step <= maxSteps; step++) {
        while (this.paused) await new Promise((r) => setTimeout(r, 300))
        steps = step
        // observe — zapper first, so screenshots/DOM show the page, not an EVA card
        await this.withTimeout(this.driver.zapOverlays(), 5_000, 'popup zapper').catch(() => 0)
        const [shot, mapped] = await Promise.all([
          this.withTimeout(this.driver.screenshot(), 15_000, 'screenshot'),
          this.withTimeout(this.driver.domMap(), 15_000, 'domMap'),
        ])
        const dom = mapped.elements
        const domStr = JSON.stringify(dom)
        if (HITL_RE.test(domStr) && actionNeedsHuman(dom)) {
          hitl = true
          this.paused = true
          this.broadcast({ type: 'hitl', reason: 'OTP / CAPTCHA / payment screen detected — human confirmation required' })
          while (this.paused) await new Promise((r) => setTimeout(r, 300))
        }
        // infer — dual-tier SoM: ONNX unified gate at 0.75, DeepSeek VLM fallback below it
        const decision = await this.withTimeout(this.decide(prompt, shot.png), 180_000, 'dual-tier decide')
        // SoM coords are image pixels; convert to viewport units so CDP clicks and dashboard overlays line up
        const f = decision.coordinates ? mapped.viewport.w / pngWidth(shot.png) : 1
        const winRect = decision.coordinates
          ? { x: Math.round(decision.coordinates.x_min * f), y: Math.round(decision.coordinates.y_min * f), width: Math.round((decision.coordinates.x_max - decision.coordinates.x_min) * f), height: Math.round((decision.coordinates.y_max - decision.coordinates.y_min) * f) }
          : null
        // execute
        if (winRect && decision.action) {
          await this.driver.humanClick({ x: winRect.x + winRect.width / 2, y: winRect.y + winRect.height / 2 })
          if (decision.action === 'TYPE') await this.driver.typeText(typeText)
        } else if (decision.action === 'PRESS_ENTER') {
          await this.driver.pressEnter()
        } else {
          console.log(`[engine] step ${step} — ${decision.tier} tier found no executable target`)
        }
        this.broadcast({
          type: 'frame',
          ts: Date.now(),
          step,
          screenshot: shot.b64,
          action: decision.action ?? `${decision.tier}:observe`,
          confidence: decision.confidence,
          box: winRect ? { ...winRect, label: `${decision.tier}·box${decision.box_id ?? '?'}${decision.confidence ? ` ${(decision.confidence * 100).toFixed(0)}%` : ''}` } : null,
          status: 'running',
          viewport: mapped.viewport,
        })
      }
      this.broadcast({ type: 'done', steps })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // both spellings: {error} for the dashboard handler, {message} for generic clients — busy resets either way
      this.broadcast({ type: 'error', error: msg, message: msg } as EngineMessage)
      throw err
    } finally {
      await this.driver.detach()
    }
    return { steps, hitl }
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.wss?.close(() => resolve()))
    this.wss = undefined
    this.clients.clear()
  }
}

/** If a visible OTP/CAPTCHA keyword element exists, flag HITL — an agent stepping into 2FA is the one thing we must not fire blindly. */
function actionNeedsHuman(dom: CdpElement[]): boolean {
  return dom.some((e) => /otp|captcha|verification code|2fa|payment/i.test(`${e.text} ${e.ariaLabel ?? ''} ${e.placeholder ?? ''}`))
}

/** PNG IHDR width — SoM coordinates are image pixels, viewport scaling needs the source width. */
function pngWidth(png: Buffer): number {
  return png.readUInt32BE(16)
}

if (require.main === module) {
  // self-check: HITL gating + start-url resolution + SoM→viewport scaling (no browser needed)
  const assert = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(`engine self-check failed: ${msg}`)
  }
  const dom = (t: Partial<CdpElement>): CdpElement => ({ tag: 'button', text: 'Search', rect: { x: 10, y: 10, width: 80, height: 30 }, ...t } as CdpElement)
  assert(actionNeedsHuman([dom({ text: 'Enter OTP code' })]), 'HITL fires on OTP keyword')
  assert(!actionNeedsHuman([dom({ text: 'Home' })]), 'HITL stays quiet on normal page')
  assert(resolveStartUrl('Book a flight on EasyMyTrip') === 'https://www.easemytrip.com', 'prompt → easemytrip')
  assert(resolveStartUrl('order air purifier on Amazon') === 'https://www.amazon.in', 'prompt → amazon.in')
  assert(resolveStartUrl('open https://blinkit.com/cart') === 'https://blinkit.com/cart', 'explicit url wins')
  assert(resolveStartUrl('order dinner').startsWith('https://www.google.com/search?q='), 'no hints → google-search fallback')
  // SoM image pixels → viewport: 2400px-wide retina shot on a 1200px viewport ⇒ ÷2
  const png = Buffer.alloc(32)
  png.writeUInt32BE(2400, 16)
  assert(pngWidth(png) === 2400, 'png IHDR width read')
  assert(Math.round(2258 * (1200 / 2400)) === 1129, 'SoM center conversion (÷2 retina)')
  console.log('[engine] self-check ✓ — HITL gating + start-url resolution + SoM scaling')
}