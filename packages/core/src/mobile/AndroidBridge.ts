import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

export interface AdbElement {
  'resource-id'?: string
  text?: string
  'content-desc'?: string
  class?: string
  bounds?: string
}

export interface MobileResult {
  ok: boolean
  screenshot?: Buffer
  // mobile analog of domTree: JSON array of interactive nodes from uiautomator dump
  domTree?: string
  error?: string
}

export function parseUiautomatorXml(xml: string): AdbElement[] {
  const elements: AdbElement[] = []
  for (const m of xml.matchAll(/<node\b([^>]*)>/g)) {
    const attrs: Record<string, string> = {}
    for (const am of m[1].matchAll(/([A-Za-z-]+)="([^"]*)"/g)) attrs[am[1].toLowerCase()] = am[2]
    if (attrs.clickable !== 'true' && !attrs.class?.endsWith('EditText')) continue
    elements.push({
      'resource-id': attrs['resource-id'] || undefined,
      text: attrs.text || undefined,
      'content-desc': attrs['content-desc'] || undefined,
      class: attrs.class || undefined,
      bounds: attrs.bounds || undefined,
    })
  }
  return elements
}

/** "[l,t][r,b]" → tap-point center. */
export function boundsCenter(bounds: string): { x: number; y: number } | null {
  const m = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(bounds)
  return m ? { x: Math.round((+m[1] + +m[3]) / 2), y: Math.round((+m[2] + +m[4]) / 2) } : null
}

const BACK = 4
const ENTER = 66

/** Phase 2 hand: ADB control of mobile apps — screen capture, element dump, tap/text injection. */
export class AndroidBridge {
  constructor(
    // ponytail: single device assumption, plain exec per call — swap adbkit if device farms are needed
    protected adbPath = process.env.ADB_PATH ?? 'adb',
    protected serial?: string,
  ) {}

  /** First "device" state from `adb devices`, or null. */
  async device(): Promise<string | null> {
    const { stdout } = await execFileP(this.adbPath, ['devices'])
    for (const line of stdout.trim().split('\n').slice(1)) {
      const [serial, state] = line.split(/\s+/)
      if (state === 'device') return serial ?? null
    }
    return null
  }

  /** Active-viewport screen capture as PNG buffer (mobile analog of desktop screenshot). */
  async screencap(): Promise<Buffer> {
    return this.runBuffer('exec-out', 'screencap', '-p')
  }

  /** Interactive elements only (clickable nodes + EditTexts), the mobile analog of the filtered DOM. */
  async dump(): Promise<AdbElement[]> {
    await this.runShell('uiautomator', 'dump', '/sdcard/window_dump.xml')
    const xml = (await this.runBuffer('exec-out', 'cat', '/sdcard/window_dump.xml')).toString('utf8')
    return parseUiautomatorXml(xml)
  }

  async snapshot(): Promise<{ screenshot: Buffer; domTree: string }> {
    const [screenshot, elements] = await Promise.all([this.screencap(), this.dump()])
    return { screenshot, domTree: JSON.stringify(elements) }
  }

  async tap(x: number, y: number): Promise<void> {
    await this.runShell('input', 'tap', String(x), String(y))
  }

  async inputText(text: string): Promise<void> {
    await this.runShell('input', 'text', text.replace(/ /g, '%s'))
  }

  async key(key: typeof BACK | typeof ENTER | number): Promise<void> {
    await this.runShell('input', 'keyevent', String(key))
  }

  /** Launch an app by package id via monkey (works for any launcher app). */
  async launch(packageName: string): Promise<MobileResult> {
    await this.runShell('monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1')
    return { ok: true, ...(await this.snapshot()) }
  }

  async tapNode(el: AdbElement): Promise<void> {
    if (!el.bounds) throw new Error(`element ${el['resource-id'] ?? el.text ?? '?'} has no bounds`)
    const c = boundsCenter(el.bounds)
    if (!c) throw new Error(`unparseable bounds "${el.bounds}"`)
    await this.tap(c.x, c.y)
  }

  private findIn(
    elements: AdbElement[],
    match: { resource?: string; text?: string; desc?: string },
  ): AdbElement | undefined {
    const norm = (s?: string) => s?.replace(/^[#@]/, '')
    return elements.find(
      (e) =>
        (match.resource && norm(e['resource-id']) === norm(match.resource)) ||
        (match.text && e.text?.includes(match.text)) ||
        (match.desc && e['content-desc']?.includes(match.desc)),
    )
  }

  /** NAVIGATE (launch) / CLICK / TYPE / SUBMIT command interface, mirroring DesktopAgent. */
  async execute(cmd: { type: 'NAVIGATE' | 'CLICK' | 'TYPE' | 'SUBMIT'; url?: string; selector?: string; payload?: string; package?: string }): Promise<MobileResult> {
    try {
      if (cmd.type === 'NAVIGATE') {
        if (!cmd.package) throw new Error('mobile NAVIGATE requires a package name (e.g. com.swiggy.android)')
        return await this.launch(cmd.package)
      }
      if (cmd.type === 'CLICK') {
        if (!cmd.selector) throw new Error('mobile CLICK requires a resource-id / text')
        const el = this.findIn(await this.dump(), { resource: cmd.selector, text: cmd.selector, desc: cmd.selector })
        if (!el) throw new Error(`no clickable element matches "${cmd.selector}"`)
        await this.tapNode(el)
      } else if (cmd.type === 'TYPE') {
        if (cmd.selector) {
          const el = this.findIn(await this.dump(), { resource: cmd.selector, text: cmd.selector, desc: cmd.selector })
          if (el) await this.tapNode(el)
        }
        if (cmd.payload) await this.inputText(cmd.payload)
      } else if (cmd.type === 'SUBMIT') {
        await this.key(ENTER)
      }
      const { screenshot, domTree } = await this.snapshot()
      return { ok: true, screenshot, domTree }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  protected runShell(...args: string[]): Promise<Buffer> {
    return this.runBuffer('shell', ...args)
  }

  protected runBuffer(...args: string[]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const argv = this.serial ? ['-s', this.serial, ...args] : args
      const p = spawn(this.adbPath, argv)
      const chunks: Buffer[] = []
      p.stdout.on('data', (d: Buffer) => chunks.push(d))
      p.on('close', (code: number | null) =>
        code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`adb ${args.join(' ')} exited ${code}: ${Buffer.concat(chunks).toString().trim()}`)),
      )
      p.on('error', reject)
    })
  }
}

if (require.main === module) {
  // self-check: parser + bounds math on a representative uiautomator dump
  const sample = `
  <hierarchy rotation="0">
    <node text="Search a restaurant" resource-id="com.swiggy.android:id/search" class="android.widget.EditText" clickable="true" bounds="[48,320][672,386]"/>
    <node text="ADD" resource-id="com.swiggy.android:id/add" class="android.widget.LinearLayout" clickable="true" bounds="[996,1454][1232,1530]"/>
    <node text="static label" class="android.widget.TextView" clickable="false" bounds="[0,0][100,100]"/>
  </hierarchy>`
  const els = parseUiautomatorXml(sample)
  const assert = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(`parity check failed: ${msg}`)
  }
  assert(els.length === 2, 'expected clickable/EditText nodes only')
  const c = boundsCenter(els[1].bounds ?? '')
  assert(!!c && c.x === (996 + 1232) / 2 && c.y === (1454 + 1530) / 2, 'bounds center math')
  console.log('[adb] self-check ✓ — 2/3 nodes interactive, bounds center math OK')
}