# mempalace-mcp

An HTTP [Model Context Protocol (MCP)](https://modelcontextprotocol.io) gateway that wraps the [`mempalace`](https://pypi.org/project/mempalace/) Python CLI, providing per-user memory palaces over a stateful HTTP API.

## What it does

- Exposes an MCP endpoint at `POST /mcp/:userId`
- On first request for a user, spins up a dedicated `mempalace` subprocess (a Python MCP server) and keeps it alive in memory
- Proxies all MCP `tools/list` and `tools/call` requests to that user's subprocess, isolating each user's data under `/data/<userId>/.mempalace`
- Strips extra parameters injected by MCP clients (e.g. n8n's `chatMessage`) before forwarding tool calls

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/mcp/:userId` | MCP endpoint (initialize or resume session) |
| `GET` | `/mcp/:userId` | MCP SSE stream for active session |
| `DELETE` | `/mcp/:userId` | Close an MCP session |
| `GET` | `/users/:userId/wake-up` | Pre-warm a user's palace and return its status |
| `GET` | `/health` | Server health + active palace/session counts |

## Running

### Docker Compose (recommended)

Create a `docker-compose.yml`:

```yaml
version: "3.9"

services:
  mempalace-mcp:
    image: ghcr.io/thehaseebahmed/mempalace-mcp:latest
    container_name: mempalace-mcp
    user: "1000:1000"
    ports:
      - "3000:3000"
    volumes:
      - ./palace-data:/data
    environment:
      - BASE_DIR=/data
      - TRANSFORMERS_CACHE=/data/.cache/transformers
      - HF_HOME=/data/.cache/huggingface
    restart: unless-stopped
```

Then run:

```bash
docker compose up -d
```

Data is persisted to a `palace-data/` folder next to your `docker-compose.yml` (mapped to `/data` in the container).

### Local dev

```bash
npm run dev
```

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `MCP_PORT` | `3000` | Port to listen on |
| `BASE_DIR` | `/data` | Root directory for all user palace data |
| `PYTHON_BIN` | `/opt/mempalace-venv/bin/python` | Python binary with `mempalace` installed |

## Requirements

- Node.js >= 20
- Python 3.11 + `mempalace` pip package (handled automatically in Docker)
