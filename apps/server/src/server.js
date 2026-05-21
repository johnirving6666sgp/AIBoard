import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { runCommandById, runDispatchedCommands } from "./agent-adapters.js";
import { importAgentOutputs, startAgentOutputWatcher } from "./agent-output-importer.js";
import { createCommandDraft, dispatchCommand, queryCommands, updateCommandStatus } from "./command-service.js";
import { loadConfig } from "./config.js";
import { getStats, listArtifacts, listCandidateStatuses, upsertCandidateStatus } from "./db.js";
import { createEvent, getEventWithActions, queryEvents, setEventStatus } from "./event-service.js";
import { importInbox, startInboxWatcher } from "./inbox-importer.js";
import { rootDir, webDir } from "./paths.js";
import { seedIfEmpty } from "./seed.js";
import { getVaultImportStatus, getVaultSyncState, importVault, startVaultWatcher } from "./vault-importer.js";

const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";

await seedIfEmpty();
await importInbox();
await importAgentOutputs({ recentHours: 24 });
await importVault(await loadConfig()).catch((error) => {
  console.error("Initial Vault import failed:", error);
});
startInboxWatcher({ intervalMs: Number(process.env.INBOX_POLL_MS || 5000) });
startVaultWatcher(loadConfig);
startAgentOutputWatcher({ intervalMs: Number(process.env.AGENT_OUTPUT_POLL_MS || 15000) });

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    await serveStatic(res, url.pathname);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "Internal server error" });
  }
});

server.listen(port, host, () => {
  console.log(`AIBoard running at http://${host}:${port}`);
});

server.on("error", (error) => {
  console.error("AIBoard server error:", error);
  process.exitCode = 1;
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`Received ${signal}, shutting down AIBoard...`);
    server.close(() => {
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  });
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    const vault = getVaultSyncState();
    sendJson(res, 200, {
      ok: !["error", "stale"].includes(vault.status),
      service: {
        name: "AIBoard",
        uptimeSec: Math.round(process.uptime()),
        startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
        pid: process.pid,
        node: process.version
      },
      vault
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/stats") {
    sendJson(res, 200, getStats());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/import/inbox") {
    sendJson(res, 200, await importInbox());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/import/agents") {
    sendJson(res, 200, await importAgentOutputs({ recentHours: Number(url.searchParams.get("hours") || 24) }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/config") {
    const config = await loadConfig();
    sendJson(res, 200, redactConfig(config));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/import/vault") {
    sendJson(res, 200, getVaultImportStatus());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/import/vault") {
    sendJson(res, 200, await importVault(await loadConfig()));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    sendJson(res, 200, queryEvents(Object.fromEntries(url.searchParams)));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/commands") {
    sendJson(res, 200, queryCommands(Object.fromEntries(url.searchParams)));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/candidates/statuses") {
    sendJson(res, 200, listCandidateStatuses(url.searchParams.get("eventId")));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/candidates/statuses") {
    const body = await readJson(req);
    sendJson(res, 201, upsertCandidateStatus(body));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/commands") {
    const body = await readJson(req);
    sendJson(res, 201, await createCommandDraft(body));
    return;
  }

  const commandStatusMatch = url.pathname.match(/^\/api\/commands\/([^/]+)\/status$/);
  if (commandStatusMatch && req.method === "PATCH") {
    const body = await readJson(req);
    sendJson(res, 200, await updateCommandStatus(commandStatusMatch[1], body.status));
    return;
  }

  const commandDispatchMatch = url.pathname.match(/^\/api\/commands\/([^/]+)\/dispatch$/);
  if (commandDispatchMatch && req.method === "POST") {
    const result = await dispatchCommand(commandDispatchMatch[1]);
    if (!result) {
      sendJson(res, 404, { error: "Command not found" });
      return;
    }
    sendJson(res, 200, result);
    return;
  }

  const commandRunMatch = url.pathname.match(/^\/api\/commands\/([^/]+)\/run$/);
  if (commandRunMatch && req.method === "POST") {
    const result = await runCommandById(commandRunMatch[1]);
    if (!result) {
      sendJson(res, 404, { error: "Command not found" });
      return;
    }
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/adapters/run") {
    const openClawDrafts = queryCommands({ status: "draft", limit: 50 }).filter((command) => {
      return command.target === "openclaw" && command.payload?.status !== "done";
    });
    const dispatched = [];
    for (const command of openClawDrafts) {
      dispatched.push(await dispatchCommand(command.id));
    }
    const runResult = await runDispatchedCommands({ limit: 5, target: "openclaw" });
    sendJson(res, 200, { dispatched: dispatched.length, ...runResult });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/events") {
    const body = await readJson(req);
    const event = await createEvent(body);
    sendJson(res, 201, event);
    return;
  }

  const eventMatch = url.pathname.match(/^\/api\/events\/([^/]+)$/);
  if (eventMatch && req.method === "GET") {
    const event = getEventWithActions(eventMatch[1]);
    if (!event) {
      sendJson(res, 404, { error: "Event not found" });
      return;
    }
    sendJson(res, 200, event);
    return;
  }

  const statusMatch = url.pathname.match(/^\/api\/events\/([^/]+)\/status$/);
  if (statusMatch && req.method === "PATCH") {
    const body = await readJson(req);
    const event = await setEventStatus(statusMatch[1], body.status);
    if (!event) {
      sendJson(res, 404, { error: "Event not found" });
      return;
    }
    sendJson(res, 200, event);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/artifacts") {
    sendJson(res, 200, listArtifacts(Number(url.searchParams.get("limit") || 50)));
    return;
  }

  const markdownMatch = url.pathname.match(/^\/api\/markdown\/(.+)$/);
  if (markdownMatch && req.method === "GET") {
    const requested = decodeURIComponent(markdownMatch[1]);
    const absolute = path.resolve(rootDir, requested);
    if (!absolute.startsWith(rootDir)) {
      sendJson(res, 400, { error: "Invalid markdown path" });
      return;
    }
    const content = await fs.readFile(absolute, "utf8");
    sendText(res, 200, content, "text/markdown; charset=utf-8");
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

async function serveStatic(res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const absolute = path.resolve(webDir, `.${safePath}`);
  if (!absolute.startsWith(webDir)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  try {
    const file = await fs.readFile(absolute);
    res.writeHead(200, { "Content-Type": contentType(absolute) });
    res.end(file);
  } catch {
    const index = await fs.readFile(path.join(webDir, "index.html"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(index);
  }
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendText(res, status, text, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type });
  res.end(text);
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

function redactConfig(config) {
  return {
    ...config,
    vault: {
      ...config.vault,
      configured: Boolean(config.vault?.enabled && config.vault?.rootPath)
    }
  };
}
