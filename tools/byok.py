#!/usr/bin/env python3
"""Shared BYOK config loader — one mapping for agent_runner, browser_driver and anything else."""
from __future__ import annotations

import json
import os
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = os.environ.get("COCO_CONFIG") or str(_ROOT / "config.json")


def load_model_config(path: str = CONFIG_PATH) -> str:
    """Per-task override (COCO_MODEL, set by worker.py from the bot's stored model) → config.json → the LiteLLM model string."""
    if os.environ.get("COCO_MODEL"):
        return os.environ["COCO_MODEL"]
    with open(path, encoding="utf-8") as f:
        cfg = json.load(f)
    model = cfg["active_model"]
    provider = cfg.get("provider", "openai")
    if provider == "openai":
        return model  # "gpt-4o" is already LiteLLM's openai/ form
    return f"{provider}/{model}"  # "anthropic/claude-…", "openrouter/deepseek/deepseek-chat", "ollama/…"