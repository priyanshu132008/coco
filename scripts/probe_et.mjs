import { chromium } from 'playwright'

// one-shot probe: find the actual From/To city inputs/widgets on easemytrip
const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
await page.goto('https://www.easemytrip.com', { waitUntil: 'domcontentloaded', timeout: 30_000 })
await page.waitForTimeout(10000)
const info = await page.evaluate(() => {
  const hits = []
  for (const input of document.querySelectorAll('input, [role=textbox], [role=combobox]')) {
    const id = input.id || ''
    const ph = input.getAttribute('placeholder') || ''
    const name = input.getAttribute('name') || ''
    if (/from|to|sector|origin|dest|city|route|location/i.test(`${id} ${ph} ${name}`)) {
      hits.push({ tag: input.tagName, id, name, placeholder: ph, visible: input.offsetParent != null, html: input.outerHTML.slice(0, 200) })
    }
  }
  return { title: document.title, url: location.href, hits: hits.slice(0, 20) }
})
console.log(JSON.stringify(info, null, 2))
await browser.close()