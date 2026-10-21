'use client'

import { useState } from 'react'
import Link from 'next/link'

const PROVIDERS = [
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'custom', label: 'Custom' },
] as const

type Provider = (typeof PROVIDERS)[number]['value']

interface SetupPayload {
  token: string
  provider: Provider
  apiKey: string
  baseUrl: string
  model: string
}

export default function SetupPage(): React.ReactElement {
  const [token, setToken] = useState('')
  const [provider, setProvider] = useState<Provider>('openrouter')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [botName, setBotName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(payload: SetupPayload): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = (await res.json()) as { botName?: string; error?: string }
      if (!res.ok) {
        setError(data.error ?? 'Could not connect the assistant.')
        return
      }
      setBotName(data.botName ?? 'YourBot')
    } catch {
      setError('Could not reach the server. Is the dashboard running?')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative min-h-screen px-6 pb-32 pt-10 sm:px-10 lg:px-16">
      <header>
        <Link href="/" className="font-serif text-lg tracking-tight text-ink">
          OpenInstinct
        </Link>
      </header>

      <main className="mt-24 max-w-2xl sm:mt-32">
        <h1 className="font-serif text-[2.5rem] leading-[1.12] tracking-tight text-ink sm:text-[3.5rem]">
          Initialize your assistant.
        </h1>

        {botName ? (
          <div className="mt-14">
            <p className="font-sans text-lg leading-relaxed text-ink">
              Your assistant <span className="font-medium">@{botName}</span> is live.
            </p>
            <a
              href={`https://t.me/${botName}`}
              className="mt-8 inline-block font-sans text-base text-ink decoration-1 underline-offset-[6px] transition-opacity duration-200 hover:opacity-60"
            >
              Open the chat&nbsp;&rarr;
            </a>
          </div>
        ) : (
          <form
            className="mt-14"
            onSubmit={(e) => {
              e.preventDefault()
              void submit({
                token: token.trim(),
                provider,
                apiKey: apiKey.trim(),
                baseUrl: baseUrl.trim(),
                model: model.trim(),
              })
            }}
          >
            <Field
              id="token"
              label="Telegram Bot Token"
              helper="Create a new bot via @BotFather on Telegram and paste the HTTP API token here."
            >
              <input
                id="token"
                name="token"
                type="password"
                autoComplete="off"
                required
                value={token}
                onChange={(e) => setToken(e.target.value)}
                className={inputClass}
              />
            </Field>

            <Field id="provider" label="Provider">
              <select
                id="provider"
                name="provider"
                value={provider}
                onChange={(e) => setProvider(e.target.value as Provider)}
                className={inputClass}
              >
                {PROVIDERS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              id="apiKey"
              label="API Key"
              helper="Your own key, used only for model calls. It is stored locally on this machine."
            >
              <input
                id="apiKey"
                name="apiKey"
                type="password"
                autoComplete="off"
                required
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className={inputClass}
              />
            </Field>

            {provider === 'custom' && (
              <>
                <Field id="baseUrl" label="Base URL" helper="An OpenAI-compatible endpoint, e.g. http://localhost:11434/v1">
                  <input
                    id="baseUrl"
                    name="baseUrl"
                    type="url"
                    autoComplete="off"
                    required
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    className={inputClass}
                  />
                </Field>
                <Field id="model" label="Model" helper="The model name your endpoint expects.">
                  <input
                    id="model"
                    name="model"
                    type="text"
                    autoComplete="off"
                    required
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    className={inputClass}
                  />
                </Field>
              </>
            )}

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
              {busy ? 'Connecting…' : 'Connect Assistant'}
            </button>
          </form>
        )}
      </main>

      <footer className="absolute bottom-8 left-6 right-6 sm:left-10 lg:left-16">
        <p className="font-sans text-xs text-ink-muted">OpenInstinct | Privacy | Terms</p>
      </footer>
    </div>
  )
}

/** Label, field, helper text — helper text sits with its field, never pooled at the top. */
function Field({
  id,
  label,
  helper,
  children,
}: {
  id: string
  label: string
  helper?: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div className="mb-9">
      <label htmlFor={id} className="block font-sans text-sm font-medium text-ink">
        {label}
      </label>
      <div className="mt-2">{children}</div>
      {helper && <p className="mt-2 font-sans text-sm leading-relaxed text-ink-muted">{helper}</p>}
    </div>
  )
}

/** Flat, borderless-until-focused input: a single rule under the field, no boxed outline. */
const inputClass =
  'w-full border-0 border-b border-ink/25 bg-transparent px-0 py-2 font-sans text-base text-ink placeholder:text-ink-muted ' +
  'focus:border-b focus:border-ink focus:outline-none focus:ring-0'
