# OpenInstinct — Progress

## 2026-10-23 — E2E test debugging: stalled claim + /stop crash

Status: fixes pushed (`0b3767e`), awaiting worker redeploy to confirm claim resume.

- **/stop crash `Unexpected end of JSON input`** — root cause found and fixed: `lib/telegram.ts::sb()` parsed the JSON of a Supabase PATCH that answers **204 No Content** (no `prefer` body). Guard via `resp.text()` then parse-if-non-empty; covers `stopActiveTasks` and `decideGate`. Task rows themselves were already flipped correctly (task 1 shows `cancelled`) — only the HTTP response 500'd.
- **Worker not claiming**: diagnosed via Render CLI (workspace `Cook's workspace`, service `srv-dbd2cft9fdbs73a9p52g` / openinstinct-1). Verified working: deployed commit is `978b069` (latest), env vars include `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` (pointing at the migrated project) + `OI_VAULT_KEY`, task #2 sits `pending` with `bot_id=1`, and the exact claim SELECT + `bot_for` decrypt ran successfully locally with the worker's own credentials. The only silent path in the loop is the `enabled()` miss — so added explicit diagnostics (`0b3767e`): claim-skip reason print, typed loop errors, and a poll heartbeat logging the oldest pending id every 50 polls. Next deploy's logs will show which branch it actually takes.

## 2026-10-23 — Multi-tenant BYOK routing (dynamic webhooks + per-task keys)

Status: **done** — verified (tsc clean, next build clean, python smoke-test passed), pushed to main.

- Remote schema applied via `supabase db query --file` (no migrations dir; CLI v2.117 has no `db execute`) on the linked project `tqiskhryqvakvmwghlrn`. Verified: `bot_credentials` exists, `tasks.bot_id bigint` exists, unique index `bot_credentials_token_hash_key` present, RLS enabled on `bot_credentials`.

- New Supabase table `bot_credentials`: AES-256-GCM-encrypted `token`/`api_key` (same vault format, OI_VAULT_KEY), plaintext `token_hash` (sha256) for webhook lookup, resolved LiteLLM `model`, optional `api_base`. `tasks` gained `bot_id`.
- Dashboard: new dynamic route `/api/telegram/webhook/[bot_token]` resolves the bot by token hash — no env reads; webhook POST body shared as `lib/webhook.ts::handleUpdate(chatId, text, botToken, botId, origin)`. Platform route now delegates to it (env token still works, and attaches bot_id when that bot is registered).
- `/api/setup`: when Supabase is configured it now upserts into `bot_credentials` (encryption at rest, upsert on token_hash) and registers `setWebhook` on the per-bot URL. Without Supabase the old local `.env` path still runs.
- Worker (`tools/worker.py`): claims tasks with `bot_id`, loads + decrypts the bot row, injects `OI_MODEL` + the right provider key env (`OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` + `OPENAI_API_BASE`) into the runner, and relays through that bot's token (`worker_tg.*` now takes a token param; env token = fallback). Platform `TELEGRAM_BOT_TOKEN` env is no longer required for claiming.
- `tools/byok.py`: `OI_MODEL` env override above config.json.
- Before E2E test: run the new commands in `supabase/schema.sql` (create `bot_credentials`, add `tasks.bot_id`) in the Supabase SQL editor; `OI_VAULT_KEY` must be set on both Vercel and Render (already is for the vault).
- Follow-up fix `d3ee882`: `/api/setup` hit `EROFS: read-only file system, open '/var/task/.env'` on Vercel — the local-.env fallback fired when Supabase env wasn't visible to the store check. Removed the file-write path entirely (`mergeEnv`/`applySetup` deleted from lib/setup.ts); the route now saves to `bot_credentials` exclusively and surfaces a clear error if Supabase env is missing.
- Root cause of that EROFS `2da3648`: env-name mismatch — Vercel had `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`, code read `SUPABASE_URL` + `SUPABASE_SERVICE_KEY`. All Supabase env reads now go through an alias resolver accepting both names (`lib/supabase.ts` in Node, `supabase_client.url()/key()` in Python; app-era names win when both are set). Verified: python alias check passed, tsc + next build clean, pushed to main.
- OI_VAULT_KEY `74eb6ec`: did NOT generate a new key — one already existed in `.env` (Fernet format, base64 of 32 bytes). A fresh "32-char alphanumeric" would decode to 24 bytes (aesEncrypt rejects it) and orphan existing vault ciphertext. Instead verified the existing key cross-language (node→py and py→node AES-256-GCM roundtrip with a dummy key). Found + fixed a real bug in the process: python's `b64decode` silently drops url-safe (`-`/`_`) chars, so `_aes_key()` was broken on the real key — `altchars=b"-_"` in tools/vault.py. Key copied to Vercel and Render.

## 2026-10-23 — Fix Vercel dashboard build (`Can't resolve '@openinstinct/core'`)

Status: **done** — committed `142c2ba`, pushed to `main`.

- Root cause: `@openinstinct/core` was missing from `packages/dashboard/package.json` dependencies, so Webpack couldn't resolve the workspace package at all.
- Also: `packages/core/dist` is gitignored, so even after resolution Vercel would have failed on the missing `dist/index.js`. Added `prebuild` to dashboard's build script (`npm run build --workspace @openinstinct/core`) so core compiles before `next build`.
- Skipped `transpilePackages` (as originally suggested): core ships prebuilt CJS `dist/`, so no transpiling needed — and it conflicts with the intentional `serverComponentsExternalPackages` config that keeps core's native/stealth chain out of the bundle.
- Verified: wiped `packages/core/dist` locally, ran `npm run build` in packages/dashboard — full clean build passes.

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

## 2026-10-22 — CloakBrowser replaces Playwright Chromium
- tools/browser_driver.py: browser-use launches the cloakbrowser binary directly
  (cloak_launch_args: fingerprint seed file, --fingerprint-noise=false,
  --fingerprint-windows-font-metrics, --remote-debugging-port=9242, --lang=en-IN,
  --fingerprint-timezone=Asia/Kolkata, ignore --enable-automation).
- JS-level navigator.webdriver/plugins/Intl spoofs REMOVED (binary-native now).
  Kept: Mumbai geolocation spoof (GEO_INIT_SCRIPT via CDP) + CDP Indian overrides
  (Accept-Language en-IN header, setLocaleOverride, setTimeZoneOverride, setGeoOverride).
- Key discovery: the doc'd "launch cloak then connect via CDP" crashes Chrome 145
  (SIGTRAP — debugging pipe + ws port can't coexist); same binary+args through
  browser-use's own launch is the stable route. humanize=True dropped (cloak-
  library feature) — browser-use step pacing covers behavior.
- Legacy .browser_profile moved to .browser_profile.legacy (Chrome 145 SIGTRAPs on the
  old-chromium profile; fresh profile will rebuild).
- Dockerfile: Windows-metrics font stack + xvfb + cloak binary baked at build; runs
  headed (OI_HEADLESS=0) on Xvfb.
- Verified: --check ok; real driver run navigated example.com, indian context applied
  (tz/locale/geo), agent completed, no orphan Chrome. Committed & pushed.

## 2026-10-22 — Render deploy unstuck
- Origin main was already in sync (e60f9c1 included cd18dbd's code); Render just hadn't
  picked it up. Pushed 15acef6 (comment marker in worker.py + Dockerfile) to force a
  redeploy. Health server verified present: worker.py start_health_server() on $PORT.

## 2026-10-22 — health port bound first on boot
- worker.py: start_health_server() is now the first line of __main__ (was after env
  checks — a missing env var exited(2) within a second and Render timed out the port
  scan). Missing env now warns and idles (claims nothing) instead of exiting, so the
  deploy goes green and the misconfig is visible in Render logs.
- Idempotent binding via _HEALTH_SET; smoke-tested: / → 200 {"status":"alive"}, process
  alive through idle poll cycles. Committed a5ec2fe, pushed.

## 2026-10-22 — Supabase schema applied (not committed, per instruction)
- Render deploy went live (0cbb669). 401 → fixed by raw apikey (c1cf16a); then PGRST205
  = schema never applied. Applied supabase/schema.sql via supabase CLI (db query --linked,
  project tqiskhryqvakvmwghlrn); 5 tables verified (tasks/pending_codes/pending_locations/
  retries/accounts), tasks queryable (0 rows). Worker loop errors should self-clear.
