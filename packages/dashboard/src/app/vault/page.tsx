'use client'

import { useEffect, useState } from 'react'
import Script from 'next/script'
import { useSearchParams } from 'next/navigation'
import { Suspense } from 'react'

type Gate = 'credentials' | 'location' | 'card' | '2fa' | 'all'

interface Field {
  name: string
  label: string
  type?: 'text' | 'password' | 'tel'
  placeholder?: string
  autoComplete?: string
}

/** What each gate asks for. Order is the order the form shows them in. */
const GATE_FIELDS: Record<Gate, Field[]> = {
  credentials: [
    { name: 'username', label: 'Username, email or phone', autoComplete: 'username' },
    { name: 'password', label: 'Password', type: 'password', autoComplete: 'current-password' },
  ],
  location: [
    { name: 'address', label: 'Delivery address', placeholder: 'Flat 4B, Powai, Mumbai', autoComplete: 'street-address' },
    { name: 'pincode', label: 'Pincode', type: 'tel', placeholder: '400076', autoComplete: 'postal-code' },
  ],
  card: [
    { name: 'pan', label: 'Card number', placeholder: '4111 1111 1111 1111', autoComplete: 'cc-number' },
    { name: 'cvv', label: 'CVV', type: 'tel', placeholder: '123', autoComplete: 'cc-csc' },
    { name: 'expiry', label: 'Expiry', placeholder: '09/27', autoComplete: 'cc-exp' },
    { name: 'upi', label: 'UPI ID', placeholder: 'name@bank' },
  ],
  '2fa': [
    { name: 'totp', label: 'Base32 setup key', placeholder: 'JBSWY3DPEHPK3PXP', autoComplete: 'off' },
  ],
  all: [
    { name: 'username', label: 'Username, email or phone', autoComplete: 'username' },
    { name: 'password', label: 'Password', type: 'password', autoComplete: 'current-password' },
    { name: 'address', label: 'Delivery address', placeholder: 'Flat 4B, Powai, Mumbai', autoComplete: 'street-address' },
    { name: 'pincode', label: 'Pincode', type: 'tel', placeholder: '400076', autoComplete: 'postal-code' },
    { name: 'pan', label: 'Card number', placeholder: '4111 1111 1111 1111', autoComplete: 'cc-number' },
    { name: 'cvv', label: 'CVV', type: 'tel', placeholder: '123', autoComplete: 'cc-csc' },
    { name: 'expiry', label: 'Expiry', placeholder: '09/27', autoComplete: 'cc-exp' },
    { name: 'upi', label: 'UPI ID', placeholder: 'name@bank' },
    { name: 'totp', label: 'Base32 setup key', placeholder: 'JBSWY3DPEHPK3PXP', autoComplete: 'off' },
  ],
}

const GATE_ALIASES: Record<string, Gate> = {
  credentials: 'credentials',
  credential: 'credentials',
  login: 'credentials',
  location: 'location',
  address: 'location',
  card: 'card',
  payment: 'card',
  '2fa': '2fa',
  totp: '2fa',
  all: 'all',
}

/** The heading each gate gets. */
const GATE_TITLE: Record<Gate, string> = {
  credentials: 'Your sign-in details.',
  location: 'Where should we deliver?',
  card: 'Your payment details.',
  '2fa': 'Your two-factor key.',
  all: 'Fill in what this site needs.',
}

function resolveGate(raw: string | null): Gate {
  const key = (raw || '').trim().toLowerCase()
  return GATE_ALIASES[key] ?? 'all'
}

function VaultForm(): React.ReactElement {
  const params = useSearchParams()
  const domain = (params.get('domain') || '').trim()
  const gate = resolveGate(params.get('gate'))
  const fields = GATE_FIELDS[gate]

  const [values, setValues] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  // outside Telegram (a plain browser) there is nothing to close
  const [hasTelegram, setHasTelegram] = useState(false)

  // the Telegram web app object only exists once its script has run
  useEffect(() => {
    const tg = window.Telegram?.WebApp
    if (tg) {
      setHasTelegram(true)
      tg.ready()
      tg.expand()
    }
  }, [])

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/vault/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ domain, gate, ...values }),
      })
      const data = (await res.json()) as { success?: boolean; error?: string }
      if (!res.ok || !data.success) {
        setError(data.error ?? 'Could not save to the vault.')
        return
      }
      setDone(true)
      const tg = window.Telegram?.WebApp
      tg?.HapticFeedback?.notificationOccurred('success')
      tg?.close()
    } catch {
      setError('Could not reach the server. Is the dashboard running?')
    } finally {
      setBusy(false)
    }
  }

  if (!domain) {
    return (
      <main className="mx-auto w-full max-w-xl px-6 py-16">
        <h1 className="font-serif text-3xl tracking-tight text-ink">No site specified.</h1>
        <p className="mt-6 font-sans text-base leading-relaxed text-ink-muted">
          Open this page from the button in your chat so it knows which account to fill.
        </p>
      </main>
    )
  }

  return (
    <main className="mx-auto w-full max-w-xl px-6 py-16 pb-32">
      <p className="font-sans text-xs uppercase tracking-[0.18em] text-ink-muted">Secure vault</p>
      <h1 className="mt-4 font-serif text-3xl leading-tight tracking-tight text-ink sm:text-4xl">
        {GATE_TITLE[gate]}
      </h1>
      <p className="mt-5 font-sans text-base leading-relaxed text-ink-muted">
        For <span className="text-ink">{domain}</span>. Everything is encrypted on this machine before it is
        stored — it never leaves your device in plain text.
      </p>

      {done ? (
        <p className="mt-14 font-sans text-lg text-ink">
          Saved to the vault{hasTelegram ? '. Closing…' : '.'}
        </p>
      ) : (
        <form className="mt-14" onSubmit={(e) => void submit(e)}>
          {fields.map((f) => (
            <div key={f.name} className="mb-9">
              <label htmlFor={f.name} className="block font-sans text-sm font-medium text-ink">
                {f.label}
              </label>
              <input
                id={f.name}
                name={f.name}
                type={f.type ?? 'text'}
                placeholder={f.placeholder}
                autoComplete={f.autoComplete ?? 'off'}
                required={f.name !== 'upi'}
                value={values[f.name] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                className={inputClass}
              />
            </div>
          ))}

          {error && (
            <p role="alert" className="mt-8 font-sans text-sm text-ink">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="mt-10 rounded-sm bg-ink px-8 py-3 font-sans text-sm font-medium text-paper transition-opacity duration-200 hover:opacity-80 disabled:opacity-50"
          >
            {busy ? 'Encrypting…' : 'Encrypt & save'}
          </button>
        </form>
      )}
    </main>
  )
}

/** Flat input: a single rule under the field, no boxed outline. */
const inputClass =
  'w-full border-0 border-b border-ink/25 bg-transparent px-0 py-2 font-sans text-base text-ink placeholder:text-ink-muted ' +
  'focus:border-b focus:border-ink focus:outline-none focus:ring-0'

export default function VaultPage(): React.ReactElement {
  return (
    <>
      <Script src="https://telegram.org/js/telegram-web-app.js" strategy="beforeInteractive" />
      <Suspense fallback={null}>
        <VaultForm />
      </Suspense>
    </>
  )
}
