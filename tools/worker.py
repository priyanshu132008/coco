#!/usr/bin/env python3
"""OpenInstinct worker for Render — polls the Supabase task ledger, runs the agent, relays to Telegram.

The Vercel webhook (serverless) only INSERTs tasks and routes chat decisions; this worker
is the one long-running piece: it claims 'pending' tasks, executes tools/browser_driver.py,
streams the driver's JSON events to the Telegram chat (messages, screenshots, gate buttons),
relays human replies from the ledger (approval/OTP/location/retry — the driver polls them via
ledger_poll), and writes the final status back.

    SUPABASE_URL=... SUPABASE_SERVICE_KEY=... TELEGRAM_BOT_TOKEN=... python tools/worker.py
"""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))
from dotenv import load_dotenv

load_dotenv()  # same .env convention as every other OpenInstinct entry point

from tools import supabase_client as sbc
from tools import worker_tg

POLL = float(os.environ.get("OI_WORKER_POLL", "3"))
#: Python + driver (browser-use needs py>=3.11; override on Render with OI_RUNNER_PYTHON)
RUNNER_PYTHON = os.environ.get("OI_RUNNER_PYTHON") or sys.executable
DRIVER = str(_ROOT / "tools" / "browser_driver.py")
#: Exit codes → ledger status, same mapping the gateway learned the hard way.
STATUS_BY_CODE = {0: "done", 130: "cancelled"}


def claim_task() -> int | None:
    """Atomically claim the oldest pending task: PATCH pending→running only if still pending."""
    rows = sbc.rows("tasks", "status=eq.pending&order=id.asc", select="id,bot_id", limit=1)
    if not rows:
        return None
    task_id = rows[0]["id"]
    claimed = sbc.update("tasks", f"id=eq.{task_id}&status=eq.pending", {"status": "running"}, select="id")
    return task_id if claimed else None  # lost the race (another worker) — skip


def bot_for(task_id: int, bot_id: int | None) -> dict | None:
    """The task's bot row, token/api_key already decrypted. bot_id null → no row → caller
    falls back to the platform env (single-bot mode / self-checks)."""
    if not bot_id:
        return None
    row = sbc.first("bot_credentials", f"id=eq.{bot_id}", select="token,api_key,model,api_base")
    if not row:
        return None
    from tools.vault import _decrypt
    return {
        "token": _decrypt(str(row["token"])),
        "api_key": _decrypt(row["api_key"]) if row.get("api_key") else None,
        "model": str(row["model"] or ""),
        "api_base": row.get("api_base") or None,
    }


def model_env(bot: dict | None) -> dict[str, str]:
    """Per-task overrides for the runner: the bot's model and the right key env for it."""
    if not (bot and bot["model"]):
        return {}
    env = {"OI_MODEL": bot["model"]}
    key_var = ("ANTHROPIC_API_KEY" if bot["model"].startswith("anthropic/")
               else "OPENROUTER_API_KEY" if bot["model"].startswith("openrouter/")
               else "OPENAI_API_KEY")
    if bot["api_key"]:
        env[key_var] = bot["api_key"]
    if bot["api_base"]:
        env["OPENAI_API_BASE"] = bot["api_base"]
    return env


def spawn_runner(task_id: int, bot: dict | None) -> subprocess.Popen:
    child = subprocess.Popen(
        [RUNNER_PYTHON, DRIVER, "run", "--goal", _goal_text(task_id), "--task-id", str(task_id)],
        cwd=str(_ROOT), env={**os.environ, "OI_AGENT_CLICK": "1", **model_env(bot)},
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    sbc.update("tasks", f"id=eq.{task_id}", {"pid": child.pid})
    return child


def _goal_text(task_id: int) -> str:
    return str(sbc.first("tasks", f"id=eq.{task_id}", select="goal")["goal"])


def watch_cancellations(running: dict[int, subprocess.Popen]) -> None:
    """A /stop on the webhook flips status to 'cancelled' — SIGINT our child for it."""
    if not running:
        return
    ids = ",".join(str(i) for i in running)
    for row in sbc.rows("tasks", f"id=in.({ids})&status=eq.cancelled", select="id"):
        child = running.get(row["id"])
        try:
            child.send_signal(signal.SIGINT)  # the driver tears the browser down on SIGINT
            print(f"[worker] /stop → SIGINT task {row['id']}", flush=True)
        except Exception:
            pass


class Relay(threading.Thread):
    """One per task: stream the driver's stdout JSON events to the chat; update status on close."""

    def __init__(self, task_id: int, chat_id: str, child: subprocess.Popen, bot_token: str = ""):
        super().__init__(daemon=True)
        self.task_id, self.chat_id, self.child, self.bot_token = task_id, chat_id, child, bot_token

    def run(self) -> None:
        assert self.child.stdout
        buf = ""
        for chunk in self.child.stdout:
            buf += chunk.decode("utf-8", "replace")
            lines, buf = buf.split("\n")[:-1], buf.split("\n")[-1]
            for line in lines:
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue  # stdout noise
                try:
                    self.relay(ev)
                except Exception as e:
                    print(f"[worker] relay failed for task {self.task_id}: {e}", file=sys.stderr, flush=True)
        code = self.child.wait()
        self.finish(code)

    def relay(self, ev: dict) -> None:
        kind = str(ev.get("type") or ev.get("event") or "")
        if kind == "chat" and ev.get("message"):
            worker_tg.message(self.chat_id, str(ev["message"])[:4096], token=self.bot_token)
        elif kind == "screenshot" and ev.get("path"):
            worker_tg.photo(self.chat_id, ev["path"], token=self.bot_token)
        elif kind in ("vault_required", "credentials"):
            self.gate("credentials", ev)
        elif kind == "location_required":
            self.gate("location", ev)
        elif kind == "payment_required":
            self.gate("card", ev)
        elif kind == "approval_required":
            self.gate("approval", ev, text=f"Checkout reached. Total: {ev.get('price') or '?'}\nReply \"approve\" to execute payment, \"deny\" to cancel.")
        elif kind in ("otp_required", "code_required"):
            self.gate("code", ev, text=f"🔐 Task #{self.task_id} needs a one-time password for {ev.get('domain') or 'the site'}. Reply with the 6 digits (e.g. \"otp 123456\").")
        elif kind == "captcha_required":
            self.gate("captcha", ev, text=f"🛡️ Cloudflare verification required for {ev.get('domain') or 'the site'}. Solve it and reply \"retry\".")
        elif kind == "error" and ev.get("message"):
            worker_tg.message(self.chat_id, f"❌ Task #{self.task_id} failed: {ev['message']}")

    def gate(self, gate: str, ev: dict, text: str | None = None) -> None:
        domain = str(ev.get("domain") or "")
        # the webhook routes approve/deny/otp/address/retry by looking at task.gate
        sbc.update("tasks", f"id=eq.{self.task_id}", {"gate": gate, "gate_domain": domain})
        if gate in ("credentials", "location", "card") and domain:
            worker_tg.message(self.chat_id, text or f"🔐 {domain} needs setup. Open the Secure Vault:", keyboard=domain, token=self.bot_token)
        elif text:
            worker_tg.message(self.chat_id, text, token=self.bot_token)

    def finish(self, code: int) -> None:
        current = (sbc.first("tasks", f"id=eq.{self.task_id}", select="status") or {}).get("status")
        print(f"[worker] task {self.task_id} runner exited ({code})", file=sys.stderr, flush=True)
        if current == "cancelled":  # /stop already wrote the verdict — keep it
            status = "cancelled"
        else:
            status = STATUS_BY_CODE.get(code, "failed") if code is not None else "failed"  # killed
        sbc.update("tasks", f"id=eq.{self.task_id}", {"status": status, "pid": None, "gate": None})
        notices = {
            "cancelled": "🛑 Task #{0} cancelled.".format(self.task_id),
            "done": "✅ Task #{0} finished.".format(self.task_id),
            "failed": "❌ Task #{0} failed.".format(self.task_id),
        }
        worker_tg.message(self.chat_id, notices[status], token=self.bot_token)


# Update CloakBrowser and Render Port Sync — health thread + Supabase polling loop
def start_health_server() -> None:
    """Render free tier runs this as a Web Service, not a paid Background Worker —
    so the polling loop keeps its thread and the health route lives in a daemon one.

    Bound 0.0.0.0 on $PORT — the port scan must find it open within seconds of boot,
    which is why it is called before anything else in __main__ (idempotent)."""
    global _HEALTH_SET
    if _HEALTH_SET:
        return
    port = int(os.environ.get("PORT") or 10000)

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            body = b'{"status": "alive"}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args: object) -> None:
            pass  # health checks every ~10s would drown the task log

    threading.Thread(
        target=HTTPServer(("0.0.0.0", port), Handler).serve_forever,
        daemon=True,
    ).start()
    _HEALTH_SET = True
    print(f"[worker] health server on 0.0.0.0:{port}", flush=True)


_HEALTH_SET = False


def main() -> int:
    # NO early return on missing env: the health server is already up (bound in
    # __main__), so staying alive with logged warnings is what a deploy should do —
    # exiting here re-created the "no open ports detected" failure on Render.
    if not sbc.enabled():
        print("[worker] SUPABASE_URL / SUPABASE_SERVICE_KEY missing — healthcheck up, worker idle", file=sys.stderr)
    if not os.environ.get("TELEGRAM_BOT_TOKEN"):
        # fine in multi-tenant mode: each task carries its bot's own token in the ledger
        print("[worker] no platform TELEGRAM_BOT_TOKEN — tasks need a bot_credentials row", file=sys.stderr)
    print(f"[worker] polling Supabase every {POLL:g}s", flush=True)
    running: dict[int, subprocess.Popen] = {}
    while True:
        try:
            if not sbc.enabled():
                time.sleep(POLL)  # misconfigured — stay up for the healthcheck, claim nothing
                continue
            watch_cancellations(running)
            for task_id, child in list(running.items()):
                if child.poll() is not None:
                    running.pop(task_id)
            task_id = claim_task()
            if task_id and task_id not in running:
                task = sbc.first("tasks", f"id=eq.{task_id}", select="phone_number,bot_id")
                bot = bot_for(task_id, (task or {}).get("bot_id"))
                child = spawn_runner(task_id, bot)
                running[task_id] = child
                relay_token = (bot or {}).get("token") or os.environ.get("TELEGRAM_BOT_TOKEN") or ""
                Relay(task_id, str((task or {}).get("phone_number") or ""), child, relay_token).start()
                print(f"[worker] claimed task {task_id} (pid {child.pid}, bot_id {(task or {}).get('bot_id')})", flush=True)
        except Exception as e:
            print(f"[worker] loop error: {e}", file=sys.stderr, flush=True)
        time.sleep(POLL)


if __name__ == "__main__":
    # absolute first line: bind the port before ANY import-heavy work or env checks —
    # Render's port scan times out if nothing listens during boot
    start_health_server()
    sys.exit(main())