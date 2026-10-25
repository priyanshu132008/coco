#!/usr/bin/env python3
"""Vault Web UI + local dashboard — the localhost front-end for a single-machine install.

Served on 127.0.0.1:8081. Spawned at boot by telegram_gateway/gateway.js (and
`coco start`). Pages: `/` status dashboard, `/setup` key entry (writes .env,
no file editing needed), `/vault/fill` per-domain credential form. Optional
COCO_VAULT_TOKEN guards the forms.

    ./.venv-bu/bin/python tools/vault_server.py
"""
from __future__ import annotations

import html
import os
import sys
import tempfile
from pathlib import Path

from flask import Flask, request

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from dotenv import load_dotenv, set_key

load_dotenv()
from tools.vault import KINDS, add_creds, add_seed, get_creds, list_domains, _put, _env, _ROOT  # noqa: E402

app = Flask(__name__)
TOKEN = _env("COCO_VAULT_TOKEN")  # when set, the forms must carry matching ?token=
ENV_PATH = _env("COCO_ENV_PATH") or str(_ROOT / ".env")

PAGE = """<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Coco Vault</title><style>
body{{font-family:-apple-system,system-ui,sans-serif;background:#111726;color:#e8ecf4;margin:0}}
.card{{max-width:420px;margin:24px auto;padding:20px;background:#1a2133;border-radius:14px}}
h1{{font-size:1.2rem;margin:0 0 4px}} p.s{{color:#8b93a7;font-size:.85rem;margin:0 0 14px}}
label{{display:block;font-size:.8rem;color:#8b93a7;margin:10px 0 3px}}
input,select{{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #2c3650;background:#111726;color:#e8ecf4;font-size:1rem}}
button{{width:100%;margin-top:16px;padding:12px;border-radius:8px;border:0;background:#4f7cff;color:#fff;font-size:1rem;font-weight:600}}
.row{{display:flex;gap:8px}} .row>div{{flex:1}}
small{{color:#5d6579}}</style></head><body><div class="card">
<h1>🔐 Vault for <code>{domain}</code></h1>
<p class="s">{intro}Each save adds a distinct account for this service; give accounts different names to keep several.</p>
<form method="post" action="/vault/submit">
<input type="hidden" name="domain" value="{domain}">
<input type="hidden" name="token" value="{token}">
<label for="kind">Account type</label>
<select id="kind" name="kind">
  <option value="ecommerce">E-Commerce</option>
  <option value="social">Social Media (X/LinkedIn/IG)</option>
  <option value="google">Google/Email</option>
  <option value="custom" selected>Custom</option>
</select>
<label for="label">Account name (to keep more than one)</label><input id="label" name="label" placeholder="work / personal / dad's account">
<label for="username">Username / email / phone</label><input id="username" name="username" autocomplete="off">
<label for="password">Password</label><input id="password" name="password" type="password">
<label for="totp">TOTP 2FA setup key (optional, base32)</label><input id="totp" name="totp" placeholder="JBSWY3DPEHPK3PXP">
<label for="address">Default address / pincode (optional)</label>
<input id="address" name="address" placeholder="Flat 4B, Powai, Mumbai 400076">
<label for="upi">UPI ID (optional)</label><input id="upi" name="upi" placeholder="name@bank">
<button type="submit">Encrypt &amp; save</button>
<small>Sent fields are Fernet-encrypted at rest; nothing is shown back in plaintext.</small>
</form></div></body></html>"""

OK_PAGE = """<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Saved</title><style>body{{font-family:-apple-system,system-ui,sans-serif;background:#111726;color:#e8ecf4;text-align:center;padding-top:80px}}
code{{background:#1a2133;padding:2px 8px;border-radius:6px}}</style></head><body>
<h1>✅ Encrypted & saved for <code>{domain}</code></h1><p>Fields stored: {stored}</p></body></html>"""


def _authorized() -> bool:
    return not TOKEN or request.args.get("token", request.form.get("token", "")) == TOKEN


#: Keys the setup page manages. COCO_VAULT_KEY is deliberately absent — vault.py generates it.
SETUP_KEYS = (
    ("TELEGRAM_BOT_TOKEN", "Telegram bot token (required — from @BotFather on Telegram)"),
    ("OPENAI_API_KEY", "OpenAI API key (optional — model provider for config.json)"),
    ("ANTHROPIC_API_KEY", "Anthropic API key (optional — model provider)"),
    ("OPENROUTER_API_KEY", "OpenRouter API key (optional — model provider)"),
    ("COCO_PRIVACY_API_KEY", "Privacy.com API key (optional — virtual card checkout)"),
)


def _fmt(html_text: str) -> str:
    return f"<!doctype html><html><head><meta name='viewport' content='width=device-width, initial-scale=1'>\
<title>Coco</title><style>{_STYLE}</style></head><body>{html_text}</body></html>"


_STYLE = """body{font-family:-apple-system,system-ui,sans-serif;background:#111726;color:#e8ecf4;margin:0}
.card{max-width:420px;margin:24px auto;padding:20px;background:#1a2133;border-radius:14px}
h1{font-size:1.2rem;margin:0 0 4px} p.s{color:#8b93a7;font-size:.85rem;margin:0 0 14px}
label{display:block;font-size:.8rem;color:#8b93a7;margin:10px 0 3px}
input,select{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #2c3650;background:#111726;color:#e8ecf4;font-size:1rem}
button{width:100%;margin-top:16px;padding:12px;border-radius:8px;border:0;background:#4f7cff;color:#fff;font-size:1rem;font-weight:600}
.ok{color:#6fd598} .miss{color:#e08181} li{margin:6px 0;font-size:.9rem} a{color:#4f7cff} code{background:#111726;padding:2px 8px;border-radius:6px}"""


@app.route("/")
def dashboard():
    missing = [k for k, _ in SETUP_KEYS if k == "TELEGRAM_BOT_TOKEN" and not os.environ.get(k)]
    load_dotenv(ENV_PATH)
    domains = list_domains()
    rows = "".join(f"<li><code>{html.escape(d)}</code> — TOTP {html.escape(c)}</li>" for d, c in sorted(domains.items())) or "<li>Vault is empty — save credentials from the gateway's /vault/fill links.</li>"
    bot_ok = bool(os.environ.get("TELEGRAM_BOT_TOKEN"))
    setup = f"<p class='miss'>⚙️ {html.escape(missing[0])} missing — <a href='/setup'>enter it at /setup</a> (the bot needs it to come online).</p>" if not bot_ok else "<p class='ok'>✔ Bot token present — gateway polls Telegram.</p>"
    return _fmt(f"""<div class="card">
<h1>⚡ Coco</h1><p class="s">Local dashboard — all state stays on this machine ({html.escape(str(_ROOT))}/vault.db, .env).</p>
{setup}
<h1>🔐 Vault domains</h1><ul>{rows}</ul>
<a href="/vault/fill?domain=">Open the credential form →</a> · <a href="/setup">Key setup →</a>
</div>""")


@app.route("/setup", methods=["GET", "POST"])
def setup():
    saved = {}
    if request.method == "POST":  # persist only the fields actually filled in
        Path(ENV_PATH).touch(exist_ok=True)  # set_key needs the file to exist
        for key, _ in SETUP_KEYS:
            val = (request.form.get(key) or "").strip()
            if val:
                set_key(ENV_PATH, key, val)
                os.environ[key] = val
                saved[key] = True
    load_dotenv(ENV_PATH)
    fields = ""
    for key, desc in SETUP_KEYS:
        have = "✔ stored" if os.environ.get(key) else "not set"
        fields += f"<label for='{key}'>{html.escape(desc)} <small>({have})</small></label><input id='{key}' name='{key}' value=''>"
    saved_note = f"<p class='ok'>✔ Saved: {', '.join(sorted(saved))}</p>" if saved else ""
    return _fmt(f"""<div class="card">
<h1>⚙️ Key setup</h1><p class="s">Written to <code>.env</code> on this machine — never sent anywhere.</p>
{saved_note}
<form method="post" action="/setup">{fields}
<button type="submit">Save keys</button></form>
<p class="s">Restart the gateway after saving a new bot token.</p>
<a href="/">← Dashboard</a>
</div>""")


@app.route("/vault/fill")
def fill_form():
    if not _authorized():
        return "unauthorized", 403
    domain = (request.args.get("domain") or "").strip()
    if not domain:
        return "missing domain", 400
    existing = get_creds(domain)
    intro = f"{len(existing)} fields already stored — refilling updates them. " if existing else ""
    return PAGE.format(domain=html.escape(domain), token=html.escape(request.args.get("token", "")), intro=intro)


@app.route("/vault/submit", methods=["POST"])
def submit():
    if not _authorized():
        return "unauthorized", 403
    domain = (request.form.get("domain") or "").strip().lower()
    if not domain:
        return "missing domain", 400
    label = (request.form.get("label") or "").strip() or "account"
    kind = request.form.get("kind") or "custom"
    if kind not in KINDS:
        kind = "custom"
    fields = {k: (request.form.get(k) or "") for k in ("username", "password", "totp", "address", "upi")}
    _put(domain, label, kind, fields)  # one row per (domain, label) — many accounts per service
    stored = [k for k, v in fields.items() if v.strip()]
    return OK_PAGE.format(domain=html.escape(domain), stored=", ".join(html.escape(s) for s in stored) or "none")


if __name__ == "__main__":
    if os.environ.get("COCO_VAULT_SERVER_CHECK"):  # hermetic round-trip; never touches the real vault
        os.environ["COCO_VAULT_DB"] = tempfile.mktemp(suffix=".db")
        os.environ["COCO_ENV_PATH"] = tempfile.mktemp(suffix=".env")
        add_creds("check.com", {"password": "pw123"})
        assert get_creds("check.com") == {"password": "pw123"}
        print("[vault_ui] round-trip ok", flush=True)
        sys.exit(0)
    # coco start sets this; the launchd gateway spawn does not (no browser from a daemon)
    if os.environ.get("COCO_OPEN_BROWSER"):
        import threading
        import webbrowser

        threading.Timer(1.5, webbrowser.open, ("http://127.0.0.1:8081",)).start()
    app.run(host="127.0.0.1", port=8081, debug=False)  # loopback only — local machine