#!/usr/bin/env python3
"""Privacy.com single-use virtual cards for the checkout flow.

generate_virtual_card(price_str) turns a VLM-extracted price ("$45.00") into a
transaction-limit single-use card capped at price + 10% (taxes/fees buffer) and
returns {pan, cvv, exp_month, exp_year}. Requires OI_PRIVACY_API_KEY in .env.

    ./.venv/bin/python tools/payment.py   # offline self-check (no network)
"""
from __future__ import annotations

import re
from typing import Any, Callable, Optional

import requests
from dotenv import load_dotenv

load_dotenv()

API_URL = "https://api.privacy.com/v1/cards"


def parse_price(price_str: str) -> int:
    # ponytail: int math, no currency-precision lib — cents-only inputs are the contract
    """$45.00 / "$1,299.99" / "Total: 99.99 USD" → spend limit in cents +10% buffer (taxes/fees).

    Buffer rounds UP — a spend limit that undercuts the real charge fails the transaction.
    """
    import math

    m = re.search(r"\$?\s*([\d,]+(?:\.\d{1,2})?)", str(price_str))
    if not m:
        raise ValueError(f"unparseable price: {price_str!r}")
    cents = round(float(m.group(1).replace(",", "")) * 100)
    return math.ceil(cents * 1.10)


def _post(url: str, headers: dict[str, str], payload: dict[str, Any]) -> dict[str, Any]:
    """Swap point for tests — keeps the real HTTP call out of the self-check."""
    r = requests.post(url, headers=headers, json=payload, timeout=30)
    r.raise_for_status()
    return r.json()


def generate_virtual_card(
    price_str: str,
    memo: str = "OpenInstinct Task",
    post_fn: Optional[Callable[[str, dict[str, str], dict[str, Any]], dict[str, Any]]] = None,
) -> dict[str, str]:
    """Create a single-use card capped at price+10%; return PAN/CVV/expiry strings.

    Privacy nests the card under {"card": …}; accept flat responses too.
    """
    import os

    limit_cents = parse_price(price_str)
    headers = {"Content-Type": "application/json"}
    if post_fn is None:
        api_key = os.environ.get("OI_PRIVACY_API_KEY")
        if not api_key:
            raise RuntimeError("OI_PRIVACY_API_KEY missing from environment — add it to .env")
        headers["Authorization"] = f"api-key {api_key}"
    resp = (post_fn or _post)(
        API_URL,
        headers,
        {
            "type": "SINGLE_USE",
            "memo": memo,
            "spend_limit": limit_cents,
            "spend_limit_duration": "TRANSACTION",
            "state": "OPEN",
        },
    )
    card = resp.get("card", resp)
    return {
        "pan": str(card["pan"]),
        "cvv": str(card["cvv"]),
        "exp_month": str(card["exp_month"]).zfill(2),
        "exp_year": str(card["exp_year"]),
        "spend_limit": limit_cents,
    }


if __name__ == "__main__":
    assert parse_price("$45.00") == 4950, f"got {parse_price('$45.00')}"
    assert parse_price("$1,299.99") == 142999, f"got {parse_price('$1,299.99')}"
    assert parse_price("Total: 99.99 USD") == 10999, f"got {parse_price('99.99')}"
    fake = lambda url, headers, payload: {"card": {"pan": "4111111111111111", "cvv": "123", "exp_month": 9, "exp_year": 2027}}
    c = generate_virtual_card("$45.00", post_fn=fake)
    assert c["pan"] == "4111111111111111" and c["cvv"] == "123", c
    assert c["exp_month"] == "09" and c["exp_year"] == "2027", c
    assert c["spend_limit"] == 4950, c
    print(f"[payment] self-check ✓ — price parsing (+10% buffer), card shape, expiry zero-fill", flush=True)