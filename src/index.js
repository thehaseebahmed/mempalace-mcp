import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { isInitializeRequest, ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync, execFile } from "node:child_process";
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PORT          = parseInt(process.env.MCP_PORT ?? "3000", 10);
const BASE_DIR      = process.env.BASE_DIR ?? "/data";
const PYTHON_BIN    = process.env.PYTHON_BIN ?? "/opt/mempalace-venv/bin/python";

const palaceDir = (userId) => join(BASE_DIR, userId, ".mempalace");
const contentHash = (obj) => createHash("sha256").update(JSON.stringify(obj)).digest("hex");

// Per-user subprocess clients: userId -> { client, toolParams: Map<toolName, Set<paramName>> }
const subprocessClients = new Map();

async function getClient(userId) {
  if (subprocessClients.has(userId)) return subprocessClients.get(userId);

  mkdirSync(palaceDir(userId), { recursive: true });
  execFileSync(PYTHON_BIN, ["-m", "mempalace", "init", "--yes", palaceDir(userId)], {
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });

  const transport = new StdioClientTransport({
    command: PYTHON_BIN,
    args: ["-m", "mempalace.mcp_server", "--palace", palaceDir(userId)],
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });

  const client = new Client({ name: "mempalace-gateway", version: "1.0.0" });
  await client.connect(transport);

  // Cache the set of valid param names per tool so we can strip injected extras (e.g. n8n's chatMessage).
  const { tools } = await client.listTools();
  const toolParams = new Map(
    tools.map((t) => [t.name, new Set(Object.keys(t.inputSchema?.properties ?? {}))])
  );

  subprocessClients.set(userId, { client, toolParams });
  console.log(`[subprocess] Started palace for user: ${userId} (${tools.length} tools)`);
  return subprocessClients.get(userId);
}

// Create a proxy MCP server that forwards all tool calls to the user's subprocess.
function createProxyServer(userId) {
  const server = new Server(
    { name: "mempalace-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      const { client } = await getClient(userId);
      return await client.listTools();
    } catch (err) {
      console.error(`[proxy] listTools failed for user ${userId}:`, err?.message ?? err);
      throw err;
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const { client, toolParams } = await getClient(userId);
      const toolName = request.params.name;
      const rawArgs = request.params.arguments ?? {};

      // Strip any extra params injected by the caller (e.g. n8n adds chatMessage).
      const allowed = toolParams.get(toolName);
      const args = allowed
        ? Object.fromEntries(Object.entries(rawArgs).filter(([k]) => allowed.has(k)))
        : rawArgs;

      return await client.callTool({ name: toolName, arguments: args });
    } catch (err) {
      return {
        content: [{ type: "text", text: err?.message ?? String(err) }],
        isError: true,
      };
    }
  });

  return server;
}

const app = express();
app.use(express.json());

// HTTP MCP sessions: sessionId -> StreamableHTTPServerTransport
const sessions = new Map();

// MCP endpoint scoped to a user: /mcp/:userId
app.post("/mcp/:userId", async (req, res) => {
  const { userId } = req.params;
  const sessionId = req.headers["mcp-session-id"];

  if (sessionId && sessions.has(sessionId)) {
    await sessions.get(sessionId).handleRequest(req, res, req.body);
    return;
  }

  if (!sessionId && isInitializeRequest(req.body)) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => { sessions.set(id, transport); },
      enableDnsRebindingProtection: false,
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    const server = createProxyServer(userId);
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  res.status(400).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Bad Request: missing or invalid session" },
    id: null,
  });
});

app.get("/mcp/:userId", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !sessions.has(sessionId)) { res.status(400).send("Invalid or missing session ID"); return; }
  await sessions.get(sessionId).handleRequest(req, res);
});

app.delete("/mcp/:userId", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !sessions.has(sessionId)) { res.status(400).send("Invalid or missing session ID"); return; }
  await sessions.get(sessionId).handleRequest(req, res);
});

// REST convenience endpoint
app.get("/users/:userId/wake-up", async (req, res) => {
  try {
    const { client } = await getClient(req.params.userId);
    const result = await client.callTool({ name: "mempalace_status", arguments: {} });
    const text = result.content?.map((c) => c.text).join("\n") ?? "";
    res.json({ data: text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/users/:userId/mine", async (req, res) => {
  const { userId } = req.params;
  const { id, jsonl } = req.body ?? {};

  if (!id || !Array.isArray(jsonl) || jsonl.length === 0) {
    return res.status(400).json({ error: "Request body must include id (string) and jsonl (non-empty array)" });
  }

  const targetDir = join(BASE_DIR, userId, id);
  const minedDir  = join(BASE_DIR, userId, `${id}-mined`);

  try {
    mkdirSync(targetDir, { recursive: true });

    for (const obj of jsonl) {
      writeFileSync(join(targetDir, `${contentHash(obj)}.jsonl`), JSON.stringify(obj) + "\n", "utf-8");
    }

    await getClient(userId);

    const { stdout, stderr } = await execFileAsync(
      PYTHON_BIN,
      ["-m", "mempalace", "--palace", palaceDir(userId), "mine", targetDir, "--mode", "convos", "--extract", "general"],
      { env: { ...process.env, PYTHONIOENCODING: "utf-8" }, maxBuffer: 10 * 1024 * 1024 },
    );

    renameSync(targetDir, minedDir);

    const output = [stdout, stderr].filter(Boolean).join("\n").trim();
    res.json({ data: output || "Transcript mined successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", base: BASE_DIR, activePalaces: subprocessClients.size, sessions: sessions.size });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[server] MCP gateway listening on http://0.0.0.0:${PORT}/mcp/:userId`);
  console.log(`[server] Base: ${BASE_DIR}`);
});
