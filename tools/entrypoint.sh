#!/bin/sh
# OpenInstinct Render boot — every step prints, so a silent death is impossible to miss.
echo "[entry] container boot: $(date -u +%H:%M:%SZ)"
command -v python3 || echo "[entry] WARNING: python3 missing from PATH"
command -v Xvfb >/dev/null || echo "[entry] WARNING: Xvfb missing (apt xvfb not installed?)"
echo "[entry] starting Xvfb on :99"
Xvfb :99 -screen 0 1280x720x24 -nolisten tcp -noreset &
sleep 1
ls /tmp/.X11-unix/ 2>/dev/null && echo "[entry] X socket present" || echo "[entry] WARNING: no X socket in /tmp/.X11-unix"
export DISPLAY=:99
echo "[entry] exec worker (PORT=${PORT:-unset})"
exec python3 tools/worker.py