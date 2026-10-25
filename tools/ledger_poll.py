#!/usr/bin/env python3
"""Shared HitL approval poll — polls the gateway's local task ledger (tasks.db).

The telegram gateway writes decisions/statuses here; the drivers poll while they wait.
"""
from __future__ import annotations

import os
import sqlite3
import time
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
DB_PATH = os.environ.get("COCO_DB_PATH") or os.path.join(str(_ROOT), "telegram_gateway", "tasks.db")
APPROVAL_TIMEOUT = int(os.environ.get("COCO_APPROVAL_TIMEOUT", "300"))
CODE_TIMEOUT = int(os.environ.get("COCO_CODE_TIMEOUT", "120"))
#: How long the driver waits for a human to solve a Cloudflare challenge and reply 'retry'.
RETRY_TIMEOUT = int(os.environ.get("COCO_RETRY_TIMEOUT", "30"))
#: Statuses that mean "the task is still alive" — anything else is a decision or a stop.
ACTIVE_STATUSES = ("running", "booting")


def _db() -> str:
    return os.environ.get("COCO_DB_PATH") or DB_PATH


def _status(conn: sqlite3.Connection, task_id: int) -> str:
    return (conn.execute("SELECT status FROM tasks WHERE id = ?", (task_id,)).fetchone() or ("running",))[0]


def wait_approval(task_id: int, timeout: int | None = None, db_path: str | None = None) -> str:
    """Poll the ledger until status leaves 'running' → 'approved' | 'denied' | 'timeout'."""
    deadline = time.monotonic() + (timeout if timeout is not None else APPROVAL_TIMEOUT)
    while time.monotonic() < deadline:
        try:
            with sqlite3.connect(db_path or _db()) as conn:
                status = _status(conn, task_id)
        except sqlite3.Error:
            status = "running"  # no ledger yet (standalone run) — keep waiting
        if status not in ACTIVE_STATUSES:
            return "approved" if status == "approved" else "denied"
        time.sleep(2.0)
    return "timeout"


def wait_manual_code(task_id: int, domain: str, timeout: int | None = None, db_path: str | None = None) -> str | None:
    """Poll pending_codes for a 2FA/OTP code relayed via chat; gives up if the task is cancelled."""
    return _poll(
        timeout if timeout is not None else CODE_TIMEOUT,
        db_path,
        lambda conn: conn.execute(
            "SELECT code FROM pending_codes WHERE task_id = ? AND (domain IS NULL OR domain = ?) "
            "ORDER BY rowid DESC LIMIT 1",
            (task_id, domain),
        ).fetchone(),
        task_id,
    )


def wait_for_location(task_id: int, timeout: int | None = None, db_path: str | None = None) -> str | None:
    """Poll pending_locations for a delivery address relayed via chat; gives up if cancelled."""
    return _poll(
        timeout if timeout is not None else APPROVAL_TIMEOUT,
        db_path,
        lambda conn: conn.execute(
            "SELECT location FROM pending_locations WHERE task_id = ? ORDER BY rowid DESC LIMIT 1",
            (task_id,),
        ).fetchone(),
        task_id,
    )


def _poll(timeout: int, db_path: str | None, fetch, task_id: int) -> str | None:
    """One decision loop: a fetched row's first column, else None on cancellation/timeout."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with sqlite3.connect(db_path or _db()) as conn:
                row = fetch(conn)
                active = _status(conn, task_id) in ACTIVE_STATUSES
        except sqlite3.Error:
            return None  # no ledger (standalone run) — nothing to poll
        if row:
            return row[0]
        if not active:
            return None  # task cancelled while we waited
        time.sleep(2.0)
    return None


def wait_for_retry(task_id: int, timeout: int | None = None, db_path: str | None = None) -> bool:
    """Wait for the human to reply 'retry' after solving a Cloudflare challenge.

    Returns True when a retry was signalled, False on timeout or cancellation.
    """
    deadline = time.monotonic() + (timeout if timeout is not None else RETRY_TIMEOUT)
    while time.monotonic() < deadline:
        try:
            with sqlite3.connect(db_path or _db()) as conn:
                if conn.execute("SELECT id FROM retries WHERE task_id = ? ORDER BY id DESC LIMIT 1", (task_id,)).fetchone():
                    return True
                active = _status(conn, task_id) in ACTIVE_STATUSES
        except sqlite3.Error:
            return False  # no ledger (standalone run)
        if not active:
            return False  # task cancelled while we waited
        time.sleep(2.0)
    return False