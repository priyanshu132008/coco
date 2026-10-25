#!/usr/bin/env python3
"""End-to-end 2FA contract test: runner asks via code_required → gateway-side code lands
in pending_codes → runner picks it up and proceeds.

Simulates the gateway's side over stdout, exactly like test_hitl.py does for approvals.
    ./.venv/bin/python tools/test_totp.py
"""
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

tmp_db = os.path.join(tempfile.gettempdir(), "totp_test_tasks.db")
if os.path.exists(tmp_db):
    os.unlink(tmp_db)
conn = sqlite3.connect(tmp_db)
conn.execute("CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, phone_number TEXT, goal TEXT, status TEXT, created_at DATETIME)")
conn.execute("CREATE TABLE pending_codes (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER, domain TEXT, code TEXT, created_at DATETIME)")
conn.execute("INSERT INTO tasks (phone_number, goal, status, created_at) VALUES ('w', 'Enter 2FA', 'running', datetime('now'))")
conn.commit()
conn.close()

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
env = {
    **os.environ,
    "COCO_DB_PATH": tmp_db,           # runner's approval/codes ledger
    "COCO_CODE_TIMEOUT": "60",
    "COCO_FAKE_VLM": '{"box_id": 2, "payment": false, "price": null, "is_totp_field": true, "domain": "testshop.com"}',
}
proc = subprocess.Popen(
    [os.path.join(root, ".venv", "bin", "python"), os.path.join(root, "tools", "agent_runner.py"),
     "run", "--goal", "Enter 2FA", "--task-id", "1", "--steps", "1"],
    cwd=root, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=env
)

asks, results = [], []
deadline = time.monotonic() + 120
while time.monotonic() < deadline and proc.poll() is None:
    line = proc.stdout.readline()
    if not line:
        break
    try:
        ev = json.loads(line.strip())
    except json.JSONDecodeError:
        continue
    if ev.get("type") == "code_required":
        asks.append(ev)
        # gateway's side: user replies with the 6 digits 2s after the ask
        time.sleep(2)
        wc = sqlite3.connect(tmp_db)
        wc.execute("INSERT INTO pending_codes (task_id, domain, code, created_at) VALUES (1, 'testshop.com', '867530', datetime('now'))")
        wc.commit()
        wc.close()
    elif "decision" in ev:
        results.append(ev)
proc.wait(timeout=60)

assert proc.returncode == 0, f"runner exited {proc.returncode}"
assert asks, "no code_required was emitted"
assert asks[0]["domain"] == "testshop.com" and asks[0]["task_id"] == 1, f"bad ask payload {asks[0]}"
assert any("decision" in r for r in results), "no step decision after code relay — runner did not proceed"
print("test_totp ✓ — code_required emitted, relayed code landed in pending_codes, runner proceeded")
os.unlink(tmp_db)