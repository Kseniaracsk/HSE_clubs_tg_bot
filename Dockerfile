
FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       python3 python3-venv python3-pip build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    else \
      npm install --omit=dev; \
    fi

COPY requirements.txt ./requirements.txt

RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PATH="/opt/venv/bin:$PATH"

CMD ["bash", "-lc", "case \"$SERVICE_MODE\" in miniapp) exec npm start ;; bot) test -n \"$BOT_ENTRYPOINT\" || { echo 'Set BOT_ENTRYPOINT'; exit 1; }; exec python \"$BOT_ENTRYPOINT\" ;; *) echo 'Set SERVICE_MODE=miniapp or bot'; exit 1 ;; esac"]
