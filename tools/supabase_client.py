#!/usr/bin/env python3
"""Shared Supabase access — plain PostgREST over `requests`, no client library.

Configured by SUPABASE_URL + SUPABASE_SERVICE_KEY (service key: full DB access, RLS
bypass — never ship it client-side). When either is missing, the callers (vault.py,
ledger_poll.py, worker.py) fall back to their local-sqlite behaviour so self-checks
and gateway-era local runs keep working.
"""
from __future__ import annotations

import os
from typing import Any, Optional

import requests

_TIMEOUT = 15


def enabled() -> bool:
    """Read fresh each call — self-checks set/unset the env after import."""
    return bool(os.environ.get("SUPABASE_URL") and os.environ.get("SUPABASE_SERVICE_KEY"))


def rest(method: str, table: str, *, filters: str = "", select: str = "", body: Any = None,
         prefer: str = "", limit: int = 0) -> Any:
    """One PostgREST round trip; raises on HTTP errors.

    filters:   raw PostgREST querystring, e.g. "status=eq.pending&order=id.asc"
    select:    column projection ("" = all columns, and on writes return the inserted row
               with &select=id)
    body:      JSON payload for POST/PATCH
    """
    url = f"{os.environ['SUPABASE_URL'].rstrip('/')}/rest/v1/{table}"
    params = []
    if filters:
        params.append(filters)
    if select:
        params.append(f"select={select}")
    if limit:
        params.append(f"limit={limit}")
    headers = {"Content-Type": "application/json"}
    if prefer:
        headers["Prefer"] = prefer
    headers["apikey"] = headers["Authorization"] = f"Bearer {os.environ['SUPABASE_SERVICE_KEY']}"
    resp = requests.request(
        method, url, params="&".join(params) if params else None,
        json=body, headers=headers, timeout=_TIMEOUT,
    )
    resp.raise_for_status()
    if not resp.text:
        return []
    return resp.json()


def rows(table: str, filters: str, select: str = "*", limit: int = 50) -> list[dict]:
    return rest("GET", table, filters=filters, select=select, limit=limit) or []


def first(table: str, filters: str, select: str = "*") -> Optional[dict]:
    got = rows(table, filters, select=select, limit=1)
    return got[0] if got else None


def insert(table: str, payload: dict, *, select: str = "id") -> Optional[dict]:
    """Insert one row (or dict) and return the representation (id by default)."""
    out = rest("POST", table, body=payload, select=select,
               prefer="return=representation")
    return out[0] if isinstance(out, list) and out else None


def update(table: str, filters: str, payload: dict, *, select: str = "") -> list[dict]:
    """PATCH matching rows; with select="" returns [] (no representation needed)."""
    return rest("PATCH", table, filters=filters, body=payload,
                select=select, prefer="return=representation" if select else "") or []