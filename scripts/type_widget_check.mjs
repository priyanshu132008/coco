import { DesktopAgent } from '../packages/core/dist/index.js'
import * as fs from 'node:fs'

// self-check: invisible city input inside a clickable ancestor widget — TYPE must open it, then fill
const html = `<!doctype html><html><body><div id="FromSectorWrap" onclick="document.getElementById('FromSector').style.display='block'" style="cursor:pointer;padding:20px;display:inline-block">
 <div>FROM</div><input id="FromSector" style="display:none">
</div></body></html>`
fs.writeFileSync('/tmp/oi_citywidget.html', html)
const agent = new DesktopAgent()
const nav = await agent.execute({ type: 'NAVIGATE', url: `file:///tmp/oi_citywidget.html` })
console.log('nav ok:', nav.ok)
const r = await agent.execute({ type: 'TYPE', selector: '#FromSector', payload: 'Mumbai' })
const nodes = JSON.parse(r.domTree ?? '[]')
const hit = nodes.find((n) => n.id === 'FromSector')
console.log('typed value visible in DOM extract:', hit?.text === 'Mumbai', '(widget opened:', !!hit, ')')
console.log(r.ok && hit?.text === 'Mumbai' ? '[desktop] widget self-check ✓' : '[desktop] widget self-check ✗', () => process.exit(r.ok && hit?.text === 'Mumbai' ? 0 : 1)())