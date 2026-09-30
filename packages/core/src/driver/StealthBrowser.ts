import { chromium } from 'playwright-extra'
import type { Browser, BrowserContext, Page } from 'playwright'
import stealthPlugin from 'puppeteer-extra-plugin-stealth'

/** Payload handed to the visual/generation model for one page. */
export interface ExtractedPage {
  screenshot: Buffer
  domTree: string
}

export class StealthBrowser {
  private browser?: Browser
  private context?: BrowserContext
  private page?: Page

  async initialize(): Promise<void> {
    if (this.browser) return
    chromium.use(stealthPlugin() as any)
    this.browser = await chromium.launch({
      headless: true,
      args: ['--disable-blink-features=AutomationControlled'],
    })
    this.context = await this.browser.newContext()
    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    })
    this.page = await this.context.newPage()
  }

  async navigateAndExtract(url: string): Promise<ExtractedPage> {
    if (!this.page) throw new Error('StealthBrowser not initialized — call initialize() first')
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    const screenshot = await this.page.screenshot({ type: 'png' })
    const nodes = await this.page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('a, button, input, select, textarea'))
        .filter((el) => {
          const r = el.getBoundingClientRect()
          return r.width > 0 && r.height > 0
        })
        .map((el, i) => ({
          index: i,
          tag: el.tagName,
          id: el.id || undefined,
          href: el instanceof HTMLAnchorElement ? el.href : undefined,
          placeholder: el instanceof HTMLInputElement ? el.placeholder : undefined,
          ariaLabel: el.getAttribute('aria-label') || undefined,
          text: (el.innerText || (el as HTMLInputElement).value || '').trim().slice(0, 120) || undefined,
        })),
    )
    return { screenshot, domTree: JSON.stringify(nodes) }
  }

  async close(): Promise<void> {
    await this.browser?.close()
    this.browser = this.context = this.page = undefined
  }
}