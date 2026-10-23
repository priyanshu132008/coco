#!/bin/sh
# OpenInstinct Render boot — every step prints, so a silent death is impossible to miss.
echo "[entry] container boot: $(date -u +%H:%M:%SZ)"
command -v python3 || echo "[entry] WARNING: python3 missing from PATH"
command -v Xvfb >/dev/null || echo "[entry] WARNING: Xvfb missing (apt xvfb not installed?)"
echo "[entry] starting Xvfb on :99"
# same-container restarts leave the previous server's lock/socket behind and Xvfb then
# refuses ("Server is already active for display 99") — clear both, precisely (the .X11-unix
# dir must survive), and retry: a dead display makes every browser launch hang
XVFB_UP=0
for _try in 1 2 3; do
  rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
  Xvfb :99 -screen 0 1280x720x24 -nolisten tcp -noreset &
  sleep 1
  if ls /tmp/.X11-unix/X99 >/dev/null 2>&1; then
    XVFB_UP=1
    break
  fi
  echo "[entry] WARNING: Xvfb did not come up (attempt ${_try}/3), clearing staleness and retrying"
  kill %1 2>/dev/null || true
  sleep 1
done
if [ "$XVFB_UP" != "1" ]; then
  echo "[entry] FATAL: no X display after 3 attempts — browser tasks will fail fast"
fi
ls /tmp/.X11-unix/ 2>/dev/null && echo "[entry] X socket present" || echo "[entry] WARNING: no X socket in /tmp/.X11-unix"
export DISPLAY=:99
echo "[entry] exec worker (PORT=${PORT:-unset})"
exec python3 tools/worker.py