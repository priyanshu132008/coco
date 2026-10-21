#!/usr/bin/env python3
"""Shared HitL approval poll — works against the gateway's task ledger.

Two backends: Supabase REST when SUPABASE_URL+SUPABASE_SERVICE_KEY are set (hosted
deploy — Vercel webhook and the Render worker share this ledger), else the local
tasks.db this module grew up with (self-checks, gateway-era local runs).
"""
from __future__ import annotations

import os
import time
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
DB_PATH = os.environ.get("OI_DB_PATH") or os.path.join(str(_ROOT), "telegram_gateway", "tasks.db")
APPROVAL_TIMEOUT = int(os.environ.get("OI_APPROVAL_TIMEOUT", "300"))
CODE_TIMEOUT = int(os.environ.get("OI_CODE_TIMEOUT", "120"))
#: How long the driver waits for a human to solve a Cloudflare challenge and reply 'retry'.
RETRY_TIMEOUT = int(os.environ.get("OI_RETRY_TIMEOUT", "30"))
#: Statuses that mean "the task is still alive" — anything else is a decision or a stop.
ACTIVE_STATUSES = ("running", "booting")


def _db() -> str:
    # env at call time — self-checks set OI_DB_PATH after import
    return os.environ.get("OI_DB_PATH") or DB_PATH


def _remote() -> bool:
    # fresh each call — env may change after import
    try:
        from tools import supabase_client as sbc

        return sbc.enabled()
    except Exception:
        return False


def _sb_status(task_id: int) -> str:
    from tools import supabase_client as sbc

    row = sbc.first("tasks", f"id=eq.{task_id}", select="status")
    return (row or {}).get("status") or "running"


def _sb_row(table: str, task_id: int, col: str, domain: str | None = None):
    """Latest row for the task (domain-filtered when given); None when there is none yet."""
    from tools import supabase_client as sbc

    got = sbc.rows(table, f"task_id=eq.{task_id}&order=id.desc", select=f"task_id,{col}", limit=5)
    for row in got:
        if domain is None or row.get("domain") in (None, "", domain):
            return row.get(col)
    return None


def _active(status: str) -> bool:
    return status in ACTIVE_STATUSES


def wait_approval(task_id: int, timeout: int | None = None, db_path: str | None = None) -> str:
    """Poll the ledger until status leaves 'running' → 'approved' | 'denied' | 'timeout'."""
    timeout = timeout if timeout is not None else APPROVAL_TIMEOUT
    deadline = time.monotonic() + timeout
    if _remote():
        while time.monotonic() < deadline:
            status = _sb_status(task_id)
            if not _active(status):
                return "approved" if status == "approved" else "denied"
            time.sleep(2.0)
        return "timeout"

    import sqlite3

    db_path = db_path or _db()
    conn = sqlite3.connect(db_path)
    try:
        while time.monotonic() < deadline:
            (status,) = conn.execute("SELECT status FROM tasks WHERE id = ?", (task_id,)).fetchone() or ("running",)
            if status not in ACTIVE_STATUSES:
                return "approved" if status == "approved" else "denied"
            time.sleep(2.0)
        return "timeout"
    finally:
        conn.close()


def wait_manual_code(task_id: int, domain: str, timeout: int | None = None, db_path: str | None = None) -> str | None:
    """Poll pending_codes for a 2FA/OTP code relayed via chat; gives up if the task is cancelled."""
    timeout = timeout if timeout is not None else CODE_TIMEOUT
    deadline = time.monotonic() + timeout
    if _remote():
        while time.monotonic() < deadline:
            code = _sb_row("pending_codes", task_id, "code", domain)
            if code:
                return code
            if not _active(_sb_status(task_id)):
                return None  # task cancelled while we waited
            time.sleep(2.0)
        return None

    import sqlite3

    db_path = db_path or _db()
    while time.monotonic() < deadline:
        try:
            with sqlite3.connect(db_path) as conn:
                row = conn.execute(
                    "SELECT code FROM pending_codes WHERE task_id = ? AND (domain IS NULL OR domain = ?) "
                    "ORDER BY rowid DESC LIMIT 1",
                    (task_id, domain),
                ).fetchone()
            if row:
                return row[0]
            (status,) = conn.execute("SELECT status FROM tasks WHERE id = ?", (task_id,)).fetchone() or ("running",)
            if status not in ACTIVE_STATUSES:
                return None  # task cancelled while we waited
        except sqlite3.Error:
            return None  # no ledger (standalone run) — nothing to poll
        time.sleep(2.0)
    return None


def wait_for_location(task_id: int, timeout: int | None = None, db_path: str | None = None) -> str | None:
    """Poll pending_locations for a delivery address relayed via chat; gives up if cancelled."""
    timeout = timeout if timeout is not None else APPROVAL_TIMEOUT
    deadline = time.monotonic() + timeout
    if _remote():
        while time.monotonic() < deadline:
            location = _sb_row("pending_locations", task_id, "location")
            if location:
                return location
            if not _active(_sb_status(task_id)):
                return None
            time.sleep(2.0)
        return None

    import sqlite3

    db_path = db_path or _db()
    while time.monotonic() < deadline:
        try:
            with sqlite3.connect(db_path) as conn:
                row = conn.execute(
                    "SELECT location FROM pending_locations WHERE task_id = ? ORDER BY rowid DESC LIMIT 1",
                    (task_id,),
                ).fetchone()
            if row:
                return row[0]
            (status,) = conn.execute("SELECT status FROM tasks WHERE id = ?", (task_id,)).fetchone() or ("running",)
            if status not in ACTIVE_STATUSES:
                return None
        except sqlite3.Error:
            return None
        time.sleep(2.0)
    return None


def wait_for_retry(task_id: int, timeout: int | None = None, db_path: str | None = None) -> bool:
    """Wait for the human to reply 'retry' after solving a Cloudflare challenge.

    Returns True when a retry was signalled, False on timeout or cancellation.
    """
    timeout = timeout if timeout is not None else RETRY_TIMEOUT
    deadline = time.monotonic() + timeout
    if _remote():
        while time.monotonic() < deadline:
            if _sb_row("retries", task_id, "id") is not None:
                return True
            if not _active(_sb_status(task_id)):
                return False  # task cancelled while we waited
            time.sleep(2.0)
        return False

    import sqlite3

    db_path = db_path or _db()
    while time.monotonic() < deadline:
        try:
            with sqlite3.connect(db_path) as conn:
                row = conn.execute("SELECT id FROM retries WHERE task_id = ? ORDER BY id DESC LIMIT 1", (task_id,)).fetchone()
            if row:
                return True
            (status,) = conn.execute("SELECT status FROM tasks WHERE id = ?", (task_id,)).fetchone() or ("running",)
            if status not in ACTIVE_STATUSES:
                return False  # task cancelled while we waited
        except sqlite3.Error:
            return False  # no ledger (standalone run)
        time.sleep(2.0)
    return False
