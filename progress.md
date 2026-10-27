# Coco (was OpenInstinct) — Progress

## 2026-10-23 — Xvfb stale-lock crash on restart + hanging browser launch

Status: **done** — pushed `0407250`.

- Root cause: Render restarted the container in place at 15:35:09Z (no re-clone — same writable layer), so `/tmp/.X99-lock` survived → Xvfb refused display 99 → every browser launch hung forever.
- entrypoint.sh: clears `/tmp/.X99-lock` + `/tmp/.X11-unix/X99` before start (exact paths — not the `.X*` glob, that would delete the `.X11-unix` directory), retries 3× with status prints, and a FATAL marker if the display never comes up.
- browser_driver.py: `start_browser_session` wrapped in `asyncio.wait_for` (`OI_LAUNCH_TIMEOUT`, default 90s) — dead display fails the task loudly (stderr + `error` event → worker relays ❌ to the chat) instead of freezing.

## 2026-10-23 — E2E test debugging: stalled claim + /stop crash

Status: **resolved** — task #2 claimed (`running`, pid 33) after the `0b3767e` worker deploy; model bug fixed in `e0a6c10` (DB row patched remotely).

- **Worker claim stall**: the query was NOT excluding the row — the exact claim SELECT returned `[{"id":2,"bot_id":1}]` when replayed with the worker's own credentials, and as soon as the `0b3767e` worker booted it claimed task #2 within one poll ("alive, poll #50, oldest pending: None" heartbeat confirms the loop is healthy and the ledger is empty of pending). The 2-hour silent stretch on the previous boot is not reproducible from code/env/data — strongest hypothesis is env-var application timing on the Render side; the new diagnostics (claim-skip reason, typed loop errors, 50-poll heartbeat) make any future stall self-describing.
- **Later find while verifying the claim**: `bot_credentials.model` stored the bare `active_model` ("auto") → worker sent `OI_MODEL='auto'` verbatim → ChatLiteLLM would fail with no provider prefix (`byok.py` only prefixes the config.json path). Fixed `resolveModel()` stores/uses the fully-qualified string; patched the existing row to `openrouter/auto` in the remote DB.
- **/stop crash `Unexpected end of JSON input`** — root cause fixed in `0b3767e`: `lib/telegram.ts::sb()` parsed the 204 empty body of a PATCH sent without `return=representation`; now `resp.text()` + parse-if-non-empty. Task rows were already flipped server-side (task 1 shows `cancelled`).

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

## 2026-10-25 — Architectural pivot: local-first CLI (Vercel/Render/Supabase removed)
- Deleted the cloud stack: `packages/dashboard` (Next.js/Vercel app), `render.yaml`,
  `tools/worker.py` + `tools/worker_tg.py` + `tools/Dockerfile` + `tools/entrypoint.sh`
  (Render webhook/poll worker), `supabase/schema.sql`, `tools/supabase_client.py`.
- `tools/vault.py`: Supabase branches and the AES-256-GCM row format (dashboard-era,
  TS-written) removed — local Fernet-only vault.db with OI_VAULT_KEY in .env.
- `tools/ledger_poll.py`: Supabase REST backend removed; polls local tasks.db only
  (drivers untouched — same function signatures).
- Telegram stays long polling (`gateway.js`, grammY getUpdates) — no webhooks/tunnels;
  its vault links now point at the local UI (`http://127.0.0.1:8081/vault/fill`).
- `tools/vault_server.py` is now the local dashboard: `/` status + vault domains,
  `/setup` key entry page (writes .env via dotenv set_key — zero file editing).
- CLI: `openinstinct start` boots the dashboard + gateway; root `package.json` gained
  `bin` so `npm i -g .` puts `openinstinct` on PATH (`dist/openinstinct.js`).
- Checks: vault self-check, ledger.js self-check, vault_server round-trip, ledger_poll
  smoke (code + approval), CLI build, /setup POST writes .env — all green.

## 2026-10-25 — Rebrand: OpenInstinct → Coco + CLI expansion
- Global replace across Python/JS/HTML/Markdown: "OpenInstinct"→"Coco", "openinstinct"→"coco",
  env prefix `OI_`→`COCO_` (`COCO_VAULT_KEY`, `COCO_VAULT_DB`, `COCO_DB_PATH`, `COCO_TELEGRAM_*`,
  `COCO_FAKE_*` …). Package names: root `coco`, `@coco/core`, `@coco/cli`-style naming; lockfile
  regenerated; `build.sh` now emits `dist/coco.js`; launchd plist renamed `com.coco.gateway`
  (kept pointing at the existing repo directory — the absolute path on disk didn't change).
- Legacy-compat: `vault.py` `_env()` and `ledger.js` fall back to the pre-rebrand `OI_VAULT_KEY`/
  `OI_*_PATH` names, so the existing `.env` + `vault.db` stay decryptable (verified against the
  real .env). progress.md history left verbatim — only this entry is new.
- `coco start`: boots dashboard on 127.0.0.1:8081 (auto-opens the browser via vault_server's
  `webbrowser.open`, flag `COCO_OPEN_BROWSER=1` — daemon/launchd spawns never pop windows) and
  the Telegram gateway (long polling).
- `coco configure`: opens http://127.0.0.1:8081/setup (starts the dashboard first if down).
- `coco health` (tools/health.py): .env presence, COCO_VAULT_KEY Fernet validity (never
  auto-regens a live key), PRAGMA integrity_check on vault.db/tasks.db, Telegram + LLM key
  presence — every failure prints a specific fix; exit 1 iff unhealthy. Self-check exercises
  green + corrupt fixtures.
- Checks green: py_compile all tools, tsc core + esbuild CLI build, vault/ledger/vault_server
  self-checks, health self-check, test_totp, node --check gateway.

## 2026-10-25 — Rebrand + CLI completion audit (no fixes needed)
- Verified `dist/coco.js` (bin entry from package.json) routes `start`/`configure`/`health`/`run`/`serve`/help;
  rebuilt it, zero `openinstinct` references in the bundle.
- Global scan for `OpenInstinct`/`openinstinct`/`OI_`: all remaining hits are the deliberate
  legacy-compat env fallbacks (vault.py `_env()`, ledger.js, health.py) + progress.md history —
  UI text (vault_server.py HTML) and schemas are clean; `.next` and `gateway.log` remnants are
  untracked build/log artifacts. Deleted stale untracked `dist/openinstinct.js`.
- Auto-open verified live: `coco configure` spawns tools/vault_server.py on 127.0.0.1:8081
  (webbrowser.open via COCO_OPEN_BROWSER) and serves `/setup` → HTTP 200; `coco start` opens `/`
  the same way, falling back to native `open` if the server was already up. No `open` npm package
  needed — native platform opener + Python webbrowser cover it.
- `coco health` runs green against the live .env/vault.db.

## 2026-10-25 — Restore the Next.js dashboard as the local UI
- Restored packages/dashboard from the pre-deletion commit (e0a6c10) and converted it
  local-first: /api/setup now writes the root .env (TELEGRAM_BOT_TOKEN + provider key,
  custom → OPENAI_API_KEY + OPENAI_API_BASE) and config.json (provider + bare active_model
  for byok.py) via new lib/env.ts + lib/configJson.ts. Deleted the hosted path entirely:
  lib/supabase.ts, lib/telegram.ts, lib/webhook.ts, src/app/api/telegram/* (long polling in
  gateway.js), and lib/vault.ts's Supabase/AES branch (local: tools/vault.py `put` → Fernet
  → vault.db; location relay stays on the tasks.db ledger via node:sqlite).
- Rebranded all pages/layout/metadata OpenInstinct → Coco; workspace renamed @coco/dashboard;
  env names OI_* → COCO_* (COCO_ROOT = data dir, COCO_CODE = install dir — vault.py takes
  COCO_VAULT_DB/COCO_ENV_PATH, translated at the spawn).
- gateway.js: vault button now opens the Next /vault page on :3000 (same ?domain=&gate=
  params); the vault_server.py spawn is gone and tools/vault_server.py deleted.
- CLI (coco start/configure): spawns next dev on :3000 (next resolved from the dashboard's
  or root node_modules; first-run guards for npm install + core build), waits for :3000 to
  answer HTTP (next compiles pages lazily), then opens / or /setup natively.
- Verified live: coco start → :3000 200 (/, /setup, /vault), /api/setup with the real bot
  token validated via getMe and wrote .env+config.json into a sandbox COCO_ROOT (real .env
  untouched), /api/vault/submit round-tripped through vault.db and decrypted back.
- Self-checks green: env/configJson/vault/setup (esbuild+node), tsc clean.

## 2026-10-25 — CLI repo-root resolution through global-bin symlinks
- /opt/homebrew/bin/coco → dirname(argv[1]) resolved ROOT to /opt/homebrew. Now repoRoot():
  COCO_HOME wins, else fs.realpathSync(argv[1]) traces a symlinked binary back to the
  codebase, and a copied global install falls back to process.cwd(). Both candidates must
  contain tools/health.py — otherwise: loud "run from the repo or set COCO_HOME" + exit 1.
- PY, packages/dashboard, telegram_gateway, next bin and core build all derive from ROOT:
  one fix covers every path. Verified via symlink from a foreign cwd (health green, real
  .env found), direct run from the repo (green), and a copied skeleton (fails loudly).

## 2026-10-25 — Gateway lifecycle: .env hot-reload + stale-webhook clearing
- gateway.js watches .env: a TELEGRAM_BOT_TOKEN change (e.g. /api/setup while polling)
  exits(3); `coco start` respawns the gateway on exit code 3 (launchd KeepAlive covers the
  daemon path). The CLI strips inherited TELEGRAM_BOT_TOKEN from the spawn env so dotenv's
  no-override load can't resurrect a stale shell value.
- gateway.js calls deleteWebhook before bot.start(): a token previously deployed on a cloud
  webhook blocks getUpdates until the webhook is dropped.
- Fixed com.coco.gateway.plist still pointing at the old openinstinct/ paths.
- Verified live: coco start → "webhook cleared" + polling; sed-swapping the token in .env
  → ".env changed — restarting" → CLI respawn → polling again; .env restored byte-identical.

## 2026-10-25 — CLI refactor (configure/online/stop) + task-execution hard cap
- Removed `coco start`. `coco configure` = dashboard boot + open /setup; `coco online` =
  gateway + python runners only, prints "Coco is online and listening…"; `coco stop` =
  pkill -f on gateway / tools/browser_driver.py / tools/agent_runner.py / next :3000, plus
  an lsof sweep of :3000 listeners. bin entry unchanged (commands are argv, not bins).
- Task isolation: runners were already detached + unref'd per task (queue never blocks on
  the agent); the real stall was a hung runner with NO cap. gateway.js now arms a hard
  COCO_TASK_TIMEOUT (default 300s) per task: SIGINT → SHUTDOWN_TIMEOUT grace → SIGKILL,
  tasks.db status 'failed', chat notified, per-chat pending (approval/code/location/captcha)
  gate maps cleared so the dead task can't swallow replies. close handler clears the timer.
- Verified live against real traffic: while the gateway ran, the hung #30 ("start"-era
  stuck task) was stopped and superseded by the next message, #33 ran end-to-end (exit 0,
  'done'); coco stop killed the running gateway cleanly. Timeout-kill observation window
  (waiting >5 min on a deliberately hung task) not exercised live — COCO_TASK_TIMEOUT env
  override is the knob for a quick manual check.

## 2026-10-25 — Runner failure propagation (no more green "Done." on agent abort)
- browser_driver.py: after agent.run(), the terminal path now evaluates
  history.is_successful(): only a True verdict reaches the old "Done." + exit 0. An agent
  that gave up (consecutive LLM failures, 402/ratelimit/auth, or max steps with no final
  result) emits the structured 'error' event (gateway renders "❌ Task #N failed: …"),
  marks tasks.db 'failed' via a nonzero exit (3), and saves a "failed" screenshot. Detection
  sits AFTER the OTP/address/checkout gates (those exit via continue) so their endings
  can't be misread as task failures.
- Verified live: garbage OpenRouter key + 2 steps → agent aborts with AuthenticationError
  401 spam → emits error event, exits 3, no "Done."; py_compile + --check self-check green.
  (The success path with a credited LLM key wasn't re-run — 402'd account; the only new
  gate before "Done." is the is_successful() check.)

## 2026-10-25 — Model picker on setup + configure routing
- setup page: "Model Name" input for every provider (was custom-only, so openrouter users
  were locked to 'auto'), with the exact-string helper + placeholder; optional — blank keeps
  the provider default. /api/setup + planSetup store a user-specified model verbatim in
  config.json.active_model; resolveModel (display) passes qualified strings through.
- byok.py: models already written "provider/model" (18 known prefixes) go to LiteLLM
  verbatim — no "openrouter/anthropic/…" → "openrouter/openrouter/anthropic/…" double
  prefixing; bare models keep the provider/ prefix. Added a byok self-check.
- coco configure now opens http://localhost:3000/ (home) — the setup page is linked from it.
- E2E verified on a sandbox COCO_ROOT: form POST with model openrouter/anthropic/claude-3.5-sonnet
  → config.json verbatim → byok resolves the same string → browser_driver's ChatLiteLLM.
  (A zombie next dev briefly hijacked a first test POST and rewrote the real .env/config.json
  with the same values; verified both intact afterwards.)

## 2026-10-25 — Conversational gateway + scroll ban
- gateway.js: messages not claimed by the hard gates (stop, /vault, OTP code, approve/deny,
  address, captcha retry) now go through a router LLM — the user's configured OpenAI-
  compatible model (config.json.active_model → OPENAI_API_BASE) with a `dispatch_browser`
  tool + per-chat in-memory history (~16 msgs sent, 20 kept). Robotic "Task #N received"
  acks are gone; vague goals get natural clarifying questions instead of an instant spawn.
  dispatch_browser fires only on a final self-contained goal → the single-active-task
  handoff + ledger row + spawn moved into dispatchTask(). If the router API is
  unreachable, it falls back to the old direct-spawn behavior with the message as the goal.
- browser_driver.py: SCROLL_RULE pinned to every agent prompt (main + OTP/address resume
  agents): "scroll 3 times without finding your target → STOP SCROLLING, click / search /
  report failure". (Skipped the payment-resume agent — single form page, no scrolling.)
- test_router.js: live 2-turn self-check (vague greeting → chat reply; concrete goal →
  dispatch_browser tool call). Verified green against the configured model.

## 2026-10-25 — Approved-payment path: vault cards + "Should I pay?"
- browser_driver.py: the checkout rule no longer reads as a hard payment ban — the agent
  must STOP at any payment/checkout page and report the total; payment happens only after
  the human approves in chat ("Should I pay?" gateway message, now with that wording).
  New card_for_payment(goal, domain, price): if the goal explicitly asks to use the
  vault/saved card AND a full pan+cvv+expiry is stored for the domain, the payment agent
  enters those vault credentials as sensitive_data; otherwise it still pays with the
  single-use privacy card capped at price+10% (COCO_FAKE_PRIVACY branch unchanged).
- --check extended: vault request w/o stored card → privacy fallback; stored card → vault
  details returned; quiet goal → privacy card. Green.
- Live e2e payments were NOT run in this session (money path) — flagged for a real
  sandbox test before trusting it.

## 2026-10-25 — Router capability prompt: never refuse browser-agent tasks
- gateway.js ROUTER_PROMPT rewritten verbatim per spec: the router is the intelligent
  frontend of a full-power browser agent — logins, emails, forms, purchases, errands are
  all in scope; passwords/cards come from the vault rather than chat. Refusal-by-inability
  removed; missing params get clarified, final goals go straight to dispatch_browser.
- test_router.js: added a capability probe ("send a follow-up email to my bank" → must not
  refuse). Live 3-turn check green: vague → chat, concrete → tool call, email task → accepted.

## 2026-10-25 — Vault button: web_app → inline url
- gateway.js vaultKeyboard: Telegram 400s on web_app buttons unless HTTPS; localhost can
  never be. Swapped to a plain url inline button — the native browser opens
  http://localhost:3000/vault. Works only on the Mac itself; a public/tunneled HTTPS vault
  URL is the real fix for phone use (ponytail note in code).

## 2026-10-25 — coco stop now beats launchd KeepAlive
- Root cause: the gateway runs under launchd (com.openinstinct.gateway, KeepAlive) —
  `pkill -f gateway.js` killed it and launchd respawned it instantly, so `coco stop`
  looked dead (Ctrl-C only worked because `coco online` runs the gateway in foreground).
- fix: stopCommand scans ~/Library/LaunchAgents for any unit running
  telegram_gateway/gateway.js, `launchctl bootout`s it first, then proceeds with the
  pkill sweep as before (count includes the bootout). Live-verified: bootout + pkill →
  3s later nothing running, nothing respawned.
- Note: coco start runs the gateway in the foreground (no launchd) until the next
  reboot/login reloads the plist — same as before, stop is just effective now.

## 2026-10-25 — 409 conflict killed, clean error strings, vault credential tool
- cli: bootoutGatewayLaunchd() — bootout + `launchctl disable` (persists across logins) for
  any LaunchAgents unit running telegram_gateway/gateway.js. Called by both `coco stop`
  and `coco online`, so the foreground gateway is always the only poller → no 409
  "terminated by other getUpdates". `coco start` now aliases `coco online`. Live-verified:
  unit shows 'com.openinstinct.gateway => disabled', nothing respawns.
- browser_driver.py: chat_safe_text — history objects / 'object at 0x' reprs never reach
  Telegram; the failure path and the Done message degrade to the last action's
  failure_reason/extracted_content or a readable fallback. llm_errors also sanitized.
- browser_driver.py: new controller tool request_user_credentials — on a login wall it
  fetches (decrypts) the vault account for the target domain, emits vault_required and
  waits (same wait_for_domain poll as addresses), then hands username+password to the
  agent with strict not-in-chat rules. LOGIN_RULE pinned to the main prompt + both
  resume prompts: always fetch from the vault, never give up on a login wall.
  ponytail: creds exist briefly as plaintext in the tool result (LLM context only) —
  switch to mid-run sensitive_data placeholders when this browser-use build supports it.
- --check extends chat_safe_text (repr → readable fallback, plain strings pass through).
- launchd gateway left bootout+disabled on this Mac — the bot is OFF until the user runs
  `coco online`.

## 2026-10-25 — Vault manager UI + GET route + in-terminal coco stop
- vault.ts: listVault() → `tools/vault.py list` (new CLI bridge: decrypted default-account
  fields per domain, TOTP seeds filtered out); saveToVault refactored onto the same
  vaultHelper round-trip. GET /api/vault returns entries (key stays in the server process,
  only per-entry plaintext reaches the page render; passwords/cvv/pan masked client-side
  with a reveal toggle). vault.py self-check made an elif chain so list/put exit first.
- /vault: without ?domain it's now a manager — tabs Logins / Payments / Addresses listing
  decrypted entries, "update" fills the site field, add/update forms POST the existing
  /api/vault/submit (gate=credentials/card/location). With ?domain (bot button) the
  original gate form is unchanged. Verified live: GET decrypts real vault.db rows, page 200.
- coco stop from the same terminal: `coco online` now watches stdin — typing
  `coco stop`/`stop`/`quit` stops the stack (that's what the screenshot was: the line
  went to the foreground gateway's unread stdin). Real-pty test: stops cleanly, exits,
  nothing respawns.
- NOTE: the launchd gateway is bootout+disabled — coco online is now the only runner.

## 2026-10-25 — 3-minute LLM timeout for slow endpoints
- browser_driver.py: browser-use's Agent enforces llm_timeout with a per-model default of
  75s (agent/service.py _get_model_timeout) — Nemotron 120B on NVIDIA's free endpoint
  exceeds it and the agent aborts with "LLM call timed out after 75 seconds". All agent
  builds (main + OTP/address/payment resumes) now pass llm_timeout=180 via the shared
  `common` dict, overridable with COCO_LLM_TIMEOUT. LiteLLM's own request timeout is
  already 600s (default) — no client change needed. --check green.

## 2026-10-27 — ActionResult.error crash + fuzzy vault domain matching (domain_hint)
- chat_safe_text crashed the gateway: browser-use 0.13.11 renamed ActionResult.failure_reason
  to error, and the pydantic __getattr__ raise killed the whole driver (task 44 exit 1).
  Fixed with getattr(act, 'error', None) fallbacks and a try/except around the history walk —
  no result-shape drift can crash the gateway again. --check gains an assert for both.
- request_user_credentials now takes domain_hint: str (optional in schema, mandated by
  LOGIN_RULE: "MUST provide domain_hint (e.g. 'gmail', 'amazon', 'blinkit')"). Lookup key
  priority: LLM hint → live page host (target_domain of browser_session.get_current_page_url())
  → goal's domain. Fixes: vault entry stored as 'gmail' was never found on
  accounts.google.com (exact-match WHERE domain = ?).
- vault.py: shared _fuzzy_where() — rows match the hint in both directions (hint 'gmail' ↔
  stored 'gmail', host 'mail.google.com' ↔ stored 'google.com'), escaping %/_ in the hint;
  empty hint never matches. get_creds/has_domain (and thus wait_for_domain) use it, with
  exact matches ranked first (ORDER BY (domain = ?) DESC). Self-check covers hint, apex-host,
  unrelated-domain, exact-priority and empty-hint cases. Registered-signature smoke test
  against browser-use 0.13.11 registry: domain_hint in schema, executes fine.
- Note: page host 'accounts.google.com' still cannot match a row literally named 'gmail'
  (no substring relation) — that gap is exactly why LOGIN_RULE forces the LLM to pass the hint.

## 2026-10-27 — 10-min task cap, 50-step budget, bulk DOM extraction rule
- 68-email inbox summary died twice over: gateway COCO_TASK_TIMEOUT default 300->600s
  (telegram_gateway/gateway.js), and browser-use's 25-step default burned out scrolling
  one mail at a time — COCO_BU_MAX_STEPS default 25->50 at agent.run, max_actions_per_step=10
  added to the shared `common` Agent config (applies to main + all gate-round resumes).
- New pinned DATA_EXTRACTION_RULE: bulk data asks must use evaluate/extract to pull the DOM
  in bulk instead of scrolling item by item (verified both actions exist in browser-use
  0.13.11's registry). --check green, gateway node --check green.

## 2026-10-27 — Gmail extraction rule: evaluate beats empty extract retries
- Task 46 logged in fine, then spent 18 steps retrying the built-in extract action on
  Gmail's DOM (empty <result></result> every time) until the 600s cap killed the runner.
  New pinned GMAIL_EXTRACTION_RULE in browser_driver.py: never retry an empty extract —
  switch to evaluate with explicit JS, with a ready-to-run IIFE snippet pulling Gmail's
  tr.zA rows (sender/subject/date/snippet, first 25). Snippet wrapped in an IIFE because
  Runtime.evaluate rejects a bare `return` (illegal statement) — the raw snippet from the
  bug report would not have run. Verified: node --check syntax + stub-DOM execution, and
  one paren bug in the date selector caught by that check. Rule also caps inbox depth:
  summarize the current view's 20-25 latest emails, never paginate 70+ older ones unless
  the user explicitly asked. --check green.

## 2026-10-27 — Agent Reach fast-path integration (YouTube/social read tasks)
- Installed agent-reach 1.6.0 via `uv tool install` from the official GitHub release (NOT the
  PyPI imposter), `agent-reach setup` enabled default channels: github, youtube, bilibili,
  v2ex, web (ffmpeg/bili-cli tool deps auto-installed). `agent-reach channels` clean.
  twitter/reddit/linkedin are known-but-not-added (need `agent-reach add <channel>` +
  login on demand) — the bridge surfaces their CLI error verbatim and falls back to browser.
- tools/agent_reach_tool.py: query_agent_reach(channel, action, target) → subprocess CLI
  call, argv-only (no shell), 120s timeout, 12k output cap, never raises. Parses the 1.6
  JSON envelope: ok → result/items as compact JSON; !ok → error message + hint (missing
  channel, login/add prompts) with explicit "fall back to browser" guidance.
  --check: offline error-path asserts + live YouTube search (verified, returns real items).
- browser_driver.py: query_agent_reach_tool registered as a controller action
  (asyncio.to_thread so the CDP loop never stalls); pinned FAST_PATH_RULE in the main
  prompt (fast-path first for YouTube/Twitter/Reddit/LinkedIn/V2EX/Bilibili reads, browser
  only on failure or interactive actions). gateway.js: same rule condensed into
  ROUTER_PROMPT so the router never refuses platform-read goals. --check green, node --check green.
