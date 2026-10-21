#!/usr/bin/env python3
"""Vault Web UI — mobile form to fill a domain's credentials/cards/UPI into the encrypted vault.

Served on :8081. Spawned at boot by telegram_gateway/gateway.js; the /vault/fill links the
gateway sends when it detects vault_required point here. Optional OI_VAULT_TOKEN guards access.

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
from dotenv import load_dotenv

load_dotenv()
from tools.vault import KINDS, add_creds, add_seed, get_creds, _put  # noqa: E402

app = Flask(__name__)
TOKEN = os.environ.get("OI_VAULT_TOKEN")  # when set, /vault/fill must carry matching ?token=

PAGE = """<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenInstinct Vault</title><style>
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
    if os.environ.get("OI_VAULT_SERVER_CHECK"):  # hermetic round-trip; never touches the real vault
        os.environ["OI_VAULT_DB"] = tempfile.mktemp(suffix=".db")
        os.environ["OI_ENV_PATH"] = tempfile.mktemp(suffix=".env")
        add_creds("check.com", {"password": "pw123"})
        assert get_creds("check.com") == {"password": "pw123"}
        print("[vault_ui] round-trip ok", flush=True)
        sys.exit(0)
    app.run(host="127.0.0.1", port=8081, debug=False)  # loopback only — local machine