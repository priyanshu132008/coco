#!/usr/bin/env python3
"""Shared BYOK config loader — one mapping for agent_runner, browser_driver and anything else."""
from __future__ import annotations

import json
import os
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = os.environ.get("COCO_CONFIG") or str(_ROOT / "config.json")


#: A model already written as "provider/model" goes to LiteLLM verbatim — the setup page
#: stores user-specified strings verbatim, and the runner must never double-prefix them.
QUALIFIED_PREFIXES = (
    "anthropic/", "openai/", "openrouter/", "ollama/", "gemini/", "azure/", "azure_ai/",
    "bedrock/", "vertex_ai/", "mistral/", "groq/", "deepseek/", "together_ai/", "xai/",
    "cohere/", "fireworks/", "watsonx/", "perplexity/",
)


def load_model_config(path: str = CONFIG_PATH) -> str:
    """Per-task override (COCO_MODEL, set by worker.py from the bot's stored model) → config.json → the LiteLLM model string."""
    if os.environ.get("COCO_MODEL"):
        return os.environ["COCO_MODEL"]
    with open(path, encoding="utf-8") as f:
        cfg = json.load(f)
    model = cfg["active_model"]
    provider = cfg.get("provider", "openai")
    if model.startswith(QUALIFIED_PREFIXES):
        return model  # already qualified — "anthropic/claude-…", "openrouter/deepseek/deepseek-chat"
    if provider == "openai":
        return model  # "gpt-4o" is already LiteLLM's openai/ form
    return f"{provider}/{model}"  # "anthropic/claude-…", "openrouter/deepseek/deepseek-chat", "ollama/…"

if __name__ == "__main__":
    # self-check: config resolution — COCO_MODEL override, qualified pass-through, prefixing
    import sys, tempfile

    if sys.version_info < (3, 10):
        sys.exit("python 3.10+ required")
    cfg_path = tempfile.mktemp(suffix=".json")
    with open(cfg_path, "w", encoding="utf-8") as f:
        json.dump({"provider": "openrouter", "active_model": "anthropic/claude-3.5-sonnet"}, f)
    os.environ.pop("COCO_MODEL", None)
    got = load_model_config(cfg_path)
    assert got == "anthropic/claude-3.5-sonnet", got  # user-specified qualified model verbatim
    with open(cfg_path, "w", encoding="utf-8") as f:
        json.dump({"provider": "openrouter", "active_model": "auto"}, f)
    assert load_model_config(cfg_path) == "openrouter/auto"  # bare model → provider prefix
    os.environ["COCO_MODEL"] = "ollama/qwen2.5"
    assert load_model_config(cfg_path) == "ollama/qwen2.5"  # per-task override wins
    os.environ.pop("COCO_MODEL")
    os.remove(cfg_path)
    print("byok self-check OK (override + verbatim + prefix)")
