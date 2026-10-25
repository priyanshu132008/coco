#!/usr/bin/env python3
"""Coco hidden browser execution layer — browser-use agent over CloakBrowser.

CloakBrowser is launched first (persistent profile, binary-level fingerprint stealth),
then browser-use attaches over CDP. Two-phase HitL: the agent pursues the goal but is
instructed to STOP on any payment/checkout/purchase page (report the total) and on
OTP/2FA fields (report the domain). The driver emits gateway events, waits on the
ledger, and on approval issues a single-use Privacy card via sensitive_data to finish.

Runs under .venv-bu (browser-use needs py>=3.11); the legacy SoM/pyautogui
runner stays in the default .venv.

    ./.venv-bu/bin/python tools/browser_driver.py run --goal "..." --task-id 7
    ./.venv-bu/bin/python tools/browser_driver.py --check     # offline self-check
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging as _logging
import os
import random
import re
import signal
import sys
import tempfile
import time
import traceback
from pathlib import Path
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from dotenv import load_dotenv

load_dotenv()

# litellm's INFO chatter propagates to browser-use's root stdout handler — stdout is a JSON
# event channel, keep it clean (the gateway tolerates noise but the phone feed doesn't need it)
_lg = _logging.getLogger("LiteLLM")
_lg.handlers = [_logging.StreamHandler(sys.stderr)]
_lg.propagate = False
_lg.setLevel(_logging.WARNING)

from tools.byok import load_model_config  # noqa: E402
from tools.ledger_poll import (  # noqa: E402
    wait_approval,
    wait_manual_code,
    wait_for_location,
    wait_for_retry,
    CODE_TIMEOUT,
    RETRY_TIMEOUT,
)
from tools.vault import get_address, has_domain, wait_for_domain  # noqa: E402

_ROOT = Path(__file__).resolve().parent.parent
CHECKOUT_URL_RE = re.compile(r"checkout|payment|place[-_ ]?order|confirm[-_ ]?(purchase|order)|billing|cart", re.I)
OTP_STOP_RE = re.compile(r"\bOTP_REQUIRED\b", re.I)
LOCATION_STOP_RE = re.compile(r"\bLOCATION_REQUIRED\b", re.I)
PRICE_SYM_RE = re.compile(r"[$₹]\s?[\d,]+(?:\.\d{1,2})?")
PRICE_WORD_RE = re.compile(r"\b(?:total|pay|price)\b[:\s]*([$₹]?\s?[\d,]+(?:\.\d{1,2})?)", re.I)
LOGIN_INTENT_RE = re.compile(r"log[- ]?in|sign[- ]?in|sign[- ]?up|check\s?out|order\b|buy\b|purchase|cart|pay\b|place an order", re.I)
DOMAIN_RE = re.compile(r"(?:https?://)?(?:www\.)?([a-z0-9-]+\.[a-z]{2,}(?:\.[a-z]{2,})?)", re.I)
#: Persistent browser profile — logged-in sessions survive across tasks (vault check pairs with it).
PROFILE_DIR = os.environ.get("COCO_BROWSER_PROFILE") or str(_ROOT / ".browser_profile")
#: Headless by default; COCO_HEADLESS=0 (or legacy COCO_BU_HEADLESS=0) opens a visible window.
HEADLESS = os.environ.get("COCO_HEADLESS", os.environ.get("COCO_BU_HEADLESS", "1")) != "0"
#: How long to wait for a competing session to release the profile lock before giving up.
LOCK_WAIT_SECONDS = float(os.environ.get("COCO_PROFILE_LOCK_WAIT", "3"))
#: Grace period before a SIGINT'ed run is force-exited (the agent stops at the next step boundary).
SHUTDOWN_GRACE = float(os.environ.get("COCO_SHUTDOWN_GRACE", "8"))
#: How many times the driver tries to click a Cloudflare checkbox before asking the human.
CAPTCHA_ATTEMPTS = int(os.environ.get("COCO_CAPTCHA_ATTEMPTS", "2"))
#: How long to wait for Cloudflare to mint its token after the checkbox click.
CAPTCHA_SETTLE = float(os.environ.get("COCO_CAPTCHA_SETTLE", "3"))
#: Text Cloudflare shows instead of a checkbox — the invisible-interstitial case.
#: Deliberately narrow: a bare "Cloudflare" mention (a footer link) must not read as a
#: challenge, or every ordinary page would trigger a pointless 30s human wait.
BLOCKED_TEXT_RE = re.compile(
    r"verify (?:that )?you are (?:a )?human|checking your browser before"
    r"|just a moment\.\.\.|attention required|enable javascript and cookies to continue"
    r"|error\s*1016|error\s*1020|access denied|ray id",
    re.I,
)
#: Indian context, enforced on every browser init.
INDIAN_TIMEZONE = "Asia/Kolkata"
INDIAN_LOCALE = "en-IN"
MUMBAI_GEO = {"latitude": 19.0760, "longitude": 72.8777, "accuracy": 100}
ACCEPT_LANGUAGE = "en-IN,en-GB;q=0.9,en-US;q=0.8,en;q=0.7"
#: CloakBrowser supplies the endpoint browser-use connects to (strict anti-bot config).
CDP_PORT = int(os.environ.get("COCO_CDP_PORT", "9242"))
CDP_ENDPOINT = f"http://localhost:{CDP_PORT}"
#: CloakBrowser handles webdriver/plugins/Intl-fingerprint spoofing natively at the binary
#: level (and launches with locale/timezone baked in) — only geolocation is left to JS.
GEO_INIT_SCRIPT = """
const _MUMBAI = {latitude: 19.076, longitude: 72.8777, accuracy: 100};
navigator.geolocation.getCurrentPosition = (ok) => ok({coords: Object.assign({}, _MUMBAI), timestamp: Date.now()});
navigator.geolocation.watchPosition = (ok) => { ok({coords: Object.assign({}, _MUMBAI), timestamp: Date.now()}); return 0; };
"""
#: Master residential proxy (Phase 4) — owned by the platform via server env, no user-facing
#: config. Every Playwright navigation routes through it when MASTER_PROXY_SERVER is set.
def master_proxy() -> Optional[dict]:
    server = os.environ.get("MASTER_PROXY_SERVER")
    if not server:
        return None
    proxy = {"server": server}
    if os.environ.get("MASTER_PROXY_USERNAME"):
        proxy["username"] = os.environ["MASTER_PROXY_USERNAME"]
    if os.environ.get("MASTER_PROXY_PASSWORD"):
        proxy["password"] = os.environ["MASTER_PROXY_PASSWORD"]
    return proxy


LOCATION_RULES = (
    "Do NOT assume a fixed delivery city. If an e-commerce platform or delivery app requires a "
    "delivery address/location before showing products or proceeding to checkout, use any address "
    "given in the goal or supplied below. If no address exists and the page blocks progress on an "
    "address/location screen, stop and reply EXACTLY 'LOCATION_REQUIRED' plus the site name — "
    "never invent or pick addresses."
)
#: Pinned to every task prompt (main + gate-round resume agents) so the LLM reaches for the
#: custom vault tool instead of guessing into modals it has no data for.
CUSTOM_TOOL_RULE = (
    "\n\nCRITICAL RULE: If the website displays a modal, pop-up, or page asking for an "
    "address, delivery location, or login credentials, DO NOT use standard browser typing "
    "tools to guess or fill it. You MUST immediately execute the custom tool "
    "'request_user_address' (for locations). Wait for the tool to return the exact string "
    "from the secure vault, and ONLY THEN type it into the page."
)


def emit(ev: dict) -> None:
    print(json.dumps(ev), flush=True)


def _lock_holder_pid() -> Optional[int]:
    """PID of the live process holding the profile lock, or None if the lock is free/stale.

    Chrome writes SingletonLock as a symlink to '<host>-<pid>'. A dead holder leaves the
    link behind but Chrome reclaims that on its own — only a *running* holder is a conflict.
    """
    link = Path(PROFILE_DIR) / "SingletonLock"
    try:
        target = os.readlink(link)
    except OSError:
        return None  # no lock file at all
    tail = target.rsplit("-", 1)[-1]
    if not tail.isdigit():
        return None
    pid = int(tail)
    try:
        os.kill(pid, 0)  # signal 0 = existence probe, does not signal
    except ProcessLookupError:
        return None  # holder is dead — stale lock, Chrome will reclaim it
    except PermissionError:
        return pid  # alive, owned by another user
    # A zombie (exited, not yet reaped) still answers signal 0 but holds no lock —
    # treat it as free, otherwise we wait out the full timeout for nothing.
    try:
        import psutil

        if psutil.Process(pid).status() == psutil.STATUS_ZOMBIE:
            return None
    except Exception:
        pass
    return pid


async def wait_for_profile_lock(timeout: float = LOCK_WAIT_SECONDS) -> None:
    """Wait for a competing session to release the profile lock.

    Raises RuntimeError if the lock is still held when the timeout expires.
    """
    deadline = time.monotonic() + timeout
    holder = _lock_holder_pid()
    while holder is not None:
        if time.monotonic() >= deadline:
            raise RuntimeError(
                f"Browser profile {PROFILE_DIR} is locked by a running Chrome process (pid {holder}). "
                f"Waited {timeout:g}s for it to exit. Close that browser session and retry."
            )
        print(f"[bu] profile locked by pid {holder}, waiting for it to release...", file=sys.stderr, flush=True)
        # async sleep — a blocking wait would stall the event loop, so the browser that is
        # supposed to release the lock (and our own SIGINT shutdown) could never run
        await asyncio.sleep(0.25)
        holder = _lock_holder_pid()


def extract_price(text: str) -> Optional[str]:
    """Prefer a bare currency amount ("₹1,499.00"); fall back to word-prefixed ("Total: 499")."""
    t = str(text or "")
    m = PRICE_SYM_RE.search(t) or PRICE_WORD_RE.search(t)
    price = m.group(1) if m and m.groups() else m.group(0) if m else None
    return price.replace("\n", " ").strip() if price else None


def target_domain(goal: str) -> Optional[str]:
    """First domain-looking token with a word boundary (file paths like /tmp/oi_fake_cart.html split
    into 'cart.html' — reject matches glued to letters/digits/_/-/./:)."""
    for m in DOMAIN_RE.finditer(str(goal or "")):
        prev = str(goal)[m.start() - 1] if m.start() else " "
        if prev.isalnum() or prev in "_-.:/":
            continue
        return m.group(1).lower()
    return None


def emit_frame(tag: str, data: Optional[bytes], task_id: Optional[int]) -> None:
    """One frame to the feed — used only at OTP / checkout / completion (de-spammed)."""
    if not data:
        return
    png = os.path.join(tempfile.gettempdir(), f"bu_{tag}_{task_id or 'x'}.png")
    with open(png, "wb") as f:
        f.write(data)
    emit({"type": "screenshot", "path": png})


def cloak_launch_args() -> tuple[str, list[str]]:
    """The CloakBrowser binary plus its exact stealth arg set, for browser-use to launch.

    The doc'd launch-then-connect-over-CDP path is unusable on Chrome 145: cloakbrowser
    starts the browser over the debugging pipe, and Chrome dies (SIGTRAP) the moment a
    second client attaches via the port. Launching the same binary and args through
    browser-use keeps one transport (the pipe browser-use already drives) and the full
    binary-level fingerprint patch set. humanize=True is the one cloak-library feature
    this drops — browser-use's own step pacing covers the behavioral layer.
    """
    from cloakbrowser.browser import build_args
    from cloakbrowser.config import IGNORE_DEFAULT_ARGS, persistent_seed_args
    from cloakbrowser.download import ensure_binary

    binary = ensure_binary()
    extra = persistent_seed_args(PROFILE_DIR, True, [
        f"--remote-debugging-port={CDP_PORT}",  # kept for live-debugging the browser
        "--fingerprint-noise=false",  # prevents FingerprintJS tampering detection
        "--fingerprint-windows-font-metrics",  # aligns Linux font metrics to Windows
    ])
    return binary, build_args(
        True, extra, timezone=INDIAN_TIMEZONE, locale=INDIAN_LOCALE, headless=HEADLESS,
    )


async def start_browser_session(session) -> None:
    """Start the CloakBrowser-backed session, waiting out a profile lock held by a live
    Chrome process (same SingletonLock semantics as the legacy Playwright launches)."""
    if session.cdp_url or session.agent_focus_target_id is not None:
        return  # already running — the browser we started holds the lock
    last_error: Optional[BaseException] = None
    for attempt in range(3):
        try:
            await wait_for_profile_lock()
            await session.start()
            await install_indian_stealth(session)
            return
        except Exception as e:
            last_error = e
            if "SingletonLock" not in str(e) and "profile" not in str(e).lower():
                raise
            if _lock_holder_pid() is not None:
                raise  # the holder is still alive — retrying would just stall longer
            print(f"[bu] browser launch failed on profile lock (attempt {attempt + 1}/3): {e}", file=sys.stderr, flush=True)
            await asyncio.sleep(1.0)  # async sleep — a blocking wait would stall the event loop
    raise last_error or RuntimeError("browser launch failed")


async def install_indian_stealth(session) -> None:
    """Geolocation spoof via CDP init script + locale/tz/geo/header CDP overrides.

    CloakBrowser's binary handles webdriver/plugin/Intl fingerprint spoofing and
    launches with en-IN / Asia/Kolkata baked in — only geolocation and the
    Accept-Language header need the CDP pass. Idempotent per target.
    """
    try:
        await session._cdp_add_init_script(GEO_INIT_SCRIPT)
        print("[bu] geo init script installed", file=sys.stderr, flush=True)
    except Exception as e:
        # not fatal — the browser still works, it just reports a system geo
        print(f"[bu] geo init script failed: {e}", file=sys.stderr, flush=True)
    await apply_indian_context(session)


async def apply_indian_context(session) -> None:
    """Locale/timezone/geolocation/headers via CDP, for the browser and the active page.

    This browser-use build drops Playwright's locale/timezone_id/geolocation/
    extra_http_headers context options, so the overrides go through CDP:
    chrome-level (root client) where possible, plus the active page target.
    Idempotent per target — safe to call again when a new tab becomes active.
    """
    try:
        cdp = await session.get_or_create_cdp_session()
        target_id = getattr(cdp, "target_id", None)
        already = getattr(session, "_indian_stealth_targets", None)
        if already and target_id in already:
            return
        overrides = {
            "Network.setExtraHTTPHeaders": {"headers": {"Accept-Language": ACCEPT_LANGUAGE}},
            "Emulation.setLocaleOverride": {"locale": INDIAN_LOCALE},
            "Emulation.setTimezoneOverride": {"timezoneId": INDIAN_TIMEZONE},
            "Emulation.setGeolocationOverride": MUMBAI_GEO,
        }
        for method, params in overrides.items():
            domain, _, attr = method.partition(".")
            send = cdp.cdp_client.send
            await getattr(getattr(send, domain), attr)(
                params=params, session_id=cdp.session_id
            )
        if already is None:
            already = set()
            session._indian_stealth_targets = already
        already.add(target_id)
        print(f"[bu] indian context applied (tz={INDIAN_TIMEZONE}, locale={INDIAN_LOCALE}, geo=mumbai)", file=sys.stderr, flush=True)
    except Exception as e:
        # not fatal — page still works, it just reads as the server's local context
        print(f"[bu] indian context override failed: {e}", file=sys.stderr, flush=True)


#: One round trip: find the Cloudflare widget, its click point, or the challenge text.
#: The Turnstile checkbox lives inside a cross-origin iframe, so it cannot be queried
#: directly — the iframe's own box is measured and its left edge clicked instead.
#: The pattern is taken from BLOCKED_TEXT_RE so the two cannot drift apart.
CAPTCHA_PROBE_JS = """() => {
  const box = (el) => { const r = el.getBoundingClientRect(); return {x: r.x, y: r.y, w: r.width, h: r.height}; };
  const frame = document.querySelector('iframe[src*="challenges.cloudflare.com"]');
  if (frame) { const r = box(frame); if (r.w) return {kind: 'iframe', x: r.x + 30, y: r.y + r.h / 2}; }
  const text = (document.body ? document.body.innerText : '').slice(0, 3000);
  if (!new RegExp(__PATTERN__, 'i').test(text)) return null;
  const cb = document.querySelector('input[type="checkbox"]');
  if (cb) { const r = box(cb); if (r.w) return {kind: 'checkbox', x: r.x + r.w / 2, y: r.y + r.h / 2}; }
  return {kind: 'text', x: 0, y: 0};
}""".replace("__PATTERN__", json.dumps(BLOCKED_TEXT_RE.pattern))


async def probe_captcha(page) -> Optional[dict]:
    """Is there a Cloudflare challenge on this page, and where is it?

    Returns {"kind": "iframe"|"checkbox"|"text", "x": .., "y": ..} in viewport
    coordinates, or None when the page is not blocked.
    """
    try:
        raw = await page.evaluate(CAPTCHA_PROBE_JS)
    except Exception as e:
        print(f"[bu] captcha probe failed: {e}", file=sys.stderr)
        return None
    if not raw:
        return None
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return None


async def solve_captcha(page) -> bool:
    """Click the Cloudflare checkbox with human-like jitter. True if the page cleared.

    A straight click at the exact pixel is what bot detection looks for — the
    pointer should approach the target the way a hand does: an off-target start,
    an eased drift in, and a small random error on the final position.
    """
    target = await probe_captcha(page)
    if not target or target["kind"] == "text":
        return False

    tx = target["x"] + random.uniform(-6, 6)
    ty = target["y"] + random.uniform(-4, 4)
    start_x = max(0.0, tx + random.uniform(-120, 120))
    start_y = max(0.0, ty + random.uniform(-80, 80))

    print(f"[bu] clicking cloudflare {target['kind']} at ({tx:.0f},{ty:.0f})", file=sys.stderr, flush=True)
    mouse = await page.mouse
    await mouse.move(start_x, start_y)
    await asyncio.sleep(random.uniform(0.05, 0.18))
    await mouse.move(tx, ty, steps=random.randint(12, 22))  # eased approach, not a teleport
    await asyncio.sleep(random.uniform(0.04, 0.12))
    # press and release separately — mouse.click() fires them back to back, and the
    # gap between them is one of the timings bot detection looks at
    await mouse.down("left")
    await asyncio.sleep(random.uniform(0.04, 0.14))
    await mouse.up("left")
    await asyncio.sleep(CAPTCHA_SETTLE)  # let Cloudflare mint the token
    return not await probe_captcha(page)


async def handle_captcha(session, domain: str = "unknown", task_id: Optional[int] = None) -> bool:
    """Try to clear a Cloudflare challenge; after the last attempt ask the human.

    Returns True when the page is clear (or there was no challenge to begin with).
    """
    page = await session.get_current_page()
    if not page:
        return True
    for attempt in range(1, CAPTCHA_ATTEMPTS + 1):
        target = await probe_captcha(page)
        if not target:
            return True  # nothing blocking — nothing to do
        print(f"[bu] cloudflare challenge detected ({target['kind']}), attempt {attempt}/{CAPTCHA_ATTEMPTS}", file=sys.stderr, flush=True)
        if target["kind"] == "text":
            # invisible interstitial — Cloudflare checks the browser, no click needed
            await asyncio.sleep(CAPTCHA_SETTLE + 2)
        else:
            try:
                await solve_captcha(page)
            except Exception as e:
                print(f"[bu] captcha solve attempt {attempt} failed: {e}", file=sys.stderr, flush=True)
        # the challenge may have navigated the page — refresh the handle
        page = await session.get_current_page()
        if not page:
            return True
        if not await probe_captcha(page):
            print("[bu] cloudflare challenge cleared", file=sys.stderr, flush=True)
            return True
    # still blocked — hand it to the human
    print("[bu] cloudflare still blocking after auto-solve attempts", file=sys.stderr, flush=True)
    emit({"type": "captcha_required", "task_id": task_id, "domain": domain or "unknown"})
    return False


async def wait_for_captcha_retry(session, domain: str, task_id: Optional[int]) -> bool:
    """Wait for the human to solve the challenge and reply 'retry'.

    The wait ends either on an explicit 'retry' in the chat, or when the timeout
    expires — by then the human has solved it in the visible browser window.
    """
    import asyncio.to_thread

    got_retry = False
    if task_id is not None:
        # the ledger's 'retry' row is the wake-up signal
        got_retry = await asyncio.to_thread(wait_for_retry, task_id)
    if not got_retry:
        await asyncio.sleep(RETRY_TIMEOUT)  # no 'retry' — the human's 30s window
    page = await session.get_current_page()
    if not page:
        return False
    if await probe_captcha(page):
        print("[bu] cloudflare still blocking after the human retry", file=sys.stderr, flush=True)
        return False
    print("[bu] cloudflare challenge cleared by the human", file=sys.stderr, flush=True)
    return True


async def run_browser_task(goal: str, task_id: Optional[int] = None, max_steps: Optional[int] = None) -> int:
    from browser_use import Agent, BrowserProfile, BrowserSession, Controller
    from browser_use.llm.litellm import ChatLiteLLM

    # vault pre-check: tasks that look like they need an account, on a domain we hold no secrets for
    domain = target_domain(goal)
    if task_id and domain and LOGIN_INTENT_RE.search(goal) and not has_domain(domain):
        # one clean JSON line on stdout — the Node relay turns it into the Mini App button
        # (no plaintext links, no exit). Then stay alive: wait_for_domain polls vault.db
        # every 3s for up to COCO_VAULT_WAIT=300s and the task resumes the moment setup lands.
        print(json.dumps({"event": "vault_required", "domain": domain, "type": "credentials"}), flush=True)
        if wait_for_domain(domain):
            emit({"type": "chat", "message": f"Vault setup for {domain} received — continuing."})
        else:
            emit({"type": "chat", "message": f"No vault setup for {domain} within 5 minutes — stopped before login."})
            return 0

    llm = ChatLiteLLM(model=load_model_config())
    # browser-use launches the CloakBrowser binary itself (cloak_launch_args carries the
    # fingerprint-stealth arg set); profile fields beyond that are what the session uses.
    _exec, _args = cloak_launch_args()
    profile = BrowserProfile(
        executable_path=_exec,
        args=_args,
        ignore_default_args=["--enable-automation", "--enable-unsafe-swiftshader"],
        user_data_dir=PROFILE_DIR,  # persistent sessions — survive across tasks
        chromium_sandbox=False,  # --no-sandbox (cloak args also pass it; belt & suspenders)
        headless=HEADLESS,
        proxy=master_proxy(),  # None → direct connection, as before
        highlight_elements=False,  # no bot-y visual overlays
        permissions=["geolocation", "clipboardReadWrite", "notifications"],
        # standard desktop viewport — without it some sites (Swiggy) serve a mobile
        # overlay whose Share-location sheet covers the page and confuses the agent
        viewport={"width": 1280, "height": 720},
    )
    session = BrowserSession(browser_profile=profile)
    install_sigint_handler(session)
    stop_on_pay = False
    captcha_seen = 0  # how many challenges we have already worked around

    last_frame: list[bytes] = []  # freshest frame; post-run captures die with the CDP session

    async def on_step(state, model_output, step: int) -> None:
        nonlocal stop_on_pay
        url = state.url or ""
        fresh_pay = not stop_on_pay and CHECKOUT_URL_RE.search(url)
        if fresh_pay:
            stop_on_pay = True
        try:  # keep the freshest frame around; only emit at gate moments (de-spam)
            data = await session.take_screenshot(format="png")
            last_frame.clear()
            last_frame.append(data)
            if fresh_pay:
                emit_frame("checkout", data, task_id)
        except Exception as e:
            print(f"[bu] step capture failed: {e}", file=sys.stderr)

    async def on_step_start(_agent) -> None:
        """Clear a Cloudflare challenge before the LLM ever sees the blocked page.

        Runs before the browser state is captured, so the model never reads
        "access denied" and gives up — the challenge is gone by then.
        """
        nonlocal captcha_seen
        if stop_on_pay:
            return
        try:
            await apply_indian_context(session)  # idempotent — covers tabs opened mid-task
            page = await session.get_current_page()
            if not page or not await probe_captcha(page):
                return
            captcha_seen += 1
            print(f"[bu] cloudflare challenge before step {captcha_seen}", file=sys.stderr, flush=True)
            if not await handle_captcha(session, domain or "unknown", task_id):
                # still blocked — ask the human and wait for them to solve it
                await wait_for_captcha_retry(session, domain or "unknown", task_id)
        except Exception as e:
            print(f"[bu] captcha check failed: {e}", file=sys.stderr)

    async def should_stop(**_kwargs) -> bool:  # browser-use awaits its stop hook
        return stop_on_pay

    # explicit custom tool: a "Share location" modal leaves no URL clue, so the agent must
    # actively ask instead of stalling. Tool = emit the gate event, block on the vault poll
    # (same wait_for_domain as credentials — the Mini App write lands there), hand the
    # address back so the LLM can type it into the modal.
    controller = Controller()

    @controller.action(
        "Call this tool immediately if the website displays a pop-up or page asking for a "
        "delivery location, address, or pincode."
    )
    async def request_user_address() -> str:
        if not domain:
            return "No target site in this goal — skip entering any location and continue without it."
        addr = get_address(domain)
        if not addr:
            print(json.dumps({"event": "location_required", "domain": domain, "type": "location"}), flush=True)
            await asyncio.to_thread(wait_for_domain, domain)  # thread — a blocking sleep must not stall the CDP loop
            addr = get_address(domain)
            if not addr:
                return "No delivery address was provided in time — skip entering any location and continue the task without it."
        return f"Delivery address received. Type exactly this into the location/address field: {addr}"

    common = dict(
        llm=llm,
        browser_session=session,
        controller=controller,
        register_new_step_callback=on_step,
        register_should_stop_callback=should_stop,
        use_vision=True,
        enable_signal_handler=False,  # we own SIGINT — browser-use's handler only pauses
    )
    _saved_addr = get_address(domain) if domain else None
    addr_line = f"\nSaved delivery address in the vault for {domain}: {_saved_addr} — use it for any address screen." if _saved_addr else ""
    agent = Agent(
        task=(
            f"{goal}{addr_line}\n\n"
            f"{LOCATION_RULES}\n\n"
            "RULES: If the site asks for an OTP/2FA/verification code, STOP immediately: your final "
            "message must be exactly 'OTP_REQUIRED' (plus the site name) — NEVER guess, wait out, "
            "or bypass codes. If the site is missing an OTP field entirely, do NOT mention OTP at "
            "all. If you reach a page for payment, checkout, or confirming a purchase, STOP there — "
            "do NOT enter payment details, do NOT confirm or place the order — report the exact "
            "total price instead. Everything before those points you may complete freely."
            f"{CUSTOM_TOOL_RULE}"
        ),
        **common,
    )
    emit({"type": "chat", "message": f"Browser agent started for: {goal}"})

    # gate loop: each run may stop at an OTP / location / checkout gate; handle it and re-attack
    # the remaining goal with the resolved asset — until a clean finish or a resource runs out
    LAUNCH_TIMEOUT = float(os.environ.get("COCO_LAUNCH_TIMEOUT", "90"))
    for _gate_round in range(4):
        # launch here (not inside agent.run) so a profile-lock collision is retried, not fatal.
        # Strict timeout: with a dead X display (Xvfb crash) Chrome hangs at launch forever —
        # fail the task loudly instead of stalling the worker.
        try:
            await asyncio.wait_for(start_browser_session(session), timeout=LAUNCH_TIMEOUT)
        except asyncio.TimeoutError:
            traceback.print_exc()
            emit({"type": "chat", "message": f"❌ Browser launch timed out after {LAUNCH_TIMEOUT:g}s (no display?). Task stopped."})
            emit({"type": "error", "message": f"browser launch timeout after {LAUNCH_TIMEOUT:g}s"})
            return 1
        except Exception as e:
            print(f"[driver] browser launch failed: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
            emit({"type": "chat", "message": f"❌ Browser could not start: {e}. Task stopped."})
            emit({"type": "error", "message": f"browser launch failed: {e}"})
            return 1
        history = await agent.run(
            max_steps=max_steps or int(os.environ.get("COCO_BU_MAX_STEPS", "25")),
            on_step_start=on_step_start,  # clear Cloudflare before the model sees the page
        )
        result = history.final_result() or ""
        visited = " ".join(u or "" for u in history.urls())
        domain_here = domain or extract_domain_from_urls(visited)

        if task_id is None:
            break  # standalone run — no ledger channels, gates collapse to text

        if OTP_STOP_RE.search(result):
            try:
                emit_frame("otp", await session.take_screenshot(format="png"), task_id)
            except Exception:
                emit_frame("otp", next(iter(last_frame), None), task_id)
            emit({"type": "otp_required", "task_id": task_id, "domain": domain_here or "unknown"})
            code = wait_manual_code(task_id, domain_here or "unknown")
            if not code:
                emit({"type": "chat", "message": "No OTP received in time — gave up on this step."})
                return 0
            emit({"type": "chat", "message": "Code received — resuming."})
            agent = Agent(
                task=(
                    f"An OTP was provided: <otp>. Find the OTP/verification field on the current page, "
                    f"type the code into it and submit. Then continue the original goal below if it is "
                    f"still reachable.\n{goal}\n{LOCATION_RULES}{CUSTOM_TOOL_RULE}"
                ),
                sensitive_data={"otp": code},
                **common,
            )
            continue

        if LOCATION_STOP_RE.search(result):
            try:
                emit_frame("location", await session.take_screenshot(format="png"), task_id)
            except Exception:
                emit_frame("location", next(iter(last_frame), None), task_id)
            emit({"type": "location_required", "task_id": task_id, "domain": domain_here or "unknown"})
            location = wait_for_location(task_id)
            if not location:
                emit({"type": "chat", "message": "No delivery address received in time — stopped there."})
                return 0
            emit({"type": "chat", "message": "Address received — resuming."})
            agent = Agent(
                task=(
                    f"A delivery address was provided: <address>. On the current page, set this "
                    f"delivery address/pincode (type it or select it), confirm, then continue the "
                    f"original goal below.\n{goal}\n{LOCATION_RULES}{CUSTOM_TOOL_RULE}"
                ),
                sensitive_data={"address": location},
                **common,
            )
            continue

        # checkout gate — approval, virtual card, purchase
        price = extract_price(result)
        if not stop_on_pay and CHECKOUT_URL_RE.search(visited):
            stop_on_pay = True
        if not (stop_on_pay or price):
            break  # nothing to gate — the goal finished on its own
        try:
            emit_frame("checkout", await session.take_screenshot(format="png"), task_id)
        except Exception:
            emit_frame("checkout", next(iter(last_frame), None), task_id)
        price = price or "unknown"
        emit({"type": "approval_required", "task_id": task_id, "price": price, "stage": "pre-payment"})
        verdict = wait_approval(task_id)
        print(f"[bu] approval verdict: {verdict}", file=sys.stderr)
        if verdict != "approved":
            emit({"type": "chat", "message": f"Checkout not approved ({verdict}) — stopped before payment, nothing was charged."})
            return 0
        # approved: single-use card capped at price+10%, handed to the agent as sensitive data
        from tools.payment import generate_virtual_card

        if os.environ.get("COCO_FAKE_PRIVACY"):
            card = {"pan": "4111111111111111", "cvv": "123", "exp_month": "09", "exp_year": "2027", "spend_limit": 0}
        else:
            card = generate_virtual_card(price)
        emit({"type": "chat", "message": f"Approved. Issued a virtual card capped at {card['spend_limit']/100:.2f} currency units — completing the purchase."})
        agent = Agent(
            task=(
                "Complete the checkout/purchase on the current page. Type the card details into the "
                "payment fields exactly as given and confirm the order. If the page no longer exists, "
                "re-open the checkout and finish it."
                f"{CUSTOM_TOOL_RULE}"
            ),
            sensitive_data={
                "card_number": card["pan"],
                "cvv": card["cvv"],
                "expiry": f"{card['exp_month']}/{card['exp_year'][-2:]}",
            },
            **common,
        )
        stop_on_pay = False  # paid now — the next round must not re-open the checkout gate

    # A segment that ended without the agent's own done marker means it gave up: consecutive
    # LLM failures (402/rate limit), provider errors, or max steps exhausted. Placed AFTER the
    # segment gates above — they exit via continue and would also read as "unsuccessful" here.
    completed = history.is_successful()
    llm_errors = [str(e) for e in history.errors() if e]
    if completed is not True:
        provider_hit = any(re.search(r"40[129]|rate.?limit|insufficient|quota|credit", e, re.I) for e in llm_errors)
        detail = (
            "LLM provider error (402/rate limit) — consecutive calls failed."
            if provider_hit
            else llm_errors[-1].strip()[:300]
            if llm_errors
            else f"agent stopped without completing the goal ({history.number_of_steps} steps, no final result)"
        )
        try:
            emit_frame("failed", await session.take_screenshot(format="png"), task_id)
        except Exception:
            emit_frame("failed", next(iter(last_frame), None), task_id)
        await session.stop()
        # one failure message — the gateway's 'error' handler renders "❌ Task #N failed: <msg>"
        emit({"type": "error", "message": detail})
        return 3

    try:
        emit_frame("done", await session.take_screenshot(format="png"), task_id)
    except Exception:
        emit_frame("done", next(iter(last_frame), None), task_id)
    await session.stop()
    emit({"type": "chat", "message": f"Done. {str(result)[:1000]}"})
    return 0


def install_sigint_handler(session) -> None:
    """Make SIGINT tear the browser down instead of pausing the agent.

    browser-use installs its own handler that cancels the current step and *pauses* — the
    process then sits there forever holding the profile lock, and the next task's Chrome
    aborts on 'SingletonLock: File exists'. Replace it: on SIGINT stop the session (which
    kills Chrome and releases the lock) and exit with the conventional 130 code.
    """
    def _on_sigint(signum, frame):  # noqa: ARG001
        print("[bu] SIGINT received — stopping browser and exiting", file=sys.stderr, flush=True)
        try:
            asyncio.get_event_loop().create_task(_shutdown(session))
        except RuntimeError:
            pass
        # hard-exit after the grace window; the agent's own cleanup may otherwise hang
        signal.alarm(int(SHUTDOWN_GRACE))
        signal.signal(signal.SIGALRM, lambda *_: os._exit(130))

    signal.signal(signal.SIGINT, _on_sigint)


async def _shutdown(session) -> None:
    """Tear the browser down so the profile lock is released promptly."""
    try:
        await session.kill()
    except Exception as e:
        print(f"[bu] session kill failed: {e}", file=sys.stderr, flush=True)
    os._exit(130)


def extract_domain_from_urls(urls: str) -> Optional[str]:
    for u in urls.split():
        d = target_domain(u)
        if d:
            return d
    return None


if __name__ == "__main__":
    p = argparse.ArgumentParser(description="Coco browser-use driver")
    p.add_argument("mode", nargs="?", default=None, help="run = execute a goal")
    p.add_argument("--goal", default=None, help="natural-language goal")
    p.add_argument("--task-id", type=int, default=None, help="ledger task id; enables the HitL gates")
    p.add_argument("--check", action="store_true", help="offline self-check")
    args = p.parse_args()

    if args.check:
        # cloak + indian stealth: strict config must carry every enforced attribute
        assert CDP_PORT == 9242 and CDP_ENDPOINT == "http://localhost:9242"
        assert "19.076" in GEO_INIT_SCRIPT and "72.8777" in GEO_INIT_SCRIPT
        assert INDIAN_TIMEZONE == "Asia/Kolkata" and INDIAN_LOCALE == "en-IN"
        import inspect

        from cloakbrowser.browser import build_args as _ba
        from cloakbrowser.config import IGNORE_DEFAULT_ARGS, persistent_seed_args as _psa
        from cloakbrowser.download import ensure_binary as _eb

        assert callable(_ba) and callable(_psa) and callable(_eb)  # cloak integration intact
        _args_check = _ba(True, _psa(str(_ROOT / ".browser_profile"), True, [
            f"--remote-debugging-port={CDP_PORT}",
            "--fingerprint-noise=false",
            "--fingerprint-windows-font-metrics",
        ]), timezone=INDIAN_TIMEZONE, locale=INDIAN_LOCALE, headless=True)
        assert "--fingerprint-timezone=Asia/Kolkata" in _args_check and "--lang=en-IN" in _args_check, _args_check
        assert any(a.startswith("--fingerprint=") for a in _args_check), _args_check
        assert extract_price("Total: ₹1,499.00") == "₹1,499.00", extract_price("Total: ₹1,499.00")
        assert extract_price("Grand total: $450.00 with tax") == "$450.00", extract_price("Grand total: $450.00 with tax")
        assert extract_price("no money here") is None
        assert CHECKOUT_URL_RE.search("https://amazon.in/checkout/pay")
        assert not CHECKOUT_URL_RE.search("https://amazon.in/s?k=cricket")
        assert target_domain("add a pizza to cart on blinkit.com") == "blinkit.com", target_domain("x")
        assert target_domain("browse flipkart.com for mobiles") == "flipkart.com"
        assert target_domain("no domain here") is None
        # naked host ("blinkit" with no .com) must read as no-domain, never throw
        assert target_domain("Go to blinkit search for amul milk and add to cart") is None
        assert target_domain("open blinkit and shop") is None
        assert target_domain("Open file:///tmp/oi_fake_cart.html and review") is None, target_domain("Open file:///tmp/oi_fake_cart.html")
        assert LOGIN_INTENT_RE.search("buy a cricket bat") and not LOGIN_INTENT_RE.search("find me a recipe")
        # master proxy: off when MASTER_PROXY_SERVER is absent, full dict when present
        _proxy_env = {k: os.environ.pop(k) for k in ("MASTER_PROXY_SERVER", "MASTER_PROXY_USERNAME", "MASTER_PROXY_PASSWORD") if k in os.environ}
        try:
            assert master_proxy() is None, "no env must mean no proxy"
            os.environ["MASTER_PROXY_SERVER"] = "http://proxy.example:22225"
            os.environ["MASTER_PROXY_USERNAME"] = "u"
            os.environ["MASTER_PROXY_PASSWORD"] = "p"
            assert master_proxy() == {"server": "http://proxy.example:22225", "username": "u", "password": "p"}, master_proxy()
        finally:
            for k, v in _proxy_env.items():
                os.environ[k] = v
            for k in ("MASTER_PROXY_SERVER", "MASTER_PROXY_USERNAME", "MASTER_PROXY_PASSWORD"):
                os.environ.pop(k, None)
        assert OTP_STOP_RE.search("OTP_REQUIRED amazon.in"), "marker missed"
        assert not OTP_STOP_RE.search("I found no OTP field on the page") and not OTP_STOP_RE.search("enter the verification code")
        from tools.byok import load_model_config as _lm

        assert _lm(), "config mapping broke"
        # profile-lock logic: free lock, stale lock (dead holder), live holder, and the
        # timeout path — the live-holder case is what used to crash the next Chrome launch
        import tempfile as _tf

        _lockdir = Path(_tf.mkdtemp(prefix="oi-lockcheck-"))
        _old_profile = PROFILE_DIR

        async def _lock_checks():
            globals()["PROFILE_DIR"] = str(_lockdir)
            _link = _lockdir / "SingletonLock"
            assert _lock_holder_pid() is None, "no lock file must read as free"
            _link.symlink_to(f"host-{os.getpid()}")
            assert _lock_holder_pid() == os.getpid(), "live holder must be detected"
            try:
                await wait_for_profile_lock(timeout=0.3)
                raise AssertionError("live holder must raise after the timeout")
            except RuntimeError as e:
                assert "locked by" in str(e), str(e)
            _link.unlink()
            _link.symlink_to("host-999999")  # a pid that cannot be running
            assert _lock_holder_pid() is None, "stale lock must read as free"
            await wait_for_profile_lock(timeout=0.3)  # must return immediately
            # a zombie (exited, unreaped) still answers signal 0 but holds no lock
            import subprocess as _sp

            _z = _sp.Popen(["true"])
            _z.wait()
            _link.unlink()
            _link.symlink_to(f"host-{_z.pid}")
            assert _lock_holder_pid() is None, "zombie holder must read as free"

        try:
            asyncio.run(_lock_checks())
        finally:
            globals()["PROFILE_DIR"] = _old_profile
            import shutil as _sh

            _sh.rmtree(_lockdir, ignore_errors=True)

        # captcha detection: the probe must find the widget, the challenge text and
        # the plain page — a false negative means the agent reads "access denied" and quits
        async def _captcha_checks():
            class _FakePage:
                """Stands in for a browser page: the same DOM the probe JS sees."""

                def __init__(self, iframes=(), checkboxes=(), text=""):
                    self._iframes = iframes
                    self._checkboxes = checkboxes
                    self._text = text

                async def evaluate(self, js, *args):
                    # mirrors CAPTCHA_PROBE_JS: iframe → challenge text → checkbox
                    for b in self._iframes:
                        if b["width"]:
                            return json.dumps({"kind": "iframe", "x": b["x"] + 30, "y": b["y"] + b["height"] / 2})
                    if not BLOCKED_TEXT_RE.search(self._text):
                        return ""
                    for b in self._checkboxes:
                        if b["width"]:
                            return json.dumps(
                                {"kind": "checkbox", "x": b["x"] + b["width"] / 2, "y": b["y"] + b["height"] / 2}
                            )
                    return json.dumps({"kind": "text", "x": 0, "y": 0})

            # a normal page — no challenge
            assert await probe_captcha(_FakePage(text="Add a pizza to your cart")) is None, "clean page must not look blocked"
            # the Turnstile iframe — the click point is its left edge
            tgt = await probe_captcha(_FakePage(iframes=[{"x": 100, "y": 200, "width": 300, "height": 65}]))
            assert tgt and tgt["kind"] == "iframe", tgt
            assert tgt["x"] == 130 and tgt["y"] == 232.5, tgt
            # an inline checkbox
            tgt = await probe_captcha(
                _FakePage(checkboxes=[{"x": 10, "y": 20, "width": 20, "height": 20}], text="Verify you are human")
            )
            assert tgt and tgt["kind"] == "checkbox" and tgt["x"] == 20, tgt
            # the invisible interstitial — challenge text, nothing to click
            tgt = await probe_captcha(_FakePage(text="Checking your browser before accessing blinkit.com"))
            assert tgt and tgt["kind"] == "text", tgt
            # the challenge text must match the real Cloudflare copy
            assert BLOCKED_TEXT_RE.search("Verify you are human")
            assert BLOCKED_TEXT_RE.search("Checking your browser before accessing")
            assert BLOCKED_TEXT_RE.search("Access denied")
            assert not BLOCKED_TEXT_RE.search("Add a pizza to your cart"), "clean page text must not match"
            # a footer mention of Cloudflare is not a challenge — false positives cost a
            # pointless 30s human wait on every ordinary page
            assert not BLOCKED_TEXT_RE.search("Protected by Cloudflare. Privacy policy.")
            # the JS probe carries the same pattern (JSON-encoded in the source)
            assert json.dumps(BLOCKED_TEXT_RE.pattern) in CAPTCHA_PROBE_JS, "probe JS and python regex drifted"

        asyncio.run(_captcha_checks())
        print("[bu] self-check ok — price/checkout/otp/domain/vault-regex + config + profile-lock + captcha", file=sys.stderr)
        sys.exit(0)
    if args.mode == "run" and args.goal:
        try:
            sys.exit(asyncio.run(run_browser_task(args.goal, args.task_id)))
        except KeyboardInterrupt:  # gateway /stop sends SIGINT — exit like the legacy runner
            sys.exit(130)
        except Exception as e:
            # surface the failure: traceback on stderr (lands in gateway.log), short reason on
            # stdout as an 'error' event so the gateway can echo it back to the chat
            print(f"[bu] FATAL: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
            traceback.print_exc()
            emit({"type": "error", "task_id": args.task_id, "message": f"{type(e).__name__}: {e}"})
            sys.exit(1)
    if not args.goal:
        print(json.dumps({"error": "provide --goal and mode run"}))
        sys.exit(2)