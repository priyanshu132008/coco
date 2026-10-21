import { chromium } from 'playwright-extra'
import type { Page } from 'playwright'
import stealthPlugin from 'puppeteer-extra-plugin-stealth'
import * as fs from 'node:fs'
import * as path from 'node:path'

// ponytail: site flows are best-effort selector strategies — sites behind login walls
// (payment modals with UPI/Paytm/Razorpay) go only as deep as anonymous checkout allows.

/** How to find the element a step acts on. Empty criteria = the currently focused element. */
interface TargetCriteria {
  css?: string
  text?: string
  placeholder?: string
  markActive?: boolean
}

interface Step {
  intent: string
  action: 'CLICK' | 'TYPE' | 'PRESS_ENTER' | 'SELECT'
  criteria: TargetCriteria
  payload?: string
}

interface SiteProfile {
  name: string
  url: string
  steps: Step[]
}

const clickText = (intent: string, text: string): Step => ({ intent, action: 'CLICK', criteria: { text } })
const clickCss = (intent: string, css: string): Step => ({ intent, action: 'CLICK', criteria: { css } })
const typeInto = (intent: string, criteria: TargetCriteria, payload: string): Step => ({ intent, action: 'TYPE', criteria, payload })
const pressEnter = (intent: string): Step => ({ intent, action: 'PRESS_ENTER', criteria: { markActive: true } })

const dismiss = clickText(
  'Dismiss cookie / location popup',
  '\\b(accept|allow|got it|not now|maybe later|no,? thanks|agree|skip)\\b',
)
const add = clickText('Add item to cart', '^add\\b|\\badd( to car)?$')
const checkout = clickText('Open cart / checkout', 'view cart|checkout|\\bcart\\b')

export class DatasetGenerator {
  private outPath = path.resolve(__dirname, '..', '..', '..', '..', 'indian_ui_train.jsonl')

  sites: SiteProfile[] = [
    {
      name: 'zomato',
      url: 'https://www.zomato.com',
      steps: [
        dismiss,
        typeInto('Focus restaurant search', { css: 'input[data-testid="search-input"], input[placeholder*="Search for restaurant"], input[placeholder*="Search"]' }, 'Paneer'),
        pressEnter('Submit "Paneer" search'),
        clickText('Open first matching restaurant', '\\bpaneer\\b|restaurant|kitchen|house|cafe'),
        clickText('Select paneer dish', '\\bpaneer\\b'),
        add,
        checkout,
      ],
    },
    {
      name: 'swiggy',
      url: 'https://www.swiggy.com',
      steps: [
        dismiss,
        typeInto('Focus food search', { css: 'input[placeholder*="Search"], input[type="search"]' }, 'Biryani'),
        pressEnter('Submit "Biryani" search'),
        clickText('Open first matching restaurant', '\\bbiryani\\b|restaurant|hotel|house|kitchen'),
        add,
        clickText('Add item to cart / open checkout', '^add\\b|checkout|view cart'),
      ],
    },
    {
      name: 'blinkit',
      url: 'https://blinkit.com',
      steps: [
        dismiss,
        typeInto('Set delivery location', { css: 'input[placeholder*="location" i], input[placeholder*="Search" i]' }, 'Bengaluru'),
        clickText('Confirm location suggestion', '\\bbengaluru\\b|bangalore'),
        typeInto('Search for "milk"', { css: 'input[placeholder*="Search" i]' }, 'milk'),
        clickText('Open first product result', '\\bmilk\\b'),
        add,
        checkout,
      ],
    },
    {
      name: "dominos",
      url: 'https://www.dominos.co.in',
      steps: [
        dismiss,
        clickText('Start online order', 'order online|start your order|start order'),
        typeInto('Set delivery address', { css: 'input[placeholder*="address" i], input[placeholder*="pincode" i], input[type="search"], input[type="text"]' }, 'Bengaluru'),
        pressEnter('Confirm delivery address'),
        clickText('Open first matching store', 'domino|store|bengaluru'),
        add,
        checkout,
      ],
    },
    {
      name: 'makemytrip',
      url: 'https://www.makemytrip.com',
      steps: [
        clickText('Dismiss interstitial popup', '\\b(maybe later|not now|later|got it|close|ok, thanks)\\b'),
        typeInto('Open From city field', { css: 'input[placeholder="From"], input[placeholder*="From" i], input[id*="from" i]' }, 'Delhi'),
        clickText('Select From suggestion: Delhi', '^delhi|delhi,'),
        typeInto('Open To city field', { css: 'input[placeholder="To"], input[placeholder*="To" i], input[id*="to" i]' }, 'Mumbai'),
        clickText('Select To suggestion: Mumbai', '^mumbai|mumbai,'),
        clickText('Pick travel date', '\\b(today|tomorrow)\\b|^\\s*\\d{1,2}\\b'),
        clickText('Search flights', '^search\\b'),
      ],
    },
    {
      name: 'ixigo',
      url: 'https://www.ixigo.com',
      steps: [
        dismiss,
        typeInto('Open From city field', { css: 'input[placeholder*="from" i], input[id*="from" i]' }, 'Delhi'),
        clickText('Select From suggestion: Delhi', '^delhi|delhi,'),
        typeInto('Open To city field', { css: 'input[placeholder*="to" i], input[id*="to" i]' }, 'Mumbai'),
        clickText('Select To suggestion: Mumbai', '^mumbai|mumbai,'),
        clickText('Pick travel date', '\\b(today|tomorrow)\\b'),
        clickText('Search flights', '^search\\b'),
        clickText('Book first flight', '^book\\b|book now|view prices'),
      ],
    },
    {
      name: 'easemytrip',
      url: 'https://www.easemytrip.com',
      steps: [
        dismiss,
        typeInto('Open From city field', { css: 'input[placeholder*="from" i], input[id*="From" i]' }, 'Delhi'),
        clickText('Select From suggestion: Delhi', '^delhi|delhi,'),
        typeInto('Open To city field', { css: 'input[placeholder*="to" i], input[id*="To" i]' }, 'Mumbai'),
        clickText('Select To suggestion: Mumbai', '^mumbai|mumbai,'),
        clickText('Pick travel date', '\\b(today|tomorrow)\\b|next month|next week'),
        clickText('Search flights', '^search\\b|search now'),
        clickText('Proceed to booking / fares', 'book now|^book\\b|view prices|book'),
      ],
    },
  ]

  async run(): Promise<number> {
    // start a fresh dataset on each full run
    fs.writeFileSync(this.outPath, '')
    chromium.use(stealthPlugin() as any)
    const browser = await chromium.launch({
      headless: true,
      args: ['--disable-blink-features=AutomationControlled'],
    })
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: 'en-IN',
      timezoneId: 'Asia/Kolkata',
    })

    let total = 0
    for (const site of this.sites) {
      const page = await context.newPage()
      let ok = 0
      try {
        await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
        for (const step of site.steps) {
          await this.delay()
          if (await this.executeStep(page, step, site.name)) ok++
        }
      } catch (err) {
        console.warn(`[dataset] ${site.name} aborted: ${err instanceof Error ? err.message : String(err)}`)
      }
      console.log(`[dataset] ${site.name}: ${ok}/${site.steps.length} actions captured`)
      total += ok
      await page.close().catch(() => {})
    }
    await browser.close()
    return total
  }

  /** Human-readable randomized delay (1500–3500 ms). */
  private delay(): Promise<void> {
    return new Promise((r) => setTimeout(r, 1500 + Math.random() * 2000))
  }

  /** Resolve + mark the target, capture state BEFORE the action, append, then act. */
  private async executeStep(page: Page, step: Step, site: string): Promise<boolean> {
    const selector = await this.resolveSelector(page, step)
    if (!selector) {
      console.log(`[dataset] ${site} ✗ skipped — target not found: "${step.intent}"`)
      return false
    }
    const screenshot = await page.screenshot({ type: 'png', timeout: 15_000 })
    const domNodes = await page.evaluate((interactiveSel: string) => {
      const vis = (el: Element) => {
        const r = el.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      return Array.from(document.querySelectorAll(interactiveSel))
        .filter(vis)
        .map((el, i) => ({
          index: i,
          tag: el.tagName,
          id: el.id || undefined,
          href: el instanceof HTMLAnchorElement ? el.href : undefined,
          placeholder: el instanceof HTMLInputElement ? el.placeholder : undefined,
          ariaLabel: el.getAttribute('aria-label') || undefined,
          dataOi: el.getAttribute('data-oi') || undefined,
          text: ((el as HTMLElement).innerText || (el as HTMLInputElement).value || '').trim().slice(0, 140) || undefined,
        }))
    }, "a, button, input, select, textarea, [onclick]")

    const choice =
      step.action === 'TYPE'
        ? { action: 'TYPE', selector, payload: step.payload }
        : { action: step.action, selector }
    const record = {
      image_base64: screenshot.toString('base64'),
      dom_snippet: JSON.stringify(domNodes),
      intent: step.intent,
      action_choice: JSON.stringify(choice),
    }
    fs.appendFileSync(this.outPath, JSON.stringify(record) + '\n')
    await this.act(page, selector, step)
    console.log(`[dataset] ${site} ✓ "${step.intent}" → ${choice.action} ${selector}`)
    return true
  }

  /** Mark the matching element with a temporary attribute and return its selector. */
  private async resolveSelector(page: Page, step: Step): Promise<string | null> {
    const c = step.criteria
    return page.evaluate((c: TargetCriteria) => {
      const vis = (el: Element) => {
        const r = el.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const mark = (el: Element | null): string | null => {
        if (!el) return null
        const id = 'oi' + Math.random().toString(36).slice(2, 8)
        el.setAttribute('data-oi', id)
        return `[data-oi="${id}"]`
      }
      if (c.markActive) return mark(document.activeElement)
      let el: Element | null = null
      if (c.css) {
        const found = Array.from(document.querySelectorAll(c.css)).find(vis)
        if (found) return mark(found)
      }
      const interactive = 'a, button, input, select, textarea, li, [onclick], [role="button"], [role="link"], [role="tab"], [role="option"]'
      const candidates = Array.from(document.querySelectorAll(interactive)).filter(vis)
      if (c.placeholder) {
        el =
          candidates.find(
            (e) => e instanceof HTMLInputElement && (e.placeholder || '').toLowerCase().includes(c.placeholder!.toLowerCase()),
          ) ?? null
      }
      if (!el && c.text) {
        const re = new RegExp(c.text, 'i')
        el = candidates.find((e) => re.test(((e as HTMLElement).innerText || (e as HTMLInputElement).value || '').trim())) ?? null
      }
      return mark(el)
    }, c)
  }

  private async act(page: Page, selector: string, step: Step): Promise<void> {
    const loc = page.locator(selector).first()
    switch (step.action) {
      case 'CLICK':
        await loc.click({ timeout: 8_000 })
        break
      case 'TYPE':
        await loc.click({ timeout: 8_000 })
        if (step.payload) await page.keyboard.type(step.payload, { delay: 40 + Math.random() * 90 })
        break
      case 'PRESS_ENTER':
        await page.keyboard.press('Enter')
        break
      case 'SELECT':
        await (loc as any).selectOption({ label: step.payload ?? '' })
        break
    }
  }
}

if (require.main === module) {
  new DatasetGenerator()
    .run()
    .then((n) => {
      console.log(`\n[dataset] done — ${n} records written to indian_ui_train.jsonl`)
      process.exit(0)
    })
    .catch((err) => {
      console.error('[dataset] fatal:', err)
      process.exit(1)
    })
}