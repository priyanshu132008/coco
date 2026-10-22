# OpenInstinct — Progress

## Phase 2 — Telegram Mini App (TMA) Vault

Status: **done** — verified end to end.

### What was built

**Mini App vault page** — `packages/dashboard/src/app/vault/page.tsx`
- Mobile-first, paper/ink theme (`#FAF9F5` / `#111111`), Playfair Display heading, Inter inputs.
- Loads `https://telegram.org/js/telegram-web-app.js` with `strategy="beforeInteractive"`.
- Reads `?domain=` and `?gate=`; the gate picks the fields:
  - `credentials` → username/email/phone + password
  - `location` → delivery address + pincode
  - `card` → card number, CVV, expiry, UPI ID
  - `2fa` → base32 TOTP seed
  - `all` → every field (also the fallback for an unknown gate)
- On submit: POSTs `/api/vault/submit`, then `HapticFeedback.notificationOccurred('success')` and `WebApp.close()`.

**Vault submit API** — `packages/dashboard/src/app/api/vault/submit/route.ts`
- Resolves the gate, keeps only that gate's fields, and hands them to `tools/vault.py`,
  which Fernet-encrypts each column into `vault.db`. Returns `{ success: true }`.

**Vault module changes** — `tools/vault.py`
- New encrypted columns `enc_pan`, `enc_cvv`, `enc_expiry` (added on open, so old vaults keep working).
- `put` subcommand: JSON on stdin → `{domain, fields}` → encrypt → `vault.db`. The bridge
  between the Node dashboard and the Fernet module; only known field names are stored.
- `get_creds` now returns the card fields too.

**Gateway inline buttons** — `telegram_gateway/gateway.js`
- `vault_required` → "🔒 Open Secure Vault" button, gate `credentials`.
- `location_required` → same button, gate `location` (the chat-reply path still works).
- `payment_required` → same button, gate `card`.
- The Mini App URL is `OI_VAULT_URL`, default `http://localhost:3000/vault`.

**Location relay** — `packages/dashboard/src/lib/vault.ts`
- A location submitted through the Mini App is also written to `pending_locations` in the
  gateway ledger, so the driver blocked in `wait_for_location` resumes instead of timing out.
  Uses `node:sqlite` (optional — the chat-reply path works without it).

### Checks

| Check | Result |
|---|---|
| `tools/vault.py` self-check (throwaway db) | ok — keygen, TOTP, multi-account, at-rest crypto, address fallback, cards, remove |
| `src/lib/vault.ts` self-check | ok — gate allowlist, aliases, address join, location relay |
| `src/lib/setup.ts` self-check | ok — unchanged |
| `next build` | ok — `/vault` 4.55 kB, `/api/vault/submit` dynamic |
| `tsc --noEmit` | clean |
| `node --check telegram_gateway/gateway.js` | ok |
| Browser → API → Fernet → `vault.db` | verified — form submit lands as the right account row |
| Gate isolation | verified — a card-gate submit drops a `password` field |
| All 5 gates render their own fields | verified in a real browser |
| Location relay → Python `wait_for_location` | verified — the driver receives the address |
| Strict bans (gradient/shadow/rounded-lg/purple) | none in the vault markup |

### Known gaps

- `payment_required` has no emitter yet — the gateway handles the event, but no runner
  currently raises it. The checkout flow still uses the virtual-card path.
- The location relay matches a waiting task by `goal LIKE %domain%`. A task whose goal does
  not name the domain will not be matched.
- The Mini App is served over plain HTTP on localhost; Telegram needs HTTPS for `web_app`
  buttons to open from a real client.

## Phase 3 — Telegram Webhooks + Phase 4 — Master Proxy (2026-10-21)

### Built
- `packages/dashboard/src/app/api/telegram/webhook/route.ts` — POST receiver: parses
  `message.text`, `/stop|cancel` → SIGINT + ledger rows cancelled, `/start`+`/vault` commands
  answered, any other text → tasks.db row ('booting') → detached `tools/browser_driver.py`
  ('running', pid recorded). Optional `TELEGRAM_WEBHOOK_SECRET` checked against
  `x-telegram-bot-api-secret-token`.
- `packages/dashboard/src/app/api/telegram/webhook/setup/route.ts` — GET registers the webhook
  (`?url=` or `RENDER_EXTERNAL_URL`/`OI_PUBLIC_URL`; `?mode=delete` reverts to polling;
  `secret_token` forwarded when set).
- `packages/dashboard/src/lib/telegram.ts` — shared ledger/tg helpers, mirroring the
  `gateway.js` conventions + `ledger_poll.py`'s `OI_DB_PATH` override.
- `tools/browser_driver.py` — `master_proxy()` reads `MASTER_PROXY_SERVER/USERNAME/PASSWORD`
  from env, injected into `BrowserProfile(proxy=...)`.

### Verified
- `next build` | ok — both routes registered as dynamic (ƒ)
- `tsc --noEmit` | clean
- `browser_driver.py --check` | ok — incl. new master-proxy on/off assertions

### Note
- Ledger access uses Node's built-in `node:sqlite` (zero new deps); on hosted deploys set
  `OI_ROOT`, `OI_DB_PATH` and `OI_RUNNER_PYTHON` when the repo layout differs.

### Phase 3 addendum — stdout relay (2026-10-21)
- `src/lib/telegram.ts`: `spawnRunner` pipes stdout/stderr (still detached + unref'd, so the
  200 OK is never delayed); `streamToChat` parses JSON events in the background and relays:
  `chat` → sendMessage, `screenshot` → sendPhoto (multipart; path or base64 accepted),
  `vault_required`/`location_required`/`payment_required` → inline `web_app` button to /vault.
  `close` → final ledger status (done/cancelled/failed) + notice quoting stderr tail.
- Skipped: `approval_required`/`otp_required` relay — not on the request list; the hosted flow
  can't answer them yet, add when needed.
- Verified: `tsc --noEmit` clean, `next build` ok (both webhook routes dynamic ƒ).

### Vault-wait fix (2026-10-21)
- `tools/browser_driver.py`: no more `localhost:8081` link + instant exit on missing creds.
  Emits `{"type"/"event": "vault_required", task_id, domain}` then polls vault.db every 3s
  (up to OI_VAULT_WAIT=300s) via `vault.wait_for_domain`; setup received → continues, else
  stops before login. Browser isn't up yet at this point, so the blocking poll is safe.
- `tools/vault.py`: added `wait_for_domain` + self-check asserts (present → instant True,
  timeout → False).
- `src/lib/telegram.ts`: relay keys on `ev.type ?? ev.event` — accepts both shapes; the
  `web_app` vault button already fires with the Mini App link on vault_required.
- Verified: vault + browser_driver self-checks ok, tsc clean, next build ok.

### Crash fix — "database is not open" (2026-10-21)
- Bug: `startTask`'s second ledger block closed the FIRST DatabaseSync handle in its
  finally (`db.close()` instead of `db2.close()`) → `ERR_INVALID_STATE` threw right after
  the task booted → webhook answered 500 (Telegram's retry path) while the row/agent were
  fine. Reproduced against a real `next start` + curl, fixed to `db2.close()`, re-verified
  end to end: POST goal → 200 `{ok, task_id}` → row running + pid → wait loop → clean exit
  → ledger `done`, pid cleared. `/stop`, `/vault`, GET probe all 200.
- Note: the route catch now logs + returns the error reason (was silent).
- Test rows removed from tasks.db afterwards.

### JSON gate event + naked-domain lock (2026-10-21)
- Confirmed by grep: no plaintext "No credentials in the vault for" / localhost links remain
  anywhere in `tools/` (screenshot's link came from the pre-fix driver copy the launchd
  daemon ran). Every stdout `print` in `browser_driver.py` is now JSON; debug text → stderr.
- `browser_driver.py` vault gate now emits exactly
  `{"event": "vault_required", "domain": ..., "type": "credentials"}` then runs
  `wait_for_domain` (3s poll, OI_VAULT_WAIT=300s) — verified live.
- Node consumers updated for the new shape: relay `VAULT_GATES["credentials"]` +
  gateway.js accepts `type:"credentials"`.
- Domain extraction: naked hosts ("blinkit" with no .com) read as no-domain, never throw —
  locked with self-check asserts for the exact failing goal phrasing.
- Verified: py_compile, vault + browser_driver self-checks, `node --check` gateway.js,
  tsc clean, next build ok.

### Custom location tool (2026-10-21)
- `tools/browser_driver.py`: new browser-use custom tool `request_user_address` (Controller
  registered locally in `run_browser_task`, wired into every gate-round agent via `common`).
  Description tells the LLM to call it the moment a delivery-location/address/pincode pop-up
  appears. On call: emits `{"event": "location_required", "domain", "type": "location"}`,
  blocks on `wait_for_domain` via `asyncio.to_thread` (thread, so the CDP loop stays live),
  then returns the decrypted `get_address(domain)` for the LLM to type into the modal.
  No address in time → resumes without one instead of stalling.
- The pre-existing URL/RESULT-based location gate stays as the fallback path.
- Verified: driver self-check ok; zero-param async action registers + runs against the
  installed browser-use registry; py_compile ok.

### Tool-priority prompt rule (2026-10-21)
- `tools/browser_driver.py`: added `CUSTOM_TOOL_RULE` (the exact "CRITICAL RULE: ... you MUST
  immediately execute the custom tool 'request_user_address'" directive) and appended it to
  all four task prompts — the main agent and the OTP-resume, location-resume, and card-finish
  gate-round agents — so the LLM always knows the vault tool exists.
- Verified: self-check ok, rule constant + prompt rendering asserted.

### Webhook routing + viewport fixes (2026-10-21)
- `/vault` command now replies with the inline `web_app` button (webhook route); the
  "Address saved" misroute was gateway.js's pendingLocations branch eating leading-slash
  commands — commands no longer match as addresses.
- Relay gate button now carries `?gate=&domain=` so the Mini App opens the right form
  (same contract as gateway.js's vaultKeyboard); `reply_markup` verified against the
  Telegram inline_keyboard/web_app shape.
- `browser_driver.py`: BrowserProfile pins a 1280x720 desktop viewport to stop Swiggy-style
  mobile/location overlays breaking the page render.
- Verified: node --check gateway.js, driver self-check, tsc clean, next build ok.

### Explicit /vault //start short-circuit (2026-10-21)
- Webhook route: literal `text === '/vault' || text === '/start'` guard at the top of the
  handler — before any DB write/spawn — sends the web_app button and returns ok immediately.
- gateway.js: same hole fixed at the root — any leading-slash text stops before the pending
  state and task-spawn logic (/vault → vaultKeyboard button). Screenshot's "/vault booting a
  browser" was the legacy gateway running daemon-side; restart it to pick this up.
- Verified: node --check gateway.js, tsc clean, next build ok.

## 2026-10-22 — commit & push to GitHub
- eb9a0c6: telegram_gateway package.json/package-lock.json added; .gitignore now covers
  local artifacts (dataset.zip, root .wwebjs_cache/, config.json.bak, launchd plist,
  dashboard/.next, tsbuildinfo). Pushed to origin main alongside the already-committed
  Supabase/Render work (0264c32).

## 2026-10-22 — worker as free Web Service
- worker.py: start_health_server() — stdlib http.server thread on 0.0.0.0:$PORT
  (default 10000) serving GET / → 200 {"status":"alive"}; polling loop unchanged
  (main thread). Smoke-tested locally: 200 alive.
- tools/Dockerfile: EXPOSE 10000. render.yaml: type worker→web, plan starter→free,
  healthCheckPath: /. Committed a45b77e and pushed.

## 2026-10-22 — Indian stealth context in browser_driver.py
- STEALTH_ARGS + --lang=en-IN; STEALTH_INIT_SCRIPT now spoofs navigator.language(s),
  IST timezone (getTimezoneOffset -330 + Intl.DateTimeFormat patched), Mumbai geolocation
  (getCurrentPosition/watchPosition), keeping the navigator.webdriver patch.
- apply_indian_context(): per-target CDP overrides (setExtraHTTPHeaders Accept-Language,
  setLocaleOverride, setTimeZoneOverride, setGeolocationOverride), idempotent per target,
  re-applied in on_step_start for mid-task tabs. Profile permissions now grant geolocation.
- Reason: this browser-use build strips Playwright's locale/tz/geo/header context options
  (commented out in its BrowserContextArgs) — CDP + init script is the channel it gives us.
- playwright-stealth skipped: webdriver patch covers it; add the dep only if Cloudflare
  still flags the fingerprint.
- Verified: driver --check green, BrowserProfile accepts the args. Committed & pushed.
