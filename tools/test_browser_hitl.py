#!/usr/bin/env python3
"""End-to-end HitL gate test for the browser-use driver, fully offline:
fake local checkout page → agent stops pre-payment → approval_required → ledger flip
→ COCO_FAKE_PRIVACY card → finisher agent runs → Done.
    ./.venv-bu/bin/python tools/test_browser_hitl.py
"""
import json
import os
import sqlite3
import http.server
import socketserver
import subprocess
import sys
import tempfile
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# serve a fake checkout page — chromium blocks file:// navigation
FAKE = """<!doctype html><html><head><title>Fake Checkout</title></head>
<body><h1>Checkout</h1><p>Grand Total: $9.99</p>
<form><input id="cardnum" placeholder="Card number"><input id="cvv" placeholder="CVV"></form>
<button id="paybtn" onclick="document.getElementById('paybtn').textContent='Paid!'">Confirm purchase</button>
</body></html>"""
with open("/tmp/oi_fake_cart.html", "w") as f:
    f.write(FAKE)


class Quiet(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):  # serve /tmp so /oi_fake_cart.html resolves
        super().__init__(*a, directory="/tmp", **k)

    def log_message(self, *a):  # silence the request spam
        pass


httpd = socketserver.TCPServer(("127.0.0.1", 8996), Quiet)
threading.Thread(target=httpd.serve_forever, daemon=True).start()

tmp_db = os.path.join(tempfile.gettempdir(), "bu_hitl_tasks.db")
if os.path.exists(tmp_db):
    os.unlink(tmp_db)
conn = sqlite3.connect(tmp_db)
conn.execute("CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, phone_number TEXT, goal TEXT, status TEXT, created_at DATETIME)")
conn.execute("INSERT INTO tasks (phone_number, goal, status, created_at) VALUES ('tg', 'buy', 'running', datetime('now'))")
conn.commit()
conn.close()

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
env = {
    **os.environ,
    "COCO_DB_PATH": tmp_db,
    "COCO_APPROVAL_TIMEOUT": "90",
    "COCO_FAKE_PRIVACY": "1",
    "COCO_BU_HEADLESS": "1",
    "COCO_BU_MAX_STEPS": "5",  # keep the test snappy — 5 steps is enough for a one-page stop
}
proc = subprocess.Popen(
    [os.path.join(root, ".venv-bu", "bin", "python"), os.path.join(root, "tools", "browser_driver.py"),
     "run", "--goal", "Open http://127.0.0.1:8996/oi_fake_cart.html and review the order. Do not confirm the purchase.",
     "--task-id", "1"],
    cwd=root, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=env
)

events, deadline = [], time.monotonic() + 420

def reader(stream, queue):  # readline blocks forever — pump through a queue so the deadline still rules
    for line in stream:
        queue.put(line)
    queue.put(None)

import queue as _q, threading as _t
lines = _q.Queue()
_t.Thread(target=reader, args=(proc.stdout, lines), daemon=True).start()
while time.monotonic() < deadline:
    try:
        line = lines.get(timeout=2.0)
    except _q.Empty:
        if proc.poll() is not None:
            break
        continue
    if line is None:
        break
    try:
        ev = json.loads(line.strip())
    except json.JSONDecodeError:
        continue
    events.append(ev)
    if ev.get("type") == "approval_required":
        wc = sqlite3.connect(tmp_db)
        wc.execute("UPDATE tasks SET status='approved' WHERE id=1")
        wc.commit()
        wc.close()
try:
    proc.wait(timeout=30)
except subprocess.TimeoutExpired:
    proc.kill()
    assert False, "driver did not exit"

types = [e.get("type") for e in events if "type" in e]
assert "screenshot" in types, f"no live photo feed: {types}"
asks = [e for e in events if e.get("type") == "approval_required"]
assert asks, f"no approval_required — checkout gate never fired: {types}"
assert any("Done" in (e.get("message") or "") for e in events if e.get("type") == "chat"), types
assert not any("4111111111111111" in json.dumps(e) for e in events), "PAN leaked to stdout"
print(f"test_browser_hitl ✓ — feed({types.count('screenshot')} frames) → pre-payment stop → approved → card → Done")
os.unlink(tmp_db)