import { NextResponse } from 'next/server'
import { listVault } from '../../../lib/vault'

export const runtime = 'nodejs'

/** Vault manager read: decrypted vault.db entries (Fernet in tools/vault.py — the
 *  COCO_VAULT_KEY stays server-side; seeds never leave the module). */
export async function GET(): Promise<NextResponse> {
  try {
    const entries = await listVault()
    return NextResponse.json({ success: true, entries })
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : 'Could not read the vault.' },
      { status: 500 }
    )
  }
}