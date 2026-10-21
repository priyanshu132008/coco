# OpenInstinct browser worker — the Python agent that runs on Render.
# Playwright's official image ships the browser + all system libs; we pin the pip
# playwright to MATCH the image so the preinstalled browser binaries are the ones used.
FROM mcr.microsoft.com/playwright/python:v1.64.0-noble

WORKDIR /app

COPY tools/requirements.txt tools/requirements.txt
RUN pip install --no-cache-dir -r tools/requirements.txt

# the driver, its modules and the model config (no secrets in config.json — keys come via env)
COPY tools/ tools/
COPY config.json config.json

# belt & suspenders: reassert the browsers for the exact pip playwright version
RUN python -m playwright install chromium

ENV PYTHONUNBUFFERED=1
CMD ["python", "tools/worker.py"]