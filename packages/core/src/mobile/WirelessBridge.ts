import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { AndroidBridge, type MobileResult } from './AndroidBridge.js'

const execFileP = promisify(execFile)

export interface WirelessTarget {
  host: string
  port: number
}

/** Parses `adb mdns services` output for ADB-over-Wi-Fi targets. */
export function parseMdnsServices(stdout: string): WirelessTarget[] {
  const targets: WirelessTarget[] = []
  for (const m of stdout.matchAll(/_adb-(?:tls-)?connect\._tcp(?:\.)?\s+([\d.]+):(\d+)/g)) {
    targets.push({ host: m[1], port: Number(m[2]) })
  }
  return targets
}

/**
 * Android bridge with Wi-Fi ADB support: when no USB device is attached it tries
 * COCO_WIRELESS_HOST (port COCO_WIRELESS_PORT, default 5555), then adb mDNS discovery,
 * connecting to the first reachable target so the same execute() interface just works.
 */
export class WirelessBridge extends AndroidBridge {
  /** Explicit `adb connect host:port` (default port 5555) + state verification. */
  async connect(host: string, port = 5555): Promise<boolean> {
    await execFileP(this.adbPath, ['connect', `${host}:${port}`], { timeout: 10_000 }).catch(() => null)
    try {
      const { stdout } = await execFileP(this.adbPath, ['-s', `${host}:${port}`, 'get-state'], { timeout: 5_000 })
      const ready = stdout.trim() === 'device'
      if (ready) this.serial = `${host}:${port}`
      return ready
    } catch {
      return false
    }
  }

  async disconnect(): Promise<void> {
    if (this.serial) await execFileP(this.adbPath, ['disconnect', this.serial], { timeout: 5_000 }).catch(() => null)
    this.serial = undefined
  }

  /** Wireless targets advertised by attached Android devices on the LAN. */
  async discover(): Promise<WirelessTarget[]> {
    return execFileP(this.adbPath, ['mdns', 'services'], { timeout: 5_000 })
      .then((r) => parseMdnsServices(r.stdout))
      .catch(() => [])
  }

  override async device(): Promise<string | null> {
    const usb = await super.device()
    if (usb) return usb
    const candidates: WirelessTarget[] = []
    const envHost = process.env.COCO_WIRELESS_HOST
    if (envHost) candidates.push({ host: envHost, port: Number(process.env.COCO_WIRELESS_PORT ?? 5555) })
    candidates.push(...(await this.discover()))
    for (const t of candidates) {
      console.log(`[wireless] no USB device — trying ${t.host}:${t.port} …`)
      if (await this.connect(t.host, t.port)) {
        console.log(`[wireless] connected to ${t.host}:${t.port}`)
        return `${t.host}:${t.port}`
      }
      console.log(`[wireless] ${t.host}:${t.port} unreachable`)
    }
    return null
  }

  static fromAndroidBridge(bridge: AndroidBridge): boolean {
    return bridge instanceof WirelessBridge
  }
}

if (require.main === module) {
  // self-check: mDNS output parsing (no device needed)
  const sample = `mdnsList: status: 0 (0) result: 2 (2) services:
	_adb-tls-connect._tcp.	192.168.1.42:37123
	_adb-connect._tcp.	10.0.0.7:5555
	other-service._tcp.	192.168.1.99:9999`
  const t = parseMdnsServices(sample)
  const assert = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(`wireless self-check failed: ${msg}`)
  }
  assert(t.length === 2, `expected 2 adb targets, got ${t.length}`)
  assert(t[0].host === '192.168.1.42' && t[0].port === 37123, 'first target parsed')
  assert(t[1].host === '10.0.0.7' && t[1].port === 5555, 'legacy adb connect parsed')
  console.log('[wireless] self-check ✓ — mdns target parsing OK')
}