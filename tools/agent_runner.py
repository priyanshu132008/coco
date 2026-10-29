#!/usr/bin/env python3
"""Coco BYOK execution pipeline — cloud VLM routing, local SoM + clicks.

The screenshot is annotated locally (tools/som.py → numbered boxes + coordinate
dict), the annotated frame goes to the active cloud VLM via LiteLLM, the returned
box ID maps back to local (x, y) coords, and the click dispatches through the
execution bridge (PyAutoGUI, gated by COCO_AGENT_CLICK).

CLI:
    ./.venv/bin/python tools/agent_runner.py decide --image shot.png --goal "Book a flight"
    ./.venv/bin/python tools/agent_runner.py run --goal "Book a flight"
Both print a single JSON document on stdout: {"decision": …, "boxes": {…}}.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import random
import re
import sys
import time
from typing import Any, Optional

import cv2
import numpy as np
from dotenv import load_dotenv

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tools.som import annotate_som, capture_screen  # noqa: E402
from tools.byok import load_model_config, CONFIG_PATH as _  # noqa: E402,F401
from tools.ledger_poll import (  # noqa: E402,F401
    DB_PATH, APPROVAL_TIMEOUT, CODE_TIMEOUT, wait_approval, wait_manual_code,
)

load_dotenv()

#: Active model string passed straight to LiteLLM ("openai", "anthropic/…", "openrouter/…").
CONFIG_PATH = os.environ.get("COCO_CONFIG") or os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config.json")
#: OS-level clicks only fire when this is "1" — the agent logs a dry-run otherwise.
CLICK_GATE = os.environ.get("COCO_AGENT_CLICK") == "1"
SYSTEM_PROMPT = (
    "You are Coco, a friendly and highly capable life-admin assistant. Analyze the "
    "provided screenshot with numbered bounding boxes. Which box ID corresponds to the target "
    "action: '{goal}'? You MUST ALWAYS include a 'message_to_user' field in your JSON response "
    "to talk to the user, explaining what you are currently doing or asking for clarification, "
    "alongside your 'box_id' and 'payment' flags. "
    'Return strictly JSON: {{"box_id": <int or null>, "payment": <bool>, "price": "<price string or null>", '
    '"is_totp_field": <bool>, "domain": "<site domain or null>", "message_to_user": "<string>", '
    '"type_query": "<text to type or null>"}} '
    "where type_query is the exact text to type into the box_id field when the goal needs typed "
    "input (search terms, usernames, quantities) — click it, type it, press Enter; null for plain clicks. "
    "You can do this instead of, or alongside, a box_id click."
    "where payment=true only if the box is a Checkout, Pay, Buy or Place-Order button, "
    "price is the amount it would charge (null when not a payment), is_totp_field=true only if "
    "the box is a two-factor/authenticator code input (6-digit OTP entry), and domain is the "
    "site the TOTP code would authenticate (null otherwise). "
    "Use message_to_user to report findings (e.g., flight prices, search results), ask a "
    "clarifying question, or explain that you cannot find the target box — instead of, or "
    "alongside, a box_id click."
)
#: Seconds the runner waits for a manually provided 2FA code before skipping the field.
CODE_TIMEOUT = int(os.environ.get("COCO_CODE_TIMEOUT", "120"))


def _strip_think(raw: str) -> str:
    """Drop chain-of-thought blocks from a (possibly chatty) VLM reply."""
    return re.sub("<" + "think" + r"[\\s\\S]*?<" + "</think>", "", raw, flags=re.DOTALL)


def parse_box_id(raw: str) -> Optional[int]:
    """First integer in a (possibly chatty) VLM reply; strips think blocks first."""
    m = re.search(r"\b(\d{1,4})\b", _strip_think(raw))
    return int(m.group(1)) if m else None


def parse_decision(raw: str) -> dict[str, Any]:
    """VLM reply -> {"box_id", "payment", "price", "is_totp_field", "domain"}; integer fallback."""
    clean = _strip_think(str(raw))
    m = re.search(r"\{[^{}]*\}", clean)
    if m:
        try:
            d = json.loads(m.group(0))
            try:
                box_id = int(d["box_id"]) if d.get("box_id") is not None else None  # message-only replies omit it
            except (ValueError, KeyError, TypeError):
                box_id = None
            return {"box_id": box_id, "payment": bool(d.get("payment")), "price": d.get("price"),
                    "is_totp_field": bool(d.get("is_totp_field")), "domain": d.get("domain"),
                    "message_to_user": d.get("message_to_user"), "type_query": d.get("type_query")}
        except (ValueError, KeyError, TypeError):
            pass
    return {"box_id": parse_box_id(clean), "payment": False, "price": None, "is_totp_field": False, "domain": None,
            "message_to_user": None, "type_query": None}


def query_cloud_vlm(annotated_path: str, goal: str, model: Optional[str] = None) -> dict[str, Any]:
    """SoM-annotated frame → active cloud VLM (LiteLLM) → winning box ID."""
    model = model or load_model_config()
    if os.environ.get("COCO_FAKE_VLM"):  # hermetic testing — stubs the cloud call; JSON value shapes the decision, "1" = payment ask
        payload = os.environ["COCO_FAKE_VLM"] if os.environ["COCO_FAKE_VLM"] != "1" else '{"box_id": 1, "payment": true, "price": "$450"}'
        return {"tier": "cloud_vlm", "model": "fake", "raw": "stubbed", **parse_decision(payload)}
    with open(annotated_path, "rb") as f:
        png_b64 = base64.b64encode(f.read()).decode("ascii")
    import litellm

    resp = litellm.completion(
        model=model,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT.format(goal=goal)},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Which box ID is the target? Return only the JSON."},
                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{png_b64}"}},
                ],
            },
        ],
        max_tokens=2048,  # thinking-mode models burn budget reasoning — 512 starved the answer out
    )
    msg = resp["choices"][0]["message"]
    raw = msg["content"] or ""
    if not raw.strip():
        # thinking-mode models (Ollama reasoning) keep the answer in reasoning_content
        raw = getattr(msg, "reasoning_content", None) or msg.get("reasoning_content", "") or ""
    hitl = parse_decision(str(raw))
    box_id = hitl["box_id"]
    print(f"[agent] cloud vlm ({model}): box_id={box_id} payment={hitl['payment']}", file=sys.stderr)
    return {"tier": "cloud_vlm", "model": model, "box_id": box_id, "payment": hitl["payment"], "price": hitl["price"],
            "is_totp_field": hitl["is_totp_field"], "domain": hitl["domain"],
            "message_to_user": hitl["message_to_user"], "type_query": hitl["type_query"], "raw": str(raw).strip()[:200]}


def jpeg_for_telegram(png_path: str, max_w: int = 1280, quality: int = 80) -> str:
    """Retina PNGs choke on Telegram mobile — hand it a plain 72-DPI JPEG instead.

    macOS screenshots carry 144-DPI metadata; mobile Telegram clients fail to render
    full-quality variants of those blobs (blur + ✕). Stripping to 72 DPI fixed it
    (verified: upload-vs-metadata A/B/C/D/E/F/G isolation, 2026-10-18).
    """
    from PIL import Image

    img = Image.open(png_path)
    if img.width > max_w:
        img = img.resize((max_w, round(img.height * max_w / img.width)))
    out = str(png_path[:-4]) + ".jpg" if png_path.endswith(".png") else png_path + ".jpg"
    img.convert("RGB").save(out, "JPEG", quality=quality, dpi=(72, 72), icc_profile=None, exif=b"")
    return out


def decide(goal: str, source_path: Optional[str] = None, screenshot: Optional[np.ndarray] = None) -> dict[str, Any]:
    """One decision loop iteration: SoM annotate → cloud VLM → winner.

    Returns {"decision": .., "boxes": .., "annotated": path} — boxes is the SoM mapping;
    execution looks up center_x/center_y by box_id.
    """
    if screenshot is not None:
        boxes = annotate_som(screenshot=screenshot)
    else:
        boxes = annotate_som(source_path=source_path)

    # pyautogui moves in screen POINTS; SoM coords are PNG PIXELS of the capture — retina
    # captures are 2x, so raw coords land off-screen/wrong. Scale once here, use everywhere.
    import pyautogui

    screen_w, screen_h = pyautogui.size()
    img_h, img_w = (screenshot if screenshot is not None else cv2.imread(source_path)).shape[:2]
    sx, sy = screen_w / img_w, screen_h / img_h
    if abs(sx - 1.0) > 0.01 or abs(sy - 1.0) > 0.01:
        boxes = {
            k: {**v, "x_min": round(v["x_min"] * sx), "y_min": round(v["y_min"] * sy),
                "x_max": round(v["x_max"] * sx), "y_max": round(v["y_max"] * sy),
                "center_x": round(v["center_x"] * sx), "center_y": round(v["center_y"] * sy)}
            for k, v in boxes.items()
        }
        print(f"[agent] scaled SoM coords ×({sx:.2f}, {sy:.2f}) png→screen points", file=sys.stderr)

    # live feed: absolute path of the SoM-annotated frame, streamed so the gateway can sendPhoto it
    # ponytail: temp files accumulate until the OS clears /tmp — prune if runs stack up across days
    try:
        shot_path = jpeg_for_telegram(annotate_som.last_out_path)  # type: ignore[attr-defined]
    except Exception as e:  # Pillow hiccup — the raw PNG still beats no feed
        print(f"[agent] jpeg conversion failed ({e}) — sending PNG", file=sys.stderr)
        shot_path = annotate_som.last_out_path  # type: ignore[attr-defined]
    print(json.dumps({"type": "screenshot", "path": shot_path}), flush=True)

    decision = query_cloud_vlm(annotate_som.last_out_path, goal)  # type: ignore[attr-defined]
    if decision.get("message_to_user"):  # two-way chat: VLM has findings/questions for the user
        print(json.dumps({"type": "chat", "message": decision["message_to_user"]}), flush=True)
    elif not decision.get("box_id"):
        # silent misses felt black-hole-y — always say something when nothing was found
        print(json.dumps({"type": "chat", "message": f'I could not find "{goal}" on this screen yet — nothing matched. I will keep looking.'}), flush=True)
    box = boxes.get(str(decision.get("box_id")))
    decision["action"] = "CLICK" if (box and decision.get("box_id")) else None
    decision["coordinates"] = box
    return decision


def handle_totp(decision: dict[str, Any], task_id: Optional[int]) -> None:
    """2FA field flow: vault code → click + type; no seed → ask the user for the code."""
    from tools.vault import get_code

    domain = decision.get("domain") or "unknown-domain"
    box = decision.get("coordinates")
    if not box:
        return
    code = get_code(domain)
    if not code:
        # no seed in the vault — ask the user (gateway relays this to WhatsApp/Telegram and writes
        # the reply into pending_codes; we wait for it, then fall back to skipping)
        print(f"[agent] no TOTP seed in vault for {domain} — ask the user for the code", file=sys.stderr)
        print(json.dumps({"type": "code_required", "task_id": task_id, "domain": domain}), flush=True)
        if not task_id:
            return  # standalone run — nothing to wait on
        code = wait_manual_code(task_id, domain)
        if not code:
            print(f"[agent] no 2FA code within {CODE_TIMEOUT}s — skipping {domain} field", file=sys.stderr)
            return
    if not CLICK_GATE:
        print(f"[agent] dry-run (COCO_AGENT_CLICK unset) — would click box and type {code}", file=sys.stderr)
        return
    human_click(box)
    human_pause(0.4, 0.8)
    human_type(code)
    print(f"[agent] typed 2FA code for {domain} at ({box['center_x']}, {box['center_y']})", file=sys.stderr)


FILL_PROMPT = (
    "You are an autonomous checkout agent. The screenshot has numbered bounding boxes over "
    "form fields. Match each card data point below to the box_id of the field it should be typed "
    "into: PAN (card number), CVV (security code) and EXP (expiry MM/YY). "
    'Return strictly JSON: {"mappings": [{"field": "PAN"|"CVV"|"EXP", "box_id": <int>}]}'
)


def parse_fill(raw: str, card: dict[str, str]) -> list[dict[str, Any]]:
    """VLM reply → ordered [{"field", "box_id", "value"}]; drops unknown fields and bad boxes."""
    clean = _strip_think(str(raw))
    m = re.search(r"\[[\s\S]*\]", clean) or re.search(r"\{[\s\S]*\}", clean)
    if not m:
        return []
    try:
        parsed = json.loads(m.group(0))
        mappings = parsed["mappings"] if isinstance(parsed, dict) else parsed
        typed = [(str(mm["field"]).upper(), int(mm["box_id"])) for mm in mappings]
    except (ValueError, KeyError, TypeError):
        return []
    values = {"PAN": card["pan"], "CVV": card["cvv"], "EXP": f"{card['exp_month']}/{card['exp_year'][-2:]}"}
    return [{"field": f, "box_id": b, "value": values[f]} for f, b in typed if f in values]


def map_card_fields(annotated_path: str, card: dict[str, str], model: Optional[str] = None) -> list[dict[str, Any]]:
    """Second VLM pass: which numbered box takes PAN / CVV / EXP on this checkout screen."""
    model = model or load_model_config()
    if os.environ.get("COCO_FAKE_FILL"):  # hermetic testing — fixture mappings, no cloud call
        return parse_fill(f'{{"mappings": {os.environ["COCO_FAKE_FILL"]}}}', card)
    with open(annotated_path, "rb") as f:
        png_b64 = base64.b64encode(f.read()).decode("ascii")
    import litellm

    resp = litellm.completion(
        model=model,
        messages=[
            {"role": "system", "content": FILL_PROMPT},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": f"Card data points:\nPAN: {card['pan']}\nCVV: {card['cvv']}\nEXP: {card['exp_month']}/{card['exp_year'][-2:]}"},
                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{png_b64}"}},
                ],
            },
        ],
        max_tokens=2048,  # thinking-mode models burn budget reasoning — 512 starved the answer out
    )
    msg = resp["choices"][0]["message"]
    raw = msg["content"] or ""
    if not raw.strip():
        raw = getattr(msg, "reasoning_content", None) or msg.get("reasoning_content", "") or ""
    mappings = parse_fill(str(raw), card)
    print(f"[agent] fill mapping: {[(mm['field'], mm['box_id']) for mm in mappings]}", file=sys.stderr)
    return mappings


def fill_card_flow(decision: dict[str, Any], boxes: dict[str, dict[str, int]], annotated_path: str) -> None:
    """Approved checkout: generate a capped virtual card, let the VLM locate the fields, type it.

    Emits {"type": "card_filled", "fields": [...box ids only...]} — PAN/CVV never go to stdout.
    """
    from tools.payment import generate_virtual_card

    price = decision.get("price")
    if not price:
        print("[agent] payment step approved but the VLM found no price — skipping card fill", file=sys.stderr)
        return
    if os.environ.get("COCO_FAKE_PRIVACY"):  # hermetic testing — no real card issued
        card = {"pan": "4111111111111111", "cvv": "123", "exp_month": "09", "exp_year": "2027", "spend_limit": 4950}
    else:
        card = generate_virtual_card(price)
    print(f"[agent] virtual card issued: spend_limit={card['spend_limit']} cents, **{card['pan'][-4:]}", file=sys.stderr)
    mappings = map_card_fields(annotated_path, card)
    print(json.dumps({"type": "card_mapped", "fields": [{"field": mm["field"], "box_id": mm["box_id"]} for mm in mappings]}), flush=True)
    for mm in mappings:
        box = boxes.get(str(mm["box_id"]))
        if not box:
            print(f"[agent] fill mapping points at missing box {mm['box_id']} — skipped", file=sys.stderr)
            continue
        if not CLICK_GATE:
            print(f"[agent] dry-run (COCO_AGENT_CLICK unset) — would click box {mm['box_id']} and type {mm['field']}", file=sys.stderr)
            continue
        human_click(box)
        human_pause(0.3, 0.7)
        human_type(mm["value"])
    typed = [mm["field"] for mm in mappings if boxes.get(str(mm["box_id"]))]
    print(json.dumps({"type": "card_filled", "fields": typed}), flush=True)


def human_pause(lo: float = 0.25, hi: float = 0.7) -> None:
    """Random rest between gestures — fixed intervals are the classic bot tell."""
    time.sleep(random.uniform(lo, hi))


def human_click(box: dict[str, int]) -> None:
    """OS-level click with ±3px jitter (identical-pixel clicks read as automation)."""
    import pyautogui

    x = box["center_x"] + random.randint(-3, 3)
    y = box["center_y"] + random.randint(-3, 3)
    human_pause()
    pyautogui.moveRel(0, 0)  # wake the pointer first
    pyautogui.moveTo(x, y, duration=random.uniform(0.1, 0.25))
    pyautogui.click(x, y)


def human_type(text: str) -> None:
    """Typed with per-keystroke randomized intervals, not a constant drip."""
    import pyautogui

    pyautogui.write(text, interval=random.uniform(0.05, 0.11))


def execute_typing(text: str, box: dict[str, int]) -> str:
    """Click a field, type the query, press Enter — same COCO_AGENT_CLICK gate as clicks."""
    if not CLICK_GATE:
        print(f"[agent] dry-run (COCO_AGENT_CLICK unset) — would click box, type '{text}', press Enter", file=sys.stderr)
        return "dry-run"
    human_click(box)
    human_pause(0.4, 0.9)
    human_type(text)
    time.sleep(random.uniform(0.2, 0.5))
    import pyautogui

    pyautogui.press("enter")
    print(f"[agent] typed '{text}' + Enter at ({box['center_x']}, {box['center_y']})", file=sys.stderr)
    return "typed"


def execute_click(box: Optional[dict[str, int]]) -> str:
    """Execution bridge gatekeeper: OS-level click on the box center, gated by COCO_AGENT_CLICK."""
    if not box:
        print("[agent] no target box — execution skipped", file=sys.stderr)
        return "skipped"
    x, y = box["center_x"], box["center_y"]
    if not CLICK_GATE:
        print(f"[agent] dry-run (COCO_AGENT_CLICK unset) — would click ({x}, {y})", file=sys.stderr)
        return "dry-run"
    human_click(box)
    print(f"[agent] clicked ({x}, {y})", file=sys.stderr)
    return "clicked"


def _self_check() -> None:
    """Offline checks: box-ID parsing + SoM → coords → click bridge. No network, no key."""
    assert parse_box_id("12") == 12
    assert parse_box_id("<" + "think" + ">hmm<" + "/thi" + "nk>answer is box 7") == 7
    assert parse_box_id("no number here") is None
    d = parse_decision('{"box_id": 13, "payment": true, "price": "$450"}')
    assert (d["box_id"], d["payment"], d["price"], d["is_totp_field"], d["domain"]) == (13, True, "$450", False, None), d
    d = parse_decision('{"box_id": 9, "payment": false, "price": null, "is_totp_field": true, "domain": "github.com"}')
    assert d["is_totp_field"] and d["domain"] == "github.com", d
    d = parse_decision("box 7")
    assert d["box_id"] == 7 and d["payment"] is False and d["price"] is None, d
    # approval poll against a throwaway ledger: status flips → verdict
    import sqlite3
    import tempfile
    tmp_db = os.path.join(tempfile.gettempdir(), "agent_check_tasks.db")
    if os.path.exists(tmp_db):
        os.unlink(tmp_db)
    conn = sqlite3.connect(tmp_db)
    conn.execute("CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, phone_number TEXT, goal TEXT, status TEXT, created_at DATETIME)")
    cur = conn.execute("INSERT INTO tasks (phone_number, goal, status, created_at) VALUES ('x', 'g', 'running', datetime('now'))")
    conn.commit()
    os.environ["COCO_DB_PATH"] = tmp_db
    import threading
    globals().update(DB_PATH=tmp_db)
    task_id = cur.lastrowid
    conn.close()  # drop the writer lock — the Timer flips status via its own connection

    def flip():
        wc = sqlite3.connect(tmp_db)
        wc.execute("UPDATE tasks SET status='approved' WHERE id=?", (task_id,))
        wc.commit()
        wc.close()

    t = threading.Timer(4.0, flip)
    t.start()
    assert wait_approval(task_id, timeout=30) == "approved", "approval poll failed"
    t.join()
    card = {"pan": "4111111111111111", "cvv": "123", "exp_month": "09", "exp_year": "2027"}
    ff = parse_fill('{"mappings": [{"field": "PAN", "box_id": 1}, {"field": "CVV", "box_id": 2}, {"field": "EXP", "box_id": 3}]}', card)
    assert [m["field"] for m in ff] == ["PAN", "CVV", "EXP"] and ff[2]["value"] == "09/27", ff
    assert parse_fill('{"mappings": [{"field": "GARBAGE", "box_id": 1}]}', card) == [], "unknown field slipped through"
    assert parse_fill("no json here", card) == [], "junk reply slipped through"
    canvas = np.full((480, 640, 3), 255, dtype=np.uint8)
    for (bx, by, bw_, bh_) in [(40, 40, 120, 40), (40, 120, 120, 40), (40, 200, 300, 40)]:
        cv2.rectangle(canvas, (bx, by), (bx + bw_, by + bh_), (160, 160, 160), 2)
    boxes = annotate_som(screenshot=canvas)
    assert all(c["x_min"] <= c["center_x"] <= c["x_max"] for c in boxes.values()), "center outside box"
    decision = {"box_id": parse_box_id(str(next(iter(boxes)))), "coordinates": boxes.get(next(iter(boxes)))}
    assert decision["box_id"] is not None and decision["coordinates"] is not None, "box→coords mapping broken"
    r = execute_click(decision["coordinates"])
    assert r == "dry-run", f"gate leak: {r}"
    print("[agent] self-check ✓ — parsing, SoM geometry, box→coords→bridge", file=sys.stderr)


classify = decide  # alias for agent-loop imports


if __name__ == "__main__":
    p = argparse.ArgumentParser(description="Coco BYOK SoM runner")
    p.add_argument("mode", choices=["decide", "run"], nargs="?", default=None, help="decide = one decision; run = live screen decisions")
    p.add_argument("--image", help="screenshot path (decide mode; default live capture)")
    p.add_argument("--goal", default="Explore the current page", help="natural-language goal for the agent")
    p.add_argument("--steps", type=int, default=3, help="number of decisions in run mode")
    p.add_argument("--task-id", type=int, default=None, help="ledger task id; enables waiting on HitL approval for payment steps")
    p.add_argument("--check", action="store_true", help="run the self-check and exit")
    args = p.parse_args()

    try:
        if args.check:
            _self_check()
        elif args.mode == "decide":
            decision = decide(args.goal, source_path=args.image)
            print(json.dumps({"decision": decision, "boxes": annotate_som.last_out_boxes}))  # type: ignore[attr-defined]
        else:
            for i in range(args.steps):
                shot = capture_screen()
                decision = decide(args.goal, screenshot=shot)
                if decision.get("is_totp_field"):
                    handle_totp(decision, args.task_id)
                if decision.get("payment") and args.task_id:
                    # HitL gate: announce and hold until the ledger status flips
                    print(json.dumps({"type": "approval_required", "task_id": args.task_id,
                                      "price": decision.get("price"), "step": i + 1}), flush=True)
                    verdict = wait_approval(args.task_id)
                    print(f"[agent] approval verdict: {verdict}", file=sys.stderr)
                    if verdict != "approved":
                        print(json.dumps({"type": "approval_result", "task_id": args.task_id, "verdict": verdict}), flush=True)
                        if verdict == "denied":
                            break  # user cancelled the task — stop stepping
                        continue  # timeout — skip this click, keep the loop alive
                    fill_card_flow(decision, annotate_som.last_out_boxes, annotate_som.last_out_path)  # type: ignore[attr-defined]
                if decision.get("type_query") and decision.get("coordinates"):
                    execute_typing(decision["type_query"], decision["coordinates"])
                else:
                    execute_click(decision.get("coordinates"))
                print(json.dumps({"step": i + 1, "decision": decision, "boxes": annotate_som.last_out_boxes}))
                time.sleep(1.0)
    except FileNotFoundError as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(2)
    except KeyboardInterrupt:
        sys.exit(130)