#!/usr/bin/env python3
"""Telegram Bot API relay for tools/worker.py — messages, screenshots, Mini App buttons.

Multi-tenant: every call takes the bot's token (worker.py resolves it from
bot_credentials per task). token="" falls back to the platform TELEGRAM_BOT_TOKEN
for self-checks / single-bot local runs.
"""
from __future__ import annotations

import os

import requests


def url(method: str, token: str = "") -> str:
    bot = token or os.environ.get("TELEGRAM_BOT_TOKEN") or ""
    return f"https://api.telegram.org/bot{bot}/{method}"


def vault_url(domain: str) -> str:
    """The /vault Mini App URL, gate- and domain-targeted (same query the webhook uses)."""
    base = os.environ.get("OI_VAULT_URL") \
        or ((os.environ.get("OI_PUBLIC_URL") or os.environ.get("RENDER_EXTERNAL_URL") or "http://localhost:3000").rstrip("/") + "/vault")
    sep = "&" if "?" in base else "?"
    return f"{base}{sep}gate=credentials&domain={domain}"


def message(chat_id: str, text: str, keyboard: bool | str = False, token: str = "") -> None:
    if not (token or os.environ.get("TELEGRAM_BOT_TOKEN")):
        return  # no token → no chat to relay to (self-check / dry runs)
    body: dict = {"chat_id": chat_id, "text": text}
    if keyboard:
        domain = keyboard if isinstance(keyboard, str) else ""
        body["reply_markup"] = {"inline_keyboard": [[
            {"text": "🔒 Open Secure Vault", "web_app": {"url": vault_url(domain)}}
        ]]}
    try:
        requests.post(url("sendMessage", token), json=body, timeout=15)
    except requests.RequestException:
        pass  # a dropped relay must never kill the worker loop


def photo(chat_id: str, png_path: str, token: str = "") -> None:
    try:
        with open(png_path, "rb") as f:
            requests.post(url("sendPhoto", token), data={"chat_id": str(chat_id)},
                          files={"photo": ("frame.png", f, "image/png")}, timeout=30)
    except OSError:
        pass  # a missing frame must never break the relay


def reply(chat_id: str, callback_id: str, text: str, token: str = "") -> None:
    requests.post(url("answerCallbackQuery", token),
                  json={"callback_query_id": callback_id, "text": text}, timeout=15)