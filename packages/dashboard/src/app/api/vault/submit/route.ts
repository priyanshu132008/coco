import { NextResponse } from 'next/server'
import {
  joinAddress,
  pickFields,
  relayLocation,
  resolveGate,
  saveToVault,
  taskWaitingForLocation,
} from '../../../../lib/vault'

export const runtime = 'nodejs'

export async function POST(req: Request): Promise<NextResponse> {
  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'body must be JSON' }, { status: 400 })
  }

  const domain = typeof body.domain === 'string' ? body.domain.trim().toLowerCase() : ''
  if (!domain) return NextResponse.json({ error: 'domain is required' }, { status: 400 })

  const gate = resolveGate(body.gate)
  const fields = pickFields(gate, body)

  // the vault keeps one address column — a separate pincode rides along in it
  const pincode = typeof body.pincode === 'string' ? body.pincode.trim() : ''
  if (pincode && fields.address) fields.address = joinAddress(fields.address, pincode)
  else if (pincode && gate === 'location') fields.address = pincode

  if (!Object.keys(fields).length) {
    return NextResponse.json({ error: 'nothing to store' }, { status: 400 })
  }

  try {
    await saveToVault(domain, fields)
    // a location gate also unblocks the driver that is waiting on an address
    if (gate === 'location' && fields.address) {
      const taskId = await taskWaitingForLocation(domain)
      if (taskId) await relayLocation(taskId, fields.address)
    }
    return NextResponse.json({ success: true })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Could not reach the vault.' },
      { status: 500 }
    )
  }
}
