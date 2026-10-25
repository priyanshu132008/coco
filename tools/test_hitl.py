#!/usr/bin/env python3
"""End-to-end HitL contract test: runner -> approval_required -> ledger flip -> runner proceeds.

Simulates the gateway's side (insert task, watch stdout, flip status) without WhatsApp.
    ./.venv/bin/python tools/test_hitl.py
Exits 0 on success; asserts otherwise.
"""
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

tmp_db = os.path.join(tempfile.gettempdir(), "hitl_test_tasks.db")
if os.path.exists(tmp_db):
    os.unlink(tmp_db)
conn = sqlite3.connect(tmp_db)
conn.execute("CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, phone_number TEXT, goal TEXT, status TEXT, created_at DATETIME)")
conn.execute("INSERT INTO tasks (phone_number, goal, status, created_at) VALUES ('w', 'Book a flight', 'running', datetime('now'))")
conn.commit()
conn.close()

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
env = {
    **os.environ,
    "COCO_DB_PATH": tmp_db,
    "COCO_APPROVAL_TIMEOUT": "60",
    "COCO_FAKE_VLM": "1",  # payment=true, price $450
    "COCO_FAKE_PRIVACY": "1",  # approved payment now issues a (stubbed) virtual card
    "COCO_FAKE_FILL": '[{"field": "PAN", "box_id": 1}]',
}
proc = subprocess.Popen(
    [os.path.join(root, ".venv", "bin", "python"), os.path.join(root, "tools", "agent_runner.py"),
     "run", "--goal", "Book a flight", "--task-id", "1", "--steps", "1"],
    cwd=root, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=env
)

approvals, results = [], []
deadline = time.monotonic() + 180
while time.monotonic() < deadline and proc.poll() is None:
    line = proc.stdout.readline()
    if not line:
        break
    try:
        ev = json.loads(line.strip())
    except json.JSONDecodeError:
        continue
    if ev.get("type") == "approval_required":
        approvals.append(ev)
        # gateway's side: user approves 2s after the ask
        conn = sqlite3.connect(tmp_db)
        conn.execute("UPDATE tasks SET status='approved' WHERE id=1")
        conn.commit()
        conn.close()
    elif ev.get("type") == "approval_result":
        results.append(ev)
    elif "decision" in ev:
        results.append(ev)
proc.wait(timeout=60)

assert proc.returncode == 0, f"runner exited {proc.returncode}"
assert approvals, "no approval_required was emitted"
assert (approvals[0].get("task_id"), approvals[0].get("step")) == (1, 1), f"bad approval payload {approvals[0]}"
assert not any(r.get("type") == "approval_result" for r in results), "approval flip was never seen"
assert any("decision" in r for r in results), "no step decision after approval — runner did not proceed"
# final status ('done') is the gateway's on("close") job — ledger.js self-check covers that write
print(f"test_hitl ✓ — approval_required emitted ({len(approvals)}), ledger flip resumed the run, step decision landed")
os.unlink(tmp_db)