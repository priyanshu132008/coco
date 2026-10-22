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

# font stack for the Windows-metrics fingerprint on a bare Linux VM — without it the
# cloak binary claims Windows while the canvas hashes to a font-less box (Kasada/Akamai)
RUN apt-get update && apt-get install -y --no-install-recommends \
    fonts-noto-color-emoji fonts-freefont-ttf fonts-unifont fonts-ipafont-gothic \
    fonts-wqy-zenhei fonts-tlwg-loma-otf xvfb \
    && rm -rf /var/lib/apt/lists/*

# bake the cloak chromium binary into the image (worker start must not download)
RUN python -m cloakbrowser install

# headless=True is detectable even with binary patches — under xvfb the browser is headed
ENV PYTHONUNBUFFERED=1 OI_HEADLESS=0
# Update CloakBrowser and Render Port Sync — CMD serves GET / on $PORT (Render health check)
EXPOSE 10000
# headed cloak browser (headless is detectable) on a virtual display
CMD ["xvfb-run", "-a", "python", "tools/worker.py"]