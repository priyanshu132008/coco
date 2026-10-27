"""Agent Reach bridge: subprocess wrapper over the `agent-reach <channel> <action> [args]`
CLI (https://github.com/Panniantong/agent-reach). Fast-path structured extraction for
YouTube / social platforms — a read task skips booting the visual browser entirely.
The CLI prints one JSON object per command: read `ok`, `result`/`items`, `error.hint`."""

import json
import os
import shutil
import subprocess
import sys

#: uv tool install puts it in ~/.local/bin, which the gateway's env may not carry.
REACH_BIN = (
    os.environ.get("COCO_AGENT_REACH_BIN")
    or shutil.which("agent-reach")
    or os.path.expanduser("~/.local/bin/agent-reach")
)
TIMEOUT = int(os.environ.get("COCO_AGENT_REACH_TIMEOUT", "120"))
#: the LLM digests this into its final chat message — a full transcript dump overflows it
MAX_OUT = 12000

FALLBACK = "fall back to normal browser steps"


def query_agent_reach(channel: str, action: str, target: str) -> str:
    """Run `agent-reach <channel> <action> <target>` and return readable output.

    Returns the CLI's result/items as compact JSON on success; on failure, the CLI's own
    error message + hint (missing channel, login prompt, timeout) phrased so the agent
    knows to fall back to browser steps. Never raises.
    """
    if not os.path.exists(REACH_BIN):
        return (
            f"agent-reach is not installed on this machine (looked for {REACH_BIN}) — {FALLBACK}."
        )
    channel, action, target = (channel or "").strip().lower(), (action or "").strip().lower(), (target or "").strip()
    if not (channel and action and target):
        return (
            "usage: query_agent_reach(channel, action, target) — channel (e.g. 'youtube'), "
            "action (e.g. 'search', 'read', 'subtitle'), target (query, id or full link); all required."
        )
    # argv list, no shell — the target can carry spaces and links without shell risk
    try:
        proc = subprocess.run(
            [REACH_BIN, channel, action, target],
            capture_output=True,
            text=True,
            timeout=TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        return f"agent-reach {channel} {action} timed out after {TIMEOUT}s — {FALLBACK}."
    except OSError as e:
        return f"agent-reach {channel} {action} could not launch: {e} — {FALLBACK}."

    try:
        payload = json.loads((proc.stdout or "").strip() or "{}")
    except ValueError:
        raw = ((proc.stderr or "") + (proc.stdout or "")).strip()
        return f"agent-reach {channel} {action} failed (exit {proc.returncode}): {raw[:500] or 'no output'} — {FALLBACK}."

    if not payload.get("ok"):
        err = payload.get("error") or {}
        message = err.get("message") if isinstance(err, dict) else str(err)
        hint = err.get("hint") if isinstance(err, dict) else None
        # login / not-added channels surface here with the exact command in the hint
        return (
            f"agent-reach {channel} {action} failed: {message or 'unknown error'}"
            f"{'; ' + hint if hint else ''} — {FALLBACK} (a login prompt means the user must run "
            f"`agent-reach login {channel}` or `agent-reach add {channel}` themselves; do NOT wait for it)."
        )
    # success shape varies by command: {result: ...} (version/setup) or top-level items
    data = payload.get("result", payload.get("items"))
    if data is None:
        data = {k: v for k, v in payload.items() if k not in ("schema_version", "error", "meta")}
    text = data if isinstance(data, str) else json.dumps(data, ensure_ascii=False)
    return text[:MAX_OUT]


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--check":
        # offline: usage errors and a bogus channel must degrade to a readable message
        bad = query_agent_reach("", "search", "x")
        assert "usage:" in bad, bad
        nosuch = query_agent_reach("nosuchchannel", "search", "x")
        assert "unknown command or channel" in nosuch and FALLBACK in nosuch, nosuch
        # live: a real YouTube search through the bridge (network; skip with COCO_AGENT_REACH_OFFLINE=1)
        if os.environ.get("COCO_AGENT_REACH_OFFLINE"):
            print("[agent-reach] self-check ok (offline: error handling only)")
            sys.exit(0)
        live = query_agent_reach("youtube", "search", "Claude Code tutorial")
        assert '"title"' in live or "failed" in live, live
        print(f"[agent-reach] self-check ok — live youtube search:\n{live[:600]}")
        sys.exit(0)
    # default: run one query from the command line
    if len(sys.argv) < 4:
        print("usage: agent_reach_tool.py <channel> <action> <target>  |  --check", file=sys.stderr)
        sys.exit(2)
    print(query_agent_reach(sys.argv[1], sys.argv[2], " ".join(sys.argv[3:])))