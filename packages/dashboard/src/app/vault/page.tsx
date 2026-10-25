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

/** The manager tabs: what they list, and the form fields their "add/update" row saves. */
type Tab = 'credentials' | 'card' | 'location'
const TABS: { key: Tab; label: string; fields: Field[]; gate: Gate }[] = [
  {
    key: 'credentials',
    label: 'Logins',
    gate: 'credentials',
    fields: [
      { name: 'username', label: 'Username, email or phone', autoComplete: 'username' },
      { name: 'password', label: 'Password', type: 'password', autoComplete: 'current-password' },
    ],
  },
  {
    key: 'card',
    label: 'Payments',
    gate: 'card',
    fields: [
      { name: 'upi', label: 'UPI ID', placeholder: 'name@bank' },
      { name: 'pan', label: 'Card number', placeholder: '4111 1111 1111 1111', autoComplete: 'cc-number' },
      { name: 'cvv', label: 'CVV', type: 'tel', placeholder: '123', autoComplete: 'cc-csc' },
      { name: 'expiry', label: 'Expiry', placeholder: '09/27', autoComplete: 'cc-exp' },
    ],
  },
  {
    key: 'location',
    label: 'Addresses',
    gate: 'location',
    fields: [
      { name: 'address', label: 'Delivery address', placeholder: 'Flat 4B, Powai, Mumbai', autoComplete: 'street-address' },
      { name: 'pincode', label: 'Pincode', type: 'tel', placeholder: '400076', autoComplete: 'postal-code' },
    ],
  },
]

/** What one saved entry shows in a tab (field order kept stable). */
const TAB_ROW_FIELDS: Record<Tab, string[]> = {
  credentials: ['username', 'password'],
  card: ['upi', 'pan', 'cvv', 'expiry'],
  location: ['address'],
}

function Manager(): React.ReactElement {
  const [tab, setTab] = useState<Tab>('credentials')
  const [entries, setEntries] = useState<Array<Record<string, string>> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reveal, setReveal] = useState<Record<string, boolean>>({})
  // "update" on a row → the add-form's site field is filled with that domain
  const [editDomain, setEditDomain] = useState('')
  const active = TABS.find((t) => t.key === tab) ?? TABS[0]

  async function load(): Promise<void> {
    try {
      const res = await fetch('/api/vault')
      const data = (await res.json()) as { success?: boolean; entries?: Array<Record<string, string>>; error?: string }
      if (!res.ok || !data.success) {
        setError(data.error ?? 'Could not read the vault.')
        return
      }
      setError(null)
      setEntries(data.entries ?? [])
    } catch {
      setError('Could not reach the server. Is the dashboard running?')
    }
  }
  useEffect(() => {
    void load()
  }, [])
  useEffect(() => {
    setReveal({}) // switching tabs re-masks everything
  }, [tab])

  const rows = (entries ?? []).filter((e) => (TAB_ROW_FIELDS[tab] ?? []).some((f) => e[f]))

  return (
    <main className="mx-auto w-full max-w-xl px-6 py-16 pb-32">
      <p className="font-sans text-xs uppercase tracking-[0.18em] text-ink-muted">Secure vault</p>
      <h1 className="mt-4 font-serif text-3xl leading-tight tracking-tight text-ink sm:text-4xl">
        Everything Coco can use. Encrypted on this machine, decrypted only when an agent works.
      </h1>

      <div className="mt-8 flex gap-2 border-b border-ink/15">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 font-sans text-sm transition-opacity duration-200 ${
              tab === t.key ? 'border-b-2 border-ink font-medium text-ink' : 'text-ink-muted hover:opacity-70'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && (
        <p role="alert" className="mt-8 font-sans text-sm text-ink">
          {error}
        </p>
      )}

      {entries && rows.length === 0 && (
        <p className="mt-8 font-sans text-sm text-ink-muted">Nothing saved here yet.</p>
      )}

      {entries && rows.length > 0 && (
        <ul className="mt-6">
          {rows.map((e) => (
            <li key={e.domain} className="border-b border-ink/10 py-4">
              <p className="font-sans text-sm font-medium text-ink">{e.domain}</p>
              <dl className="mt-2 font-sans text-sm text-ink-muted">
                {TAB_ROW_FIELDS[tab].map((f) => {
                  const v = (e[f] || '').trim()
                  if (!v) return null
                  const secret = f === 'password' || f === 'cvv' || f === 'pan'
                  const shown = secret && !reveal[`${e.domain}:${f}`]
                  return (
                    <div key={f} className="flex items-baseline justify-between gap-4">
                      <dt className="shrink-0">{f}</dt>
                      <dd className="text-right">{shown ? maskValue(f, v) || '••••••' : v}</dd>
                      {secret && (
                        <button
                          type="button"
                          aria-label={shown ? `Reveal ${f}` : `Hide ${f}`}
                          onClick={() => setReveal((r) => ({ ...r, [`${e.domain}:${f}`]: !r[`${e.domain}:${f}`] }))}
                          className="font-sans text-xs text-ink-muted underline hover:opacity-70"
                        >
                          {shown ? 'reveal' : 'hide'}
                        </button>
                      )}
                    </div>
                  )
                })}
              </dl>
              <button
                type="button"
                onClick={() => setEditDomain(e.domain)}
                className="mt-2 font-sans text-xs text-ink-muted underline hover:opacity-70"
              >
                update
              </button>
            </li>
          ))}
        </ul>
      )}

      <AddForm
        fields={active.fields}
        gate={active.gate}
        prefillDomain={editDomain}
        saved={async () => {
          setEditDomain('')
          await load()
        }}
      />
    </main>
  )
}

function maskValue(field: string, value: string): string {
  if (field === 'password' || field === 'cvv') return '••••••'
  if (field === 'pan') return '•••• ' + value.replace(/\s/g, '').slice(-4)
  return ''
}

/** The add/update form at the bottom of a tab: site + the tab's fields → the submit API. */
function AddForm({
  fields,
  gate,
  prefillDomain,
  saved,
}: {
  fields: Field[]
  gate: Gate
  prefillDomain?: string
  saved: () => Promise<void>
}): React.ReactElement {
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedMsg, setSavedMsg] = useState(false)
  // site field: starts from the "update" button's domain; clearing it stays cleared
  const [siteDomain, setSiteDomain] = useState(prefillDomain ?? '')
  useEffect(() => {
    if (prefillDomain) setSiteDomain(prefillDomain)
  }, [prefillDomain])

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const domain = siteDomain.trim()
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
      setSavedMsg(true)
      setValues({})
      setSiteDomain('')
      await saved()
      setTimeout(() => setSavedMsg(false), 3000)
    } catch {
      setError('Could not reach the server. Is the dashboard running?')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="mt-14" onSubmit={(e) => void submit(e)}>
      <h2 className="font-serif text-xl tracking-tight text-ink">Add / update</h2>
      <div className="mb-9 mt-6">
        <label htmlFor="domain" className="block font-sans text-sm font-medium text-ink">
          Site (e.g. amazon.in)
        </label>
        <input
          id="domain"
          name="domain"
          type="text"
          required
          // bare ?domain=X from the bot pre-fills the site — jump straight to the fields
          value={siteDomain}
          onChange={(e) => setSiteDomain(e.target.value)}
          className={inputClass}
        />
      </div>
      {fields.map((f) => (
        <div key={f.name} className="mb-9">
          <label htmlFor={`add-${f.name}`} className="block font-sans text-sm font-medium text-ink">
            {f.label}
          </label>
          <input
            id={`add-${f.name}`}
            name={f.name}
            type={f.type ?? 'text'}
            placeholder={f.placeholder}
            autoComplete={f.autoComplete ?? 'off'}
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
      {savedMsg && <p className="mt-4 font-sans text-sm text-ink-muted">Saved — encrypted at rest.</p>}

      <button
        type="submit"
        disabled={busy}
        className="mt-6 rounded-sm bg-ink px-8 py-3 font-sans text-sm font-medium text-paper transition-opacity duration-200 hover:opacity-80 disabled:opacity-50"
      >
        {busy ? 'Encrypting…' : 'Encrypt & save'}
      </button>
    </form>
  )
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

/** A link with a site (Telegram bot button) shows the gate form for that site; the plain
 *  /vault page is the manager: tabbed logins / payments / addresses, add and update. */
export default function VaultPage(): React.ReactElement {
  return (
    <>
      <Script src="https://telegram.org/js/telegram-web-app.js" strategy="beforeInteractive" />
      <Suspense fallback={null}>
        <VaultRoot />
      </Suspense>
    </>
  )
}

function VaultRoot(): React.ReactElement {
  const params = useSearchParams()
  return params.get('domain') ? <VaultForm /> : <Manager />
}
