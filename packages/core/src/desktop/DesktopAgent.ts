import { StealthBrowser, type ExtractedPage } from '../driver/StealthBrowser.js'
import { vault } from '../security/Vault.js'

export interface AgentCommand {
  type: 'NAVIGATE' | 'CLICK' | 'TYPE' | 'SUBMIT'
  url?: string
  selector?: string
  payload?: string
}

export interface AgentResult {
  ok: boolean
  screenshot?: Buffer
  domTree?: string
  /** Field name → value, populated by fillForm/runBooking. */
  summary?: Record<string, string>
  error?: string
}

export interface FormField {
  /** Label text, placeholder text, or input `name`/`id`. */
  name: string
  value: string
}

/** Phase 1 hand: desktop web automation (booking flows, form filling) on the stealth Chromium stack. */
export class DesktopAgent {
  private browser = new StealthBrowser()

  async execute(cmd: AgentCommand): Promise<AgentResult> {
    try {
      await this.browser.initialize() // stealth Chromium auto-arms on first command (idempotent)
      if (cmd.type === 'NAVIGATE') {
        if (!cmd.url) throw new Error('NAVIGATE requires a url')
        const r = await this.browser.navigateAndExtract(cmd.url)
        return { ok: true, screenshot: r.screenshot, domTree: r.domTree }
      }
      if (cmd.type === 'CLICK') {
        await this.click(cmd.selector)
      } else if (cmd.type === 'TYPE') {
        await this.type(cmd.selector, cmd.payload ?? '')
      } else if (cmd.type === 'SUBMIT') {
        if (cmd.selector) await this.click(cmd.selector)
        else await this.browser.getPage().keyboard.press('Enter')
      }
      const s = await this.browser.snapshot()
      return { ok: true, screenshot: s.screenshot, domTree: s.domTree }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** `vault:key` payloads resolve through the encrypted store — plaintext never passes through plans. */
  private secret(value: string): string {
    return value.startsWith('vault:') ? vault.get(value.slice(6)) ?? '' : value
  }

  async click(selector?: string): Promise<void> {
    if (!selector) throw new Error('CLICK requires a selector')
    await this.browser.getPage().locator(selector).first().click({ timeout: 10_000 })
  }

  async type(selector: string | undefined, text: string): Promise<void> {
    const value = this.secret(text)
    const page = this.browser.getPage()
    if (selector) {
      const loc = page.locator(selector).first()
      // travel sites (e.g. easemytrip) hide city inputs until their parent widget is clicked —
      // when the input is invisible, open the closest clickable ancestor first, then fill
      if (!(await loc.isVisible().catch(() => false))) {
        const opened = await loc
          /**
           * walk ancestors and click the first visible widget (onclick / pointer cursor)
           */
          .evaluate((el: HTMLElement): string | null => {
            let n: HTMLElement | null = el.parentElement
            while (n && n !== document.body) {
              if ((n.getAttribute('onclick') || getComputedStyle(n).cursor === 'pointer') && n.offsetParent != null) {
                n.click()
                return `${n.tagName.toLowerCase()}${n.id ? `#${n.id}` : ''}`
              }
              n = n.parentElement
            }
            return null
          })
          .catch(() => null)
        if (opened) console.log(`[desktop] input ${selector} invisible — opened city widget ${opened}`)
        await page.waitForTimeout(600) // let the dropdown panel mount
      }
      await loc.click({ timeout: 10_000 }).catch(() => {}) // input may still be covered by the panel wrapper
      await loc.fill(value)
    } else {
      await page.keyboard.type(value, { delay: 30 + Math.random() * 70 })
    }
  }

  /** Fills a form by trying name/id attr → placeholder → label for each field. Returns field name → value. */
  async fillForm(fields: FormField[]): Promise<Record<string, string>> {
    if (!fields.length) return {}
    await this.browser.initialize()
    const page = this.browser.getPage()
    const filled: Record<string, string> = {}
    for (const f of fields) {
      const candidates = [
        page.locator(`input[name="${f.name}"], input[id="${f.name}"], textarea[name="${f.name}"]`),
        page.getByPlaceholder(f.name),
        page.getByLabel(f.name),
      ]
      let done = false
      for (const loc of candidates) {
        const first = loc.first()
        try {
          if ((await first.count()) > 0 && (await first.isVisible())) {
            await first.fill(this.secret(f.value), { timeout: 5_000 })
            filled[f.name] = f.value // key name only; resolved secret stays inside fill()
            done = true
            break
          }
        } catch {
          // try the next matching strategy
        }
      }
      if (!done) throw new Error(`fillForm: no visible input matched "${f.name}"`)
    }
    return filled
  }

  /** NAVIGATE → fillForm → SUBMIT, returning the post-submit state (booking-flow shaped). */
  async runBooking(url: string, fields: FormField[], submitSelector?: string): Promise<AgentResult> {
    await this.browser.initialize()
    await this.browser.navigateAndExtract(url)
    const summary = await this.fillForm(fields)
    if (submitSelector) await this.click(submitSelector)
    else await this.browser.getPage().keyboard.press('Enter')
    const r = await this.browser.snapshot()
    return { ok: true, screenshot: r.screenshot, domTree: r.domTree, summary }
  }
}