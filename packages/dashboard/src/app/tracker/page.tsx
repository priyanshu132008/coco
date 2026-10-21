'use client'

import { useEffect, useRef, useState } from 'react'

interface Box {
  x: number
  y: number
  width: number
  height: number
  label?: string
}

interface Frame {
  ts: number
  step: number
  screenshot: string
  action: string | null
  confidence: number
  box: Box | null
  status: 'running' | 'paused'
  viewport?: { w: number; h: number }
}

interface FeedLine {
  ts: number
  text: string
}

/** Real-time tracker: live viewport feed, glowing red target boxes, HITL banner, floating chat prompt bar. */
export default function Page(): React.ReactElement {
  const [frame, setFrame] = useState<Frame | null>(null)
  const [feed, setFeed] = useState<FeedLine[]>([])
  const [hitl, setHitl] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState('')
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    let ws: WebSocket | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let closed = false

    const addFeed = (text: string): void => setFeed((lines) => [{ ts: Date.now(), text }, ...lines].slice(0, 50))

    const connect = (): void => {
      if (closed) return
      ws = new WebSocket('ws://localhost:8080')
      wsRef.current = ws
      ws.onopen = () => setConnected(true)
      ws.onclose = () => {
        setConnected(false)
        if (!closed) timer = setTimeout(connect, 2000) // engine arms on demand — keep knocking
      }
      ws.onmessage = (e) => {
        let msg: (Frame & { type?: string }) | { type: 'hitl'; reason: string } | { type: 'done'; steps: number } | { type: 'error'; error: string }
        try {
          msg = JSON.parse(e.data as string)
        } catch {
          return
        }
        if ('type' in msg && msg.type === 'hitl') {
          setHitl((msg as { reason: string }).reason)
          addFeed(`⏸ HITL: ${(msg as { reason: string }).reason}`)
        } else if ('type' in msg && msg.type === 'done') {
          setBusy(false)
          addFeed(`✅ run finished — ${(msg as { steps: number }).steps} steps`)
        } else if ('type' in msg && msg.type === 'error') {
          setBusy(false)
          addFeed(`❌ ${(msg as { error: string }).error}`)
        } else if ('type' in msg && msg.type === 'frame') {
          const f = msg as Frame
          setFrame(f)
          addFeed(`step ${f.step} → ${f.action ?? 'observe'}${f.confidence ? ` (${(f.confidence * 100).toFixed(0)}%)` : ''}`)
        }
      }
    }

    connect()
    return () => {
      closed = true
      if (timer) clearTimeout(timer)
      ws?.close()
    }
  }, [])

  // HITL clears when the engine resumes and streams fresh running frames
  useEffect(() => {
    if (frame?.status === 'running' && frame.step > 0) setHitl(null)
  }, [frame])

  const send = (type: string): void => wsRef.current?.send(JSON.stringify({ type }))

  const submit = (): void => {
    const prompt = draft.trim()
    if (!prompt || busy) return
    setBusy(true)
    setDraft('')
    setFeed((lines) => [{ ts: Date.now(), text: `🚀 "${prompt}"` }, ...lines].slice(0, 50))
    if (connected && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'RUN_PROMPT', prompt }))
    } else {
      // no engine socket yet — the dashboard server owns the engine manager, POST instead
      void fetch('/api/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt }),
      }).then((r) => r.json()).catch(() => setBusy(false))
    }
  }

  return (
    <main className="mx-auto min-h-screen max-w-5xl bg-[#0b0d10] p-6 pb-28">
      <header className="mb-4 flex items-center gap-3">
        <h1 className="text-xl font-bold text-white">⚡ OpenInstinct Tracker</h1>
        <span className={`h-2.5 w-2.5 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`} />
        <span className="text-sm text-neutral-400">{connected ? 'engine live @ ws://localhost:8080' : 'engine will arm when you send a prompt'}</span>
      </header>

      {hitl && (
        <div className="mb-4 flex items-center justify-between gap-4 rounded-lg border border-amber-400/40 bg-amber-500/10 px-4 py-3">
          <p className="text-sm text-amber-300">{`⏸ ${hitl} — agent paused, take over the 2FA / CAPTCHA / payment in the live window`}</p>
          <div className="flex gap-2">
            <button onClick={() => { setHitl(null); send('resume') }} className="rounded bg-amber-500 px-3 py-1.5 text-sm font-semibold text-black">
              Resume
            </button>
            <button onClick={() => send('pause')} className="rounded border border-amber-400/40 px-3 py-1.5 text-sm text-amber-300">
              Pause
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-[3fr_1fr]">
        <section className="relative overflow-hidden rounded-lg border border-neutral-800 bg-black" style={{ aspectRatio: '16 / 10' }}>
          {frame?.screenshot ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={`data:image/png;base64,${frame.screenshot}`} alt="live agent viewport" className="absolute inset-0 h-full w-full" />
          ) : (
            <div className="absolute inset-0 grid place-items-center px-6 text-center text-sm text-neutral-500">no frames yet — type a prompt below and hit Run</div>
          )}
          {frame?.box && (
            <TargetBox box={frame.box} viewport={frame.viewport ?? { w: 1280, h: 800 }} />
          )}
          {frame && (
            <div className="absolute bottom-2 left-2 rounded bg-black/70 px-2 py-1 text-xs text-neutral-300">
              {`step ${frame.step} · ${frame.action ?? '—'} · ${frame.status}`}
            </div>
          )}
        </section>

        <aside className="max-h-[60vh] overflow-y-auto rounded-lg border border-neutral-800 p-3">
          <h2 className="mb-2 text-sm font-semibold text-neutral-300">Activity</h2>
          <ul className="space-y-1 text-xs text-neutral-400">
            {feed.map((line, i) => (
              <li key={`${line.ts}-${i}`} className="truncate">
                {line.text}
              </li>
            ))}
            {!feed.length && <li className="text-neutral-500">waiting…</li>}
          </ul>
        </aside>
      </div>

      {/* floating chat prompt bar — always interactive while idle; busy is the only disable state */}
      <div className="pointer-events-none fixed bottom-4 left-1/2 z-50 w-[min(92vw,680px)] -translate-x-1/2">
        <form
          onSubmit={(e) => { e.preventDefault(); submit() }}
          className="pointer-events-auto flex items-center gap-2 rounded-full border border-neutral-700 bg-neutral-900/95 px-3 py-2 shadow-2xl backdrop-blur"
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit() } }}
            placeholder="Book a flight from Mumbai to Delhi on EasyMyTrip…"
            className="h-10 min-w-0 flex-1 rounded-full bg-transparent px-3 text-sm text-white placeholder:text-neutral-500 focus:outline-none"
            disabled={busy}
          />
          {busy ? (
            <span className="shrink-0 rounded-full bg-neutral-700 px-4 py-2 text-sm text-neutral-300">running…</span>
          ) : (
            <button
              type="submit"
              disabled={!draft.trim()}
              className="shrink-0 rounded-full bg-rose-600 px-5 py-2 text-sm font-semibold text-white transition hover:bg-rose-500 disabled:opacity-40"
            >
              Run
            </button>
          )}
        </form>
      </div>
    </main>
  )
}

/** Glowing red overlay pinned to the element the model just acted on. */
function TargetBox({ box, viewport }: { box: Box; viewport: { w: number; h: number } }): React.ReactElement {
  return (
    <div
      className="pointer-events-none absolute animate-pulseGlow rounded border-2 border-red-500"
      style={{
        left: `${(box.x / viewport.w) * 100}%`,
        top: `${(box.y / viewport.h) * 100}%`,
        width: `${(box.width / viewport.w) * 100}%`,
        height: `${(box.height / viewport.h) * 100}%`,
      }}
    >
      {box.label && <span className="absolute -top-5 left-0 rounded bg-red-600 px-1 text-[10px] font-bold text-white">{box.label}</span>}
    </div>
  )
}
