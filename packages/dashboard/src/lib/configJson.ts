import * as fs from 'node:fs'
import * as path from 'node:path'
import { repoRoot } from './env'
import type { SetupInput } from './setup'
import { planSetup } from './setup'

/** config.json beside vault.db — tools/byok.py's model source:
 *  it prefixes `provider/` on the bare model (unless it already starts with "openai/"). */
export function writeConfigJson(plan: SetupInput): void {
  const file = path.join(repoRoot(), 'config.json')
  fs.writeFileSync(file, JSON.stringify(planSetup(plan), null, 2) + '\n', 'utf8')
}

if (process.argv[1]?.endsWith('configJson.ts')) {
  process.env.COCO_ROOT = '/tmp'
  writeConfigJson({ token: 't', provider: 'custom', apiKey: 'k', baseUrl: 'http://x/v1', model: 'my-model' })
  const custom = JSON.parse(fs.readFileSync('/tmp/config.json', 'utf8'))
  if (custom.active_model !== 'my-model' || custom.provider !== 'openai') throw new Error('custom plan wrong: ' + JSON.stringify(custom)) // bare — byok.py prefixes
  writeConfigJson({ token: 't', provider: 'anthropic', apiKey: 'k' })
  const anth = JSON.parse(fs.readFileSync('/tmp/config.json', 'utf8'))
  if (anth.active_model !== 'claude-sonnet-5-5' || anth.provider !== 'anthropic') throw new Error('anthropic plan wrong: ' + JSON.stringify(anth))
  // user-specified model wins verbatim, even qualified across providers
  writeConfigJson({ token: 't', provider: 'openrouter', apiKey: 'k', model: 'anthropic/claude-3.5-sonnet' })
  const given = JSON.parse(fs.readFileSync('/tmp/config.json', 'utf8'))
  if (given.active_model !== 'anthropic/claude-3.5-sonnet' || given.provider !== 'openrouter') throw new Error('user model dropped: ' + JSON.stringify(given))
  // byok.py contract: provider-prefix exactly once when it resolves
  if (anth.active_model.split('/').filter((p: string) => p === 'anthropic').length !== 0) throw new Error('model pre-prefixed — byok.py would double it')
  fs.rmSync('/tmp/config.json', { force: true })
  console.log('configJson self-check OK (plans match byok.py)')
}