#!/usr/bin/env python3
"""End-to-end checkout contract test: approval_required → approve → (no-network) virtual card
→ VLM fill mapping → card_filled event. All external calls stubbed via OI_FAKE_* envs.
    ./.venv/bin/python tools/test_fill.py
"""
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

tmp_db = os.path.join(tempfile.gettempdir(), "fill_test_tasks.db")
if os.path.exists(tmp_db):
    os.unlink(tmp_db)
conn = sqlite3.connect(tmp_db)
conn.execute("CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, phone_number TEXT, goal TEXT, status TEXT, created_at DATETIME)")
conn.execute("INSERT INTO tasks (phone_number, goal, status, created_at) VALUES ('w', 'Buy', 'running', datetime('now'))")
conn.commit()
conn.close()

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
env = {
    **os.environ,
    "OI_DB_PATH": tmp_db,
    "OI_APPROVAL_TIMEOUT": "60",
    "OI_FAKE_VLM": "1",  # payment=true, price $450
    "OI_FAKE_PRIVACY": "1",
    "OI_FAKE_FILL": '[{"field": "PAN", "box_id": 1}, {"field": "CVV", "box_id": 2}, {"field": "EXP", "box_id": 3}]',
}
proc = subprocess.Popen(
    [os.path.join(root, ".venv", "bin", "python"), os.path.join(root, "tools", "agent_runner.py"),
     "run", "--goal", "Buy the thing", "--task-id", "1", "--steps", "1"],
    cwd=root, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=env
)

events = []
deadline = time.monotonic() + 120
while time.monotonic() < deadline and proc.poll() is None:
    line = proc.stdout.readline()
    if not line:
        break
    try:
        ev = json.loads(line.strip())
    except json.JSONDecodeError:
        continue
    events.append(ev)
    if ev.get("type") == "approval_required":
        time.sleep(2)  # gateway's side: user approves
        wc = sqlite3.connect(tmp_db)
        wc.execute("UPDATE tasks SET status='approved' WHERE id=1")
        wc.commit()
        wc.close()
proc.wait(timeout=60)

assert proc.returncode == 0, f"runner exited {proc.returncode}"
types = [e.get("type") for e in events if "type" in e]
assert "approval_required" in types, f"no ask: {types}"
assert "card_mapped" in types, f"no fill mapping: {types}"
mapped = next(e for e in events if e.get("type") == "card_mapped")
assert [f["field"] for f in mapped["fields"]] == ["PAN", "CVV", "EXP"], mapped
filled = next(e for e in events if e.get("type") == "card_filled")
assert filled["fields"] == ["PAN", "CVV", "EXP"], filled
blob = "".join(line for line in " ".join(json.dumps(e) for e in events).split())
assert "4111111111111111" not in blob, "PAN leaked to stdout!"
assert any("decision" in e for e in events), "no step decision landed"
print("test_fill ✓ — approve → card mapped (PAN/CVV/EXP, PAN masked on stdout) → filled → decision")
os.unlink(tmp_db)