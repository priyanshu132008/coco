import { exec } from 'node:child_process'
import { promisify } from 'node:util'

const execP = promisify(exec)

export const CDP_DEBUG_PORT = 9222

/** Isolated profile dir — fresh process + separate profile so a running default-profile Chrome can't swallow the flags. */
export const CHROME_PROFILE_DIR = '/tmp/openinstinct-chrome-profile'

/** Per-platform shell command that starts Google Chrome on an isolated profile with the CDP debug port open, skipping all first-run UX. */
export function chromeLaunchCommand(platform = process.platform): string {
  const FRE = '--no-first-run --no-default-browser-check --disable-fre --disable-search-engine-choice-screen'
  switch (platform) {
    case 'darwin':
      // -n forces a fresh process; --user-data-dir isolates it from the user's everyday window set,
      // which is also what makes --remote-debugging-port stick when Chrome is already open
      return `open -na "Google Chrome" --args --remote-debugging-port=9222 --user-data-dir="${CHROME_PROFILE_DIR}" ${FRE}`
    case 'win32':
      return `cmd /c start chrome --remote-debugging-port=9222 --user-data-dir="${CHROME_PROFILE_DIR}" ${FRE}`
    default:
      return `google-chrome --remote-debugging-port=9222 --user-data-dir="${CHROME_PROFILE_DIR}" ${FRE} || chromium-browser --remote-debugging-port=9222 --user-data-dir="${CHROME_PROFILE_DIR}" ${FRE} || chromium --remote-debugging-port=9222 --user-data-dir="${CHROME_PROFILE_DIR}" ${FRE}`
  }
}

/** Cleanup command that kills orphaned OpenInstinct-profile Chrome processes holding the port/profile. */
export function staleKillCommand(platform = process.platform): string {
  return platform === 'win32'
    ? `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object CommandLine -match 'openinstinct-chrome-profile' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`
    : 'pkill -f openinstinct-chrome-profile'
}

/** Process manager for the live-hook architecture: reuse the devtools port if live, else spawn real Chrome and wait for CDP. */
export class LiveChromeLauncher {
  constructor(private base = `http://127.0.0.1:${CDP_DEBUG_PORT}`) {}

  /** True when http://127.0.0.1:9222/json/version answers 200 — i.e. a CDP-attachable Chrome is up. */
  async endpointLive(timeoutMs = 1500): Promise<boolean> {
    try {
      const res = await fetch(`${this.base}/json/version`, { signal: AbortSignal.timeout(timeoutMs) })
      return res.ok
    } catch {
      return false
    }
  }

  /** Count of live page targets — a debug endpoint can answer but carry zero tabs (zombie browser holding the port), which attaches must treat as dead. */
  async pageTargets(timeoutMs = 1500): Promise<number> {
    try {
      const res = await fetch(`${this.base}/json/list`, { signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) return 0
      const targets = (await res.json()) as { type: string }[]
      return targets.filter((t) => t.type === 'page').length
    } catch {
      return 0
    }
  }

  /** Attaches only: healthy endpoint (version live AND page targets present) → reuse; else clean stale debug instances, spawn, poll until a tab exists. */
  async ensureChrome(waitMs = 30_000): Promise<{ launched: boolean }> {
    if ((await this.endpointLive()) && (await this.pageTargets()) > 0) return { launched: false }
    console.log('[launcher] no healthy CDP endpoint on 9222 — cleaning stale instances, then spawning Google Chrome')
    // orphaned debug-profile processes lock port 9222 / the profile dir and make the spawn useless
    await execP(staleKillCommand()).catch(() => {}) // nonzero when nothing matches — expected
    await new Promise((r) => setTimeout(r, 500))
    await execP(chromeLaunchCommand()).catch((e) => {
      throw new Error(`chrome launch failed: ${e.message} — is Google Chrome installed?`)
    })
    for (let t = 0; t < waitMs; t += 500) {
      await new Promise((r) => setTimeout(r, 500))
      if ((await this.endpointLive()) && (await this.pageTargets()) > 0) return { launched: true }
    }
    throw new Error(`chrome CDP endpoint did not open within ${waitMs / 1000}s — Chrome may already run without the debug flag; quit it fully, then retry`)
  }
}

if (require.main === module) {
  // self-check: command builders + endpoint probe against whatever is (not) running on this machine
  const cmd = chromeLaunchCommand('darwin')
  const assert = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(`launcher self-check failed: ${msg}`)
  }
  assert(/remote-debugging-port=9222/.test(cmd), 'missing debug flag')
  assert(/--user-data-dir="\/tmp\/openinstinct-chrome-profile"/.test(cmd), 'missing isolated profile dir')
  assert('--no-first-run --no-default-browser-check --disable-fre --disable-search-engine-choice-screen'.split(' ').every((f) => cmd.includes(f)), 'missing first-run bypass flags')
  assert(staleKillCommand('darwin') === 'pkill -f openinstinct-chrome-profile', 'stale-kill command wrong')
  new LiveChromeLauncher()
    .endpointLive()
    .then((live) => console.log(`[launcher] self-check ✓ — command builders OK, CDP endpoint ${live ? 'LIVE' : 'closed'}`))
}