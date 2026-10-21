// ponytail: raw page-level CDP over ws instead of playwright's connectOverCDP — that handshake
// sends browser-context management calls modern Chrome refuses on third-party clients. Page-target
// attach speaks plain protocol the user's real Chrome always accepts. Upgrade path: none needed
// unless we want multi-tab management back.
// Screenshot coords are viewport-relative (Page.captureScreenshot) and the DOM map filters to the viewport.

import WebSocket from 'ws'

export interface CdpElement {
  tag: string
  id?: string
  text: string
  placeholder?: string
  ariaLabel?: string
  href?: string
  rect: { x: number; y: number; width: number; height: number }
}

// Anti-detection patch, injected on every new document AND immediately on the live one.
const HARDEN_JS = `
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
window.chrome = window.chrome || { runtime: {} };
Object.defineProperty(navigator, 'languages', { get: () => ['en-IN', 'en'] });
Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
`

interface Pending {
  method: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolve: (v: any) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

/** Interactive-DOM + screenshot reader over the attached page-level CDP session, with raw Input-event execution. */
export class CdpDriver {
  private ws: WebSocket | undefined
  private wsUrl: string | undefined
  private seq = 0
  private pending = new Map<number, Pending>()

  async connect(devtoolsUrl = 'http://127.0.0.1:9222'): Promise<void> {
    const res = await fetch(`${devtoolsUrl}/json/list`)
    const targets = (await res.json()) as { type: string; url: string; webSocketDebuggerUrl: string }[]
    const tab = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
    if (!tab) throw new Error(`cdp: no page target on ${devtoolsUrl} — debug endpoint answered but has no tab`)
    this.wsUrl = tab.webSocketDebuggerUrl
    await this.openSocket()
    await this.send('Page.enable').catch(() => {})
    await this.send('Runtime.enable').catch(() => {})
    // anti-detection: patch on every future document + the one already loaded
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: HARDEN_JS }).catch(() => {})
    await this.eval(HARDEN_JS).catch(() => {})
    console.log(`[cdp] attached page target: ${tab.url}`)
  }

  /** One WebSocket per page target; request/response matched by id, events ignored. */
  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl as string)
      this.ws = ws
      ws.on('open', () => resolve())
      ws.on('error', (e) => reject(new Error(`cdp socket error: ${e.message}`)))
      ws.on('close', () => {
        for (const p of this.pending.values()) p.reject(new Error('cdp: socket closed'))
        this.pending.clear()
        this.ws = undefined
      })
      ws.on('message', (buf) => {
        const m = JSON.parse(buf.toString()) as { id?: number; result?: Record<string, unknown>; error?: { message: string } }
        const id = m.id ?? -1
        const p = this.pending.get(id)
        if (!p) return // protocol event, not a response — ignored
        this.pending.delete(id)
        clearTimeout(p.timer)
        if (m.error) p.reject(new Error(`cdp ${p.method}: ${m.error.message}`))
        else p.resolve(m.result ?? {})
      })
    })
  }

  private send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error(`cdp: not connected (${method})`))
        return
      }
      const id = ++this.seq
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`cdp: ${method} timed out after ${timeoutMs / 1000}s`))
      }, timeoutMs)
      this.pending.set(id, { method, resolve, reject, timer })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  /** Runtime.evaluate with returnByValue — the one bridge to page JS. */
  private async eval<T>(expression: string, timeoutMs = 15_000): Promise<T> {
    const r = await this.send<{ result?: { value?: T } }>('Runtime.evaluate', { expression, returnByValue: true }, timeoutMs)
    return (r.result?.value ?? undefined) as T
  }

  async screenshot(): Promise<{ b64: string; png: Buffer }> {
    const { data } = await this.send<{ data: string }>('Page.captureScreenshot', { format: 'png' }, 15_000)
    return { b64: data, png: Buffer.from(data, 'base64') }
  }

  async pageUrl(): Promise<string> {
    return (await this.eval<string>('location.href')) ?? ''
  }

  /** Navigate the attached live tab (escape welcome/newtab/blank). Poll readyState — Page.navigate's event stream isn't tracked. */
  async goto(url: string): Promise<void> {
    await this.send('Page.navigate', { url }, 15_000)
    const t0 = Date.now()
    while (Date.now() - t0 < 15_000) {
      await new Promise((r) => setTimeout(r, 350))
      try {
        const st = await this.eval<string>('document.readyState')
        if (st === 'interactive' || st === 'complete') return // domcontentloaded, not full network idle
      } catch {
        // context swapping mid-navigation — keep polling
      }
    }
    throw new Error(`cdp goto: ${url} did not settle within 15s`)
  }

  /** Interactive elements with viewport rects (visible, fully in-frame) — the model loop's shared observation. */
  async domMap(): Promise<{ elements: CdpElement[]; viewport: { w: number; h: number } }> {
    const mapped = await this.eval<{ out: CdpElement[]; vw: number; vh: number }>(`(function () {
      const out = []
      for (const el of document.querySelectorAll('a, button, input, select, textarea, [onclick], [role=button], [role=link], [role=tab], [role=checkbox]')) {
        const h = el
        const input = h
        const r = h.getBoundingClientRect()
        if (r.width <= 0 || r.height <= 0) continue
        if (r.x < 0 || r.x + r.width > window.innerWidth || r.y < 0 || r.y + r.height > window.innerHeight) continue
        out.push({
          tag: h.tagName.toLowerCase(),
          id: h.id || undefined,
          text: ((h.innerText || input.value || '') + '').slice(0, 80),
          placeholder: input.placeholder || undefined,
          ariaLabel: h.getAttribute('aria-label') || undefined,
          href: h.href || undefined,
          rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
        })
      }
      return { out: out, vw: window.innerWidth, vh: window.innerHeight }
    })()`)
    return { elements: mapped?.out ?? [], viewport: { w: mapped?.vw ?? 1280, h: mapped?.vh ?? 800 } }
  }

  /**
   * Auto-popup zapper — hides chatbot/promo/consent overlays before observation so the model sees the page,
   * not an "EVA, Let's Chat" card. Surgical-ish: only fixed/absolute-positioned (floating) layers with high
   * z-index or matching chat/cookie/offer keywords, plus chat iframes. Normal-flow content is never touched.
   * ponytail: keyword+position heuristic — an overlay with tiny z-index or unusual keywords survives; refine
   * if a site hides behind other floating junk.
   */
  async zapOverlays(): Promise<number> {
    const count = await this.eval<number>(`(function () {
      var vw = window.innerWidth, vh = window.innerHeight, n = 0
      var BAD = /\\b(eva|chat|chatbot|assistant|cookie|consent|subscribe|newsletter|notification|whatsapp|offer|coupon|deal|promo)\\b/i
      var POP = /\\b(eva|chat|chatbot|assistant|cookie|consent|subscribe|newsletter|notification|whatsapp)\\b/i
      var iframes = document.querySelectorAll('iframe')
      for (var i = 0; i < iframes.length && n < 30; i++) {
        if (BAD.test(iframes[i].src || '') || BAD.test(iframes[i].className || '')) { iframes[i].style.display = 'none'; n++ }
      }
      var els = Array.from(document.querySelectorAll('body *')).slice(0, 1200)
      for (var j = 0; j < els.length && n < 60; j++) {
        var el = els[j]
        var cs = getComputedStyle(el)
        if (cs.display === 'none' || (cs.position !== 'fixed' && cs.position !== 'absolute')) continue
        var zi = parseInt(cs.zIndex, 10) || 0
        var r = el.getBoundingClientRect()
        var bigOverlay = r.width > vw * 0.5 && r.height > vh * 0.2
        var txt = (el.innerText || el.getAttribute('aria-label') || el.className || '').slice(0, 300)
        var kwBad = BAD.test(txt)
        var kwPop = POP.test(txt)
        if (kwPop || (kwBad && zi >= 50) || (bigOverlay && zi >= 50)) { el.style.display = 'none'; n++ }
      }
      return n
    })()`)
    if (count) console.log(`[cdp] popup zapper — hid ${count} overlay node(s)`)
    return count ?? 0
  }

  /** Hidden-input widget field (easemytrip-style): click the invisible input's visible wrapper to open the city/list widget, true if one was found. */
  async clickHiddenInput(): Promise<boolean> {
    return (await this.eval<boolean>(`(function () {
      var inp = null
      var inputs = document.querySelectorAll('input')
      for (var i = 0; i < inputs.length; i++) {
        var el = inputs[i]
        if ((el.offsetWidth <= 0 || el.offsetHeight <= 0) && (el.placeholder || el.id || el.name) && el.type !== 'hidden' && el.type !== 'checkbox') { inp = el; break }
      }
      if (!inp) return false
      var host = inp
      for (var p = inp.parentElement; p && p !== document.body; p = p.parentElement) {
        var r = p.getBoundingClientRect()
        if (r.width > 60 && r.height > 25) { host = p; break }
      }
      host.click()
      return true
    })()`)) ?? false
  }

  /** Cubic-bezier path from a random off-center start — human-plausible pointer travel, not a teleport click. */
  private bezierPoints(to: { x: number; y: number }, steps = 16): { x: number; y: number }[] {
    const from = { x: to.x - 140 + Math.random() * 60, y: to.y - 90 + Math.random() * 60 }
    const c1 = { x: from.x + (to.x - from.x) * 0.3 + (Math.random() - 0.5) * 80, y: from.y + (to.y - from.y) * 0.1 + (Math.random() - 0.5) * 60 }
    const c2 = { x: from.x + (to.x - from.x) * 0.7 + (Math.random() - 0.5) * 80, y: to.y - 30 + (Math.random() - 0.5) * 40 }
    const pts: { x: number; y: number }[] = []
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const mt = 1 - t
      pts.push({
        x: mt * mt * mt * from.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t * t * t * to.x,
        y: mt * mt * mt * from.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t * t * t * to.y,
      })
    }
    return pts
  }

  /** Physical click: bezier mouse path + pressed/released as raw CDP Input events. */
  async humanClick(center: { x: number; y: number }): Promise<void> {
    for (const p of this.bezierPoints(center)) {
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none' })
      await new Promise((r) => setTimeout(r, 8 + Math.random() * 10))
    }
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: center.x, y: center.y, button: 'left', clickCount: 1 })
    await new Promise((r) => setTimeout(r, 40 + Math.random() * 50))
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: center.x, y: center.y, button: 'left', clickCount: 1 })
  }

  /** Real per-char key events (with `text`) so site handlers see native input, not pasted text. */
  async typeText(text: string): Promise<void> {
    for (const ch of text) {
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch })
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
      await new Promise((r) => setTimeout(r, 20 + Math.random() * 50))
    }
  }

  async pressEnter(): Promise<void> {
    const base = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
    await this.send('Input.dispatchKeyEvent', { ...base, type: 'rawKeyDown', text: '\r', unmodifiedText: '\r' })
    await this.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' })
  }

  /** First enabled option on the k-th visible select element, dispatched as a real change event. */
  async selectFirst(k: number): Promise<void> {
    await this.eval(`(function (idx) {
      const sel = document.querySelectorAll('select')[idx]
      if (!sel) return
      const opt = Array.from(sel.options).find(function (o) { return !o.disabled && o.value })
      if (opt) {
        sel.value = opt.value
        sel.dispatchEvent(new Event('change', { bubbles: true }))
      }
    })(${k})`)
  }

  /** Detach only — the user's Chrome keeps running. */
  detach(): Promise<void> {
    return new Promise((resolve) => {
      const ws = this.ws
      this.ws = undefined
      this.wsUrl = undefined
      if (!ws) {
        resolve()
        return
      }
      ws.once('close', () => resolve())
      ws.close()
    })
  }
}

if (require.main === module) {
  // self-check: attach to a live debug endpoint (if any), read page + screenshot, detach
  const d = new CdpDriver()
  d.connect()
    .then(async () => {
      const url = await d.pageUrl()
      const shot = await d.screenshot()
      if (!url || shot.b64.length < 100) throw new Error('empty page URL or screenshot')
      console.log(`[cdp-driver] self-check ✓ — attached, page ${url}, shot ${(shot.b64.length / 1024) | 0}KB`)
      await d.detach()
    })
    .catch((e) => {
      console.error(`[cdp-driver] self-check skipped: ${e.message}`)
      process.exitCode = 1
    })
}