#!/usr/bin/env python3
"""Telegram Bot API relay for tools/worker.py — messages, screenshots, Mini App buttons."""
from __future__ import annotations

import os

import requests

_BOT = os.environ.get("TELEGRAM_BOT_TOKEN") or ""


def url(method: str) -> str:
    return f"https://api.telegram.org/bot{_BOT}/{method}"


def vault_url(domain: str) -> str:
    """The /vault Mini App URL, gate- and domain-targeted (same query the webhook uses)."""
    base = os.environ.get("OI_VAULT_URL") \
        or ((os.environ.get("OI_PUBLIC_URL") or os.environ.get("RENDER_EXTERNAL_URL") or "http://localhost:3000").rstrip("/") + "/vault")
    sep = "&" if "?" in base else "?"
    return f"{base}{sep}gate=credentials&domain={domain}"


def message(chat_id: str, text: str, keyboard: bool | str = False) -> None:
    if not _BOT:
        return  # no token → no chat to relay to (self-check / dry runs)
    body: dict = {"chat_id": chat_id, "text": text}
    if keyboard:
        domain = keyboard if isinstance(keyboard, str) else ""
        body["reply_markup"] = {"inline_keyboard": [[
            {"text": "🔒 Open Secure Vault", "web_app": {"url": vault_url(domain)}}
        ]]}
    try:
        requests.post(url("sendMessage"), json=body, timeout=15)
    except requests.RequestException:
        pass  # a dropped relay must never kill the worker loop


def photo(chat_id: str, png_path: str) -> None:
    try:
        with open(png_path, "rb") as f:
            requests.post(url("sendPhoto"), data={"chat_id": str(chat_id)},
                          files={"photo": ("frame.png", f, "image/png")}, timeout=30)
    except OSError:
        pass  # a missing frame must never break the relay


def reply(chat_id: str, callback_id: str, text: str) -> None:
    requests.post(url("answerCallbackQuery"),
                  json={"callback_query_id": callback_id, "text": text}, timeout=15)