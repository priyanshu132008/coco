#!/usr/bin/env python3
"""Encrypted vault — TOTP seeds, account credentials, addresses; Fernet at rest.

Canonical store: the `accounts` table — MULTIPLE accounts per domain, each with
label/kind (ecommerce/social/google/custom), username, password, totp seed,
delivery address and UPI — every sensitive column Fernet-encrypted separately.
Legacy totp_seeds / vault_creds tables (pre-accounts, 10-20) are migrated in
once and kept as read-only leftovers.

Key management: OI_VAULT_KEY in the env file (Fernet, url-safe base64). First run
generates and appends; later runs reuse. Plaintext never touches disk.

Self-check (throwaway paths, no side effects):
    ./.venv/bin/python tools/vault.py
"""
from __future__ import annotations

import base64
import os
import sqlite3
import sys
import time
from pathlib import Path
from typing import Optional

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from dotenv import load_dotenv, set_key

import sys as _sys  # noqa: E402

if str(Path(__file__).resolve().parent.parent) not in _sys.path:
    _sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tools import supabase_client as sbc  # noqa: E402  (script runs need the repo root on the path)

_ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = os.environ.get("OI_ENV_PATH") or str(_ROOT / ".env")
DB_PATH = os.environ.get("OI_VAULT_DB") or str(_ROOT / "vault.db")

KINDS = ("ecommerce", "social", "google", "custom")
ENC_COLS = ("enc_username", "enc_password", "enc_totp", "enc_address", "enc_upi",
            "enc_pan", "enc_cvv", "enc_expiry")
FIELD_COLS = {"username": "enc_username", "password": "enc_password", "totp": "enc_totp",
              "address": "enc_address", "upi": "enc_upi",
              "pan": "enc_pan", "cvv": "enc_cvv", "expiry": "enc_expiry"}


def _db() -> str:
    # lazy — self-checks point OI_VAULT_DB at throwaway files after import
    return os.environ.get("OI_VAULT_DB") or DB_PATH


def _get_key() -> bytes:
    """Env key → reuse; missing → generate once and persist (OI_VAULT_KEY). Envs read lazily."""
    env_path = os.environ.get("OI_ENV_PATH") or ENV_PATH
    load_dotenv(env_path)
    key = os.environ.get("OI_VAULT_KEY")
    if not key:
        key = Fernet.generate_key().decode()
        set_key(env_path, "OI_VAULT_KEY", key)  # creates/updates the env file atomically
        os.environ["OI_VAULT_KEY"] = key
        print(f"[vault] generated new encryption key → {env_path}", flush=True)
    return key.encode()


def _fernet() -> Fernet:
    return Fernet(_get_key())


# ---- two ciphertext formats share one key (OI_VAULT_KEY, base64 of 32 bytes) ---------------
# local vault.db rows are Fernet; Supabase rows are AES-256-GCM (nonce||ct+tag, base64 —
# encrypted by the dashboard/Mini App with node:crypto, no crypto SDK on Vercel). Readers
# accept both, so a local key change never breaks older rows and TS↔Py stays compatible.
def _aes_key() -> bytes:
    return base64.b64decode(_get_key())


def _decrypt_aesgcm(blob: str) -> str:
    raw = base64.b64decode(blob)
    return AESGCM(_aes_key()).decrypt(raw[:12], raw[12:], None).decode()


def _encrypt_aesgcm(value: str) -> str:
    nonce = os.urandom(12)
    return base64.b64encode(nonce + AESGCM(_aes_key()).encrypt(nonce, value.encode(), None)).decode()


def _decrypt(blob: str) -> Optional[str]:
    """Decrypt either format; a wrong/changed key reads as a message, never a crash."""
    for attempt in (_fernet_decrypt, _decrypt_aesgcm):
        try:
            return attempt(blob)
        except Exception:
            continue
    print(f"[vault] decryption failed — OI_VAULT_KEY changed since storage", flush=True)
    return None


def _fernet_decrypt(blob: str) -> str:
    return _fernet().decrypt(blob.encode()).decode()


def _migrate_legacy(conn: sqlite3.Connection) -> None:
    """One-time import of the legacy seed/creds tables into accounts (10-20 era)."""
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    for legacy in ("totp_seeds", "vault_creds"):
        if legacy not in tables:
            continue
        if legacy == "totp_seeds":
            rows = conn.execute("SELECT domain, encrypted_seed FROM totp_seeds").fetchall()
            for domain, blob in rows:
                if not conn.execute("SELECT 1 FROM accounts WHERE domain=? AND enc_totp IS NOT NULL", (domain,)).fetchone():
                    conn.execute(
                        "INSERT INTO accounts (domain, label, kind, enc_totp, is_default) VALUES (?, '(imported)', 'custom', ?, 1)",
                        (domain, blob),
                    )
        else:
            rows = conn.execute(
                "SELECT domain, enc_username, enc_password, enc_upi FROM vault_creds"
            ).fetchall()
            for domain, enc_user, enc_pass, enc_upi in rows:
                if not conn.execute("SELECT 1 FROM accounts WHERE domain=?", (domain,)).fetchone():
                    conn.execute(
                        "INSERT INTO accounts (domain, label, kind, enc_username, enc_password, enc_upi, is_default) "
                        "VALUES (?, '(imported)', 'custom', ?, ?, ?, 1)",
                        (domain, enc_user, enc_pass, enc_upi),
                    )


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(_db())
    conn.execute(
        "CREATE TABLE IF NOT EXISTS accounts ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "domain TEXT NOT NULL, label TEXT NOT NULL DEFAULT 'account', kind TEXT NOT NULL DEFAULT 'custom',"
        "enc_username TEXT, enc_password TEXT, enc_totp TEXT, enc_address TEXT, enc_upi TEXT,"
        "enc_pan TEXT, enc_cvv TEXT, enc_expiry TEXT,"
        "is_default INTEGER NOT NULL DEFAULT 1, created_at DATETIME)"
    )
    # an accounts table created before the card columns existed — add them
    have = {r[1] for r in conn.execute("PRAGMA table_info(accounts)")}
    for col in ("enc_pan", "enc_cvv", "enc_expiry"):
        if col not in have:
            conn.execute(f"ALTER TABLE accounts ADD COLUMN {col} TEXT")
    _migrate_legacy(conn)
    return conn


def _put(domain: str, label: str, kind: str, fields: dict[str, str], is_default: int = 1) -> int:
    """Encrypt and upsert an account row (label = one account within a domain)."""
    values = {FIELD_COLS[k]: v.strip() for k, v in fields.items() if k in FIELD_COLS and v and v.strip()}
    if sbc.enabled():
        enc = {col: _encrypt_aesgcm(v) for col, v in values.items()}
        d = domain.strip().lower()
        existing = sbc.first("accounts", f"domain=eq.{d}&label=eq.{label}", select="id")
        if existing:
            sbc.update("accounts", f"id=eq.{existing['id']}", enc)
            return int(existing["id"])
        if is_default:  # demote a previous default when this one claims default
            sbc.update("accounts", f"domain=eq.{d}&is_default=eq.1", {"is_default": 0})
        row = sbc.insert("accounts", {"domain": d, "label": label.strip() or "account",
                                      "kind": kind or "custom", **enc, "is_default": is_default})
        return int(row["id"]) if row else 0
    enc = {col: _fernet().encrypt(v.encode()).decode() for col, v in values.items()}
    with _conn() as conn:
        row = conn.execute("SELECT id FROM accounts WHERE domain=? AND label=?", (domain, label)).fetchone()
        if row:  # same (domain, label) → update fields
            conn.execute(
                f"UPDATE accounts SET {', '.join(f'{c} = ?' for c in enc)} WHERE id = ?",
                (*enc.values(), row[0]),
            )
        else:  # new account; demote a previous default when this one claims default
            if is_default:
                conn.execute("UPDATE accounts SET is_default = 0 WHERE domain = ? AND is_default = 1", (domain,))
            conn.execute(
                f"INSERT INTO accounts (domain, label, kind, {', '.join(enc)}, is_default, created_at) "
                f"VALUES (?, ?, ?, {', '.join('?' for _ in enc)}, ?, datetime('now'))",
                (domain.strip().lower(), label.strip() or "account", kind or "custom", *enc.values(), is_default),
            )
    return 0


def add_seed(domain: str, seed: str) -> None:
    """TOTP seed (base32) for a domain — merges into the domain's default account."""
    _put(domain.strip().lower(), "account", "custom", {"totp": seed})


def get_code(domain: str) -> Optional[str]:
    """Current 6-digit TOTP code for the domain's seeded account; None if absent/undecryptable."""
    if sbc.enabled():
        row = sbc.first("accounts", f"domain=eq.{domain.strip().lower()}", select="enc_totp")
        blob = (row or {}).get("enc_totp")
    else:
        with _conn() as conn:
            row = conn.execute(
                "SELECT enc_totp FROM accounts WHERE domain = ? AND enc_totp IS NOT NULL "
                "ORDER BY is_default DESC, id DESC LIMIT 1",
                (domain.strip().lower(),),
            ).fetchone()
            blob = row[0] if row else None
    if not blob:
        return None
    import pyotp

    seed = _decrypt(blob)
    if not seed:
        return None
    return pyotp.TOTP(seed).now()


def get_creds(domain: str) -> Optional[dict[str, str]]:
    """Default account's decrypted fields (address/upi included when stored). Plaintext in memory only."""
    cols = "enc_username,enc_password,enc_totp,enc_address,enc_upi,enc_pan,enc_cvv,enc_expiry"
    d = domain.strip().lower()
    if sbc.enabled():
        row = sbc.first("accounts", f"domain=eq.{d}&enc_username=not.is.null", select=cols)
    else:
        with _conn() as conn:
            row = conn.execute(
                f"SELECT {cols} FROM accounts "
                "WHERE domain = ? ORDER BY is_default DESC, id DESC LIMIT 1",
                (d,),
            ).fetchone() or None
            row = list(row) if row else None
    if not row:
        return None
    names = ("username", "password", "totp", "address", "upi", "pan", "cvv", "expiry")
    values = (row.get(c) for c in cols.split(",")) if sbc.enabled() else row
    out: dict[str, str] = {}
    for name, blob in zip(names, values):
        if blob:
            dec = _decrypt(blob)
            if dec:
                out[name] = dec
    return out


def get_address(domain: str) -> Optional[str]:
    """Delivery address for this domain; else any default account's address (universal fallback)."""
    d = domain.strip().lower()
    if sbc.enabled():
        row = sbc.first("accounts", f"domain=eq.{d}&enc_address=not.is.null", select="enc_address") \
            or sbc.first("accounts", "enc_address=not.is.null", select="enc_address")
        blob = (row or {}).get("enc_address")
    else:
        with _conn() as conn:
            row = conn.execute(
                "SELECT enc_address FROM accounts WHERE domain = ? AND enc_address IS NOT NULL LIMIT 1",
                (d,),
            ).fetchone()
            if not row:
                row = conn.execute(
                    "SELECT enc_address FROM accounts WHERE enc_address IS NOT NULL ORDER BY is_default DESC, id DESC LIMIT 1"
                ).fetchone()
            blob = row[0] if row else None
    if not blob:
        return None
    return _decrypt(blob)


def has_domain(domain: str) -> bool:
    """True when the vault holds anything for this domain (seeds or accounts)."""
    d = domain.strip().lower()
    if sbc.enabled():
        return sbc.first("accounts", f"domain=eq.{d}", select="id") is not None
    with _conn() as conn:
        if conn.execute("SELECT 1 FROM accounts WHERE domain = ? LIMIT 1", (d,)).fetchone():
            return True
    return False


#: The Mini App writes into vault.db asynchronously (Telegram webhook → dashboard → here).
#: How long the driver keeps polling for the human's setup instead of dying.
VAULT_WAIT_SECONDS = float(os.environ.get("OI_VAULT_WAIT", "300"))


def wait_for_domain(domain: str, timeout: float = VAULT_WAIT_SECONDS, interval: float = 3.0) -> bool:
    """Poll the vault until this domain exists — the browser process stays alive waiting.

    True when the Mini App stored the account in time; False after `timeout` with nothing.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if has_domain(domain):
            return True
        time.sleep(interval)
    return has_domain(domain)  # one last check after the last sleep


def remove_seed(domain: str) -> bool:
    d = domain.strip().lower()
    if sbc.enabled():
        return len(sbc.rest("DELETE", "accounts", filters=f"domain=eq.{d}")) > 0
    with _conn() as conn:
        cur = conn.execute("DELETE FROM accounts WHERE domain = ?", (d,))
    return cur.rowcount > 0


def list_domains() -> dict[str, str]:
    """Domain → current code (TOTP view for manage_vault; seeds never leave the module)."""
    if sbc.enabled():
        domains = [r["domain"] for r in sbc.rows("accounts", "", select="domain", limit=1000)]
    else:
        with _conn() as conn:
            domains = [r[0] for r in conn.execute("SELECT DISTINCT domain FROM accounts").fetchall()]
    return {d: (get_code(d) or "-") for d in list(dict.fromkeys(domains))}


# ---- legacy-shaped wrapper (vault_server / add-upserts keep the same call shape) -----------
def add_creds(domain: str, fields: dict[str, str]) -> None:
    """Merge credential fields into the domain's default account."""
    d = domain.strip().lower()
    with _conn() as conn:
        if not conn.execute("SELECT 1 FROM accounts WHERE domain=?", (d,)).fetchone():
            conn.execute(
                "INSERT INTO accounts (domain, label, kind, is_default, created_at) VALUES (?, 'account', 'custom', 1, datetime('now'))",
                (d,),
            )
    _put(d, "account", "custom", fields)


if __name__ == "__main__" and len(sys.argv) > 1 and sys.argv[1] == "put":
    # Bridge for the dashboard's Mini App: JSON on stdin → {domain, fields} → encrypt → vault.db.
    # Only FIELD_COLS keys are stored; anything else in the payload is ignored.
    import json
    import sys

    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError as exc:
        print(f"[vault] bad JSON: {exc}", file=sys.stderr, flush=True)
        sys.exit(2)
    domain = str(payload.get("domain") or "").strip()
    if not domain:
        print("[vault] missing domain", file=sys.stderr, flush=True)
        sys.exit(2)
    raw = payload.get("fields") or {}
    fields = {k: str(v) for k, v in raw.items() if k in FIELD_COLS and str(v).strip()}
    if not fields:
        print("[vault] no known fields to store", file=sys.stderr, flush=True)
        sys.exit(2)
    _put(domain.lower(), "account", "custom", fields)
    print(f"[vault] stored {', '.join(sorted(fields))} for {domain.lower()}", flush=True)
    sys.exit(0)

if __name__ == "__main__":
    seed = "JBSWY3DPEHPK3PXP"
    import pyotp

    os.environ["OI_VAULT_DB"] = str(Path(os.environ.get("OI_VAULT_DB", "/tmp")) / "vault_selfcheck.db")
    os.environ["OI_ENV_PATH"] = str(Path(os.environ.get("OI_ENV_PATH", "/tmp")) / "vault_selfcheck.env")  # never touch the real .env/vault on self-check
    DB_PATH = os.environ["OI_VAULT_DB"]
    # the Supabase path is a hosted-only runtime choice — self-check must never touch it
    _removed = {k: os.environ.pop(k) for k in ("SUPABASE_URL", "SUPABASE_SERVICE_KEY") if k in os.environ}
    # the dashboard (Node) encrypts Supabase vault rows as AES-256-GCM nonce||ct+tag with the
    # same OI_VAULT_KEY — this fixed vector proves the TS↔Py contract never drifts
    os.environ["OI_VAULT_KEY"] = "T2RlbjIzNDU2Nzg5MDEyMzQ1Njc4OTBvbmluc3RpbmM="
    assert _decrypt_aesgcm("AAECAwQFBgcICQoL9y2HsHJKjOgpHkvjlqHgrYhvIYJkFQA3H54orcfUjQpEYkc=") == "mini-app-aes-vector", "AES-GCM contract drifted"
    assert _decrypt(_encrypt_aesgcm("roundtrip")) == "roundtrip", "AES roundtrip broke"
    os.environ.pop("OI_VAULT_KEY", None)
    add_seed("example.com", seed)
    code = get_code("example.com")
    assert code == pyotp.TOTP(seed).now(), f"vault code {code} != direct"
    assert len(code or "") == 6 and code.isdigit(), f"code not 6 digits: {code!r}"
    assert get_code("unknown.com") is None, "unknown domain should return None"
    # multi-account-per-domain: two accounts, distinct usernames, default resolution
    add_creds("shop.example.com", {"username": "user@x.io", "password": "hunter2", "address": "221B Baker St, Mumbai 400001", "upi": "user@upi"})
    _put("shop.example.com", "second", "custom", {"username": "second@x.io", "password": "s3cret"})  # 2nd account, claims default
    with sqlite3.connect(_db()) as c:
        raw = c.execute("SELECT enc_password FROM accounts WHERE label = 'second' LIMIT 1").fetchone()
    assert raw and "hunter2" not in raw[0] and "s3cret" not in raw[0], "plaintext leaked at rest"
    creds = get_creds("shop.example.com")
    assert creds["username"] == "second@x.io", f"expected latest default account, got {creds}"
    addr = get_address("unknown-shop.com")  # universal fallback: any account with an address
    assert addr == "221B Baker St, Mumbai 400001", addr
    assert has_domain("shop.example.com") and not has_domain("never-seen.com")
    assert wait_for_domain("shop.example.com", timeout=5.0) is True, "existing domain must break the wait instantly"
    assert wait_for_domain("never-seen.com", timeout=0.2, interval=3.0) is False, "timeout must read as absent"
    assert remove_seed("example.com") and get_code("example.com") is None, "remove failed"
    # card fields: encrypted at rest like everything else, and read back
    add_creds("pay.example.com", {"pan": "4111111111111111", "cvv": "123", "expiry": "09/27"})
    with sqlite3.connect(_db()) as c:
        raw = c.execute("SELECT enc_pan, enc_cvv, enc_expiry FROM accounts WHERE domain='pay.example.com'").fetchone()
    assert raw and "4111111111111111" not in "".join(str(v) for v in raw), "card number leaked at rest"
    card = get_creds("pay.example.com")
    assert card["pan"] == "4111111111111111" and card["cvv"] == "123" and card["expiry"] == "09/27", card
    Path(_db()).unlink(missing_ok=True)
    print("[vault] self-check ok — keygen, TOTP, multi-account, at-rest crypto, address fallback, cards, remove", flush=True)