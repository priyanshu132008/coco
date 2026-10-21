import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// ponytail: single-blob whole-file encryption with a 32-byte key file (~/.openinstinct/vault.key,
// mode 600) or OI_VAULT_PASSWORD scrypt. Re-key/per-entry encryption when the threat model grows.

interface EncryptedBlob {
  v: 1
  salt: string
  iv: string
  tag: string
  ct: string
}

/** Encrypted local secret store: AES-256-GCM at rest, never logs or returns plaintext outside get(). */
export class Vault {
  private loaded = false
  private broken = false
  private salt: string | undefined
  private data = new Map<string, string>()

  constructor(
    private blobPath = path.join(os.homedir(), '.openinstinct', 'vault.enc'),
  ) {}

  get(key: string): string | undefined {
    this.ensure()
    return this.data.get(key)
  }

  set(key: string, value: string): void {
    this.ensure()
    this.data.set(key, value)
    this.flush()
  }

  delete(key: string): boolean {
    this.ensure()
    const had = this.data.delete(key)
    if (had) this.flush()
    return had
  }

  /** Key names only — values never leave via this API. */
  list(): string[] {
    this.ensure()
    return [...this.data.keys()]
  }

  private ensure(): void {
    if (this.loaded) return
    this.loaded = true
    if (!fs.existsSync(this.blobPath)) return
    try {
      const blob = JSON.parse(fs.readFileSync(this.blobPath, 'utf8')) as EncryptedBlob
      this.salt = blob.salt
      const key = this.deriveKey(blob.salt)
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'hex'))
      decipher.setAuthTag(Buffer.from(blob.tag, 'hex'))
      const plain = Buffer.concat([decipher.update(Buffer.from(blob.ct, 'hex')), decipher.final()]).toString('utf8')
      for (const [k, v] of Object.entries(JSON.parse(plain) as Record<string, unknown>)) this.data.set(k, String(v))
    } catch (err) {
      // refuse writes on a broken vault — flush() with empty data would silently destroy secrets
      this.broken = true
      throw new Error(`vault: cannot decrypt ${this.blobPath} (${err instanceof Error ? err.message : err}) — restore vault.enc or its key, or set OI_VAULT_PASSWORD`)
    }
  }

  /** Dedicated key file: random 32 bytes, mode 600. A saved password (OI_VAULT_PASSWORD) overrides with scrypt. */
  private keyFile(): Buffer {
    const keyFile = path.join(path.dirname(this.blobPath), 'vault.key')
    fs.mkdirSync(path.dirname(keyFile), { recursive: true })
    if (fs.existsSync(keyFile)) {
      const key = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex')
      if (key.length === 32) return key
    }
    const key = crypto.randomBytes(32)
    fs.writeFileSync(keyFile, key.toString('hex') + '\n', { mode: 0o600 as const })
    try {
      fs.chmodSync(keyFile, 0o600)
    } catch {
      // best-effort permissions
    }
    return key
  }

  private deriveKey(salt: string): Buffer {
    const pw = process.env.OI_VAULT_PASSWORD
    return pw ? crypto.scryptSync(pw, salt, 32) : this.keyFile()
  }

  private flush(): void {
    if (this.broken) throw new Error('vault: refusing to overwrite an undecryptable vault — restore the key first')
    if (!this.salt) this.salt = crypto.randomBytes(16).toString('hex')
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', this.deriveKey(this.salt), iv)
    const plain = Buffer.from(JSON.stringify(Object.fromEntries(this.data)), 'utf8')
    const ct = Buffer.concat([cipher.update(plain), cipher.final()])
    fs.mkdirSync(path.dirname(this.blobPath), { recursive: true })
    fs.writeFileSync(this.blobPath, JSON.stringify({
      v: 1 as const,
      salt: this.salt,
      iv: iv.toString('hex'),
      tag: cipher.getAuthTag().toString('hex'),
      ct: ct.toString('hex'),
    } satisfies EncryptedBlob, null, 2))
    try {
      fs.chmodSync(this.blobPath, 0o600)
    } catch {
      // best-effort permissions
    }
  }
}

export const vault = new Vault()

if (require.main === module) {
  // self-check: AES-256-GCM roundtrip in a temp dir, no plaintext on disk
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oi-vault-'))
  const file = path.join(dir, 'vault.enc')
  const secret = crypto.randomBytes(16).toString('hex')
  const v = new Vault(file)
  v.set('upi.test.pin', secret)
  v.set('form.token', 'tok_' + secret)

  const raw = fs.readFileSync(file, 'utf8')
  const assert = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(`vault self-check failed: ${msg}`)
  }
  assert(!raw.includes(secret), 'ciphertext file must not contain the plaintext secret')
  assert(!raw.includes('upi.test.pin'), 'key names live inside the encrypted blob, not on disk')
  assert(new Vault(file).get('upi.test.pin') === secret, 'roundtrip across instances')
  assert(new Vault(file).list().sort().join(',') === 'form.token,upi.test.pin', 'all keys hydrate')
  // corrupt key → must throw on read, never silently empty or overwrite
  fs.writeFileSync(path.join(dir, 'vault.key'), '00'.repeat(32) + '\n')
  let threw = false
  try {
    new Vault(file).get('x')
  } catch {
    threw = true
  }
  assert(threw, 'corrupt vault must throw instead of returning undefined')
  console.log('[vault] self-check ✓ — AES-256-GCM at rest, persists across instances, corrupt-vault guard')
}