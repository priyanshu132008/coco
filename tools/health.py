#!/usr/bin/env python3
"""`coco health` — diagnostic for the local install.

Checks .env presence, COCO_VAULT_KEY validity, SQLite integrity (vault.db,
tasks.db) and key availability (Telegram bot, LLM provider). Every failure
prints the specific fix. Exit 0 = healthy, 1 = at least one failure.

Self-check (throwaway paths, exercises pass + failure branches):
    COCO_HEALTH_CHECK=1 ./.venv/bin/python tools/health.py
"""
from __future__ import annotations

import os
import sqlite3
import sys
from pathlib import Path

from cryptography.fernet import Fernet

_ROOT = Path(__file__).resolve().parent.parent

FAIL = "\033[31m✖\033[0m"
OK = "\033[32m✔\033[0m"
_failures = 0

#: keys accepted as "an LLM provider is configured" — any one is enough.
LLM_KEYS = ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "OLLAMA_API_KEY")


def _first_env(*names: str) -> str:
    """First set COCO_* name; the OI_* spellings are the pre-rebrand aliases."""
    for n in names:
        v = os.environ.get(n)
        if v:
            return v
    return ""


def _paths() -> tuple[Path, Path, Path]:
    """Re-derived per main() call — self-checks repoint these via env after import."""
    env = Path(_first_env("COCO_ENV_PATH", "OI_ENV_PATH") or _ROOT / ".env")
    vault = Path(_first_env("COCO_VAULT_DB", "OI_VAULT_DB") or _ROOT / "vault.db")
    tasks = Path(_first_env("COCO_DB_PATH", "OI_DB_PATH") or _ROOT / "telegram_gateway" / "tasks.db")
    return env, vault, tasks


def check(label: str, ok: bool, fix: str | None) -> None:
    global _failures
    print(f"{OK if ok else FAIL} {label}")
    if not ok:
        _failures += 1
        print(f"   fix: {fix}", file=sys.stderr)


def _env_values(env_path: Path) -> dict[str, str]:
    if not env_path.is_file():
        return {}
    out = {}
    for line in env_path.read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip().strip("'\"")
    return out


def _sqlite(path: Path) -> bool:
    if not path.exists():
        check(f"SQLite db {path.name}", True, None)  # created on first use — not a failure
        return True
    try:
        conn = sqlite3.connect(path)
        result = conn.execute("PRAGMA integrity_check").fetchone()[0]
        conn.close()
    except sqlite3.DatabaseError as exc:
        check(f"SQLite db {path.name}", False, f"unreadable ({exc}) — restore from backup")
        return False
    check(f"SQLite db {path.name}", result == "ok",
          f'integrity_check returned "{result}" — restore {path} from backup '
          "(`sqlite3 .dump` may still rescue rows)")
    return result == "ok"


def main() -> int:
    ENV_PATH, VAULT_DB, TASKS_DB = _paths()
    values = _env_values(ENV_PATH)

    check(f".env file ({ENV_PATH})", ENV_PATH.is_file(),
          "missing — run `coco configure` to enter your keys (or copy .env.example)")

    # vault key: present and a valid Fernet key (never auto-regen a live vault's key)
    raw = values.get("COCO_VAULT_KEY") or values.get("OI_VAULT_KEY")  # OI_ = pre-rebrand name
    if not raw:
        check("COCO_VAULT_KEY set", False,
              "missing — auto-generated on first vault use; if vault.db already holds records, "
              "restore the ORIGINAL key from your .env backup or every stored credential goes unreadable")
    else:
        try:
            Fernet(raw.encode())
            check("COCO_VAULT_KEY valid Fernet key", True, None)
        except Exception as exc:
            check("COCO_VAULT_KEY valid Fernet key", False,
                  f"not a Fernet key ({exc}) — restore the original COCO_VAULT_KEY from backup, "
                  "else vault.db becomes unreadable")

    _sqlite(VAULT_DB)   # empty-first-run is normal for both
    _sqlite(TASKS_DB)

    check("TELEGRAM_BOT_TOKEN present", bool(values.get("TELEGRAM_BOT_TOKEN")),
          "missing — run `coco configure` and paste the token from @BotFather on Telegram")
    check("LLM provider key present", any(values.get(k) for k in LLM_KEYS),
          "missing — run `coco configure` and enter one of: " + ", ".join(LLM_KEYS))
    return 1 if _failures else 0


if __name__ == "__main__":
    if os.environ.get("COCO_HEALTH_CHECK"):  # hermetic pass + failure paths, no real files
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            env = Path(tmp) / "good.env"
            env.write_text(f"COCO_VAULT_KEY={Fernet.generate_key().decode()}\n"
                           "TELEGRAM_BOT_TOKEN=1:tok\nOPENAI_API_KEY=sk-x\n")
            db = Path(tmp) / "v.db"
            sqlite3.connect(db).execute("CREATE TABLE accounts (id int)")
            os.environ.update(COCO_ENV_PATH=str(env), COCO_VAULT_DB=str(db), COCO_DB_PATH=str(
                Path(tmp) / "tasks_missing.db"))
            assert main() == 0, "green fixture must be healthy"

            env2 = Path(tmp) / "bad.env"   # no vault key, no bot token, no llm key
            env2.write_text("FOO=1\n")
            corrupt = Path(tmp) / "corrupt.db"
            corrupt.write_bytes(b"not a database" * 32)
            os.environ.update(COCO_ENV_PATH=str(env2), COCO_VAULT_DB=str(corrupt))
            assert main() == 1, "fixture with 4 defects must fail"
        print("[health] self-check ok — green fixture passes, corrupt env/db/dbs fail")
        sys.exit(0)
    sys.exit(main())