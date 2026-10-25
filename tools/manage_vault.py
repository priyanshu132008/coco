#!/usr/bin/env python3
"""Vault management CLI — add/list/remove TOTP seeds from the terminal.

    ./.venv/bin/python tools/manage_vault.py add github.com JBSWY3DPEHPK3PXP
    ./.venv/bin/python tools/manage_vault.py list
    ./.venv/bin/python tools/manage_vault.py remove github.com

`add` verifies the seed with pyotp before storing (typo'd keys die here, not mid-login).
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from tools.vault import add_seed, get_code, list_domains, DB_PATH  # noqa: E402


def cmd_add(domain: str, seed: str) -> int:
    import pyotp

    seed = seed.strip().replace(" ", "").upper()
    try:
        pyotp.TOTP(seed).now()  # validate before persisting
    except Exception:
        print(f"error: '{seed}' is not a valid base32 TOTP seed", file=sys.stderr)
        return 2
    add_seed(domain, seed)
    code = get_code(domain)
    print(f"stored seed for {domain} in {Path(DB_PATH).name} — current code: {code}")
    return 0


def cmd_list() -> int:
    entries = list_domains()
    if not entries:
        print("vault is empty")
        return 0
    for domain, code in entries.items():
        print(f"{domain}: {code}")
    return 0


def cmd_remove(domain: str) -> int:
    from tools.vault import remove_seed

    if remove_seed(domain):
        print(f"removed {domain}")
        return 0
    print(f"no seed stored for {domain}", file=sys.stderr)
    return 1


def main() -> int:
    p = argparse.ArgumentParser(description="Coco TOTP vault manager")
    p.add_argument("command", choices=["add", "list", "remove"])
    p.add_argument("domain", nargs="?", help="domain, e.g. github.com")
    p.add_argument("seed", nargs="?", help="base32 secret from the site's 2FA setup page")
    args = p.parse_args()
    if args.command in ("add", "remove") and not args.domain:
        p.error(f"{args.command} requires a domain")
    if args.command == "add" and not args.seed:
        p.error("add requires a seed")
    return {"add": lambda: cmd_add(args.domain, args.seed), "list": cmd_list, "remove": lambda: cmd_remove(args.domain)}[args.command]()


if __name__ == "__main__":
    sys.exit(main())