FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3.11 \
      python3.11-venv \
      python3-pip \
      python3-dev \
      build-essential \
      curl \
    && rm -rf /var/lib/apt/lists/*

RUN update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.11 1 \
    && update-alternatives --install /usr/bin/python  python  /usr/bin/python3.11 1

RUN python3 -m venv /opt/mempalace-venv \
    && /opt/mempalace-venv/bin/pip install --no-cache-dir mempalace

ENV PATH="/opt/mempalace-venv/bin:$PATH"

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src/ ./src/

ENV MEMPALACE_DIR=/data/.mempalace
ENV MCP_PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "src/index.js"]
