import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getEvent, getVaultSnapshot, listVaultSnapshots, listVaultSyncRuns, recordVaultSyncRun, upsertVaultSnapshot } from "./db.js";
import { createEvent, updateEventFromSource } from "./event-service.js";
import { extractMarkdownTitle, parseFrontmatter } from "./inbox-importer.js";

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);
const MAX_BACKOFF_MS = 60000;
let vaultImportInProgress = false;
let vaultSyncState = {
  enabled: false,
  rootPath: "",
  pollMs: 15000,
  running: false,
  lastStartedAt: null,
  lastFinishedAt: null,
  lastOkAt: null,
  lastErrorAt: null,
  lastError: null,
  consecutiveFailures: 0,
  nextRunAt: null,
  lastSummary: null
};

export async function importVault(config) {
  const vault = config?.vault;
  const startedAt = new Date().toISOString();
  vaultSyncState = {
    ...vaultSyncState,
    enabled: Boolean(vault?.enabled),
    rootPath: vault?.rootPath || "",
    pollMs: Number(vault?.pollMs || 15000),
    running: true,
    lastStartedAt: startedAt
  };

  if (!vault?.enabled || !vault.rootPath) {
    const result = {
      enabled: false,
      imported: 0,
      skipped: 0,
      failed: 0,
      scanned: 0,
      results: [],
      message: "Vault import is disabled. Set vault.enabled and vault.rootPath in config/aiboard.config.json."
    };
    finishVaultSyncRun({ status: "disabled", startedAt, rootPath: vault?.rootPath || "", result });
    return result;
  }

  if (vaultImportInProgress) {
    vaultSyncState.running = true;
    return { enabled: true, imported: 0, skipped: 0, failed: 0, scanned: 0, busy: true, results: [] };
  }

  vaultImportInProgress = true;
  try {
    const rootPath = path.resolve(vault.rootPath);
    const files = await listVaultFiles(rootPath, vault);
    const results = [];

    for (const filePath of files) {
      results.push(await importVaultFile(rootPath, filePath, vault));
    }

    const result = summarizeResults(results);
    finishVaultSyncRun({ status: result.failed ? "degraded" : "ok", startedAt, rootPath, result });
    return result;
  } catch (error) {
    const result = {
      enabled: true,
      imported: 0,
      skipped: 0,
      failed: 1,
      scanned: 0,
      busy: false,
      results: [],
      error: error.message
    };
    finishVaultSyncRun({ status: "error", startedAt, rootPath: vault.rootPath, result });
    throw error;
  } finally {
    vaultImportInProgress = false;
    vaultSyncState.running = false;
  }
}

export function startVaultWatcher(getConfig, { intervalMs } = {}) {
  let timer;
  const tick = async () => {
    try {
      const config = await getConfig();
      const pollMs = Number(intervalMs || config?.vault?.pollMs || 15000);
      await importVault(config);
      timer = scheduleNext(tick, pollMs);
      timer.unref?.();
    } catch (error) {
      console.error("Vault import failed:", error);
      const baseMs = Number(intervalMs || vaultSyncState.pollMs || 15000);
      const backoffMs = Math.min(baseMs * 2 ** Math.min(vaultSyncState.consecutiveFailures, 4), MAX_BACKOFF_MS);
      timer = scheduleNext(tick, backoffMs);
      timer.unref?.();
    }
  };

  timer = setTimeout(tick, 1500);
  timer.unref?.();
  return () => clearTimeout(timer);
}

export function getVaultImportStatus() {
  const latestRun = listVaultSyncRuns(1)[0] || null;
  return {
    sync: getVaultSyncState(),
    latestRun,
    runs: listVaultSyncRuns(10),
    snapshots: listVaultSnapshots(20)
  };
}

export function getVaultSyncState() {
  const latestRun = listVaultSyncRuns(1)[0] || null;
  const lastFinishedAt = vaultSyncState.lastFinishedAt || latestRun?.finishedAt || null;
  const ageMs = lastFinishedAt ? Date.now() - new Date(lastFinishedAt).getTime() : null;
  const pollMs = Number(vaultSyncState.pollMs || 15000);
  const stale = Boolean(ageMs !== null && ageMs > pollMs * 4);
  const status = computeSyncStatus({ stale, latestRun });

  return {
    ...vaultSyncState,
    status,
    stale,
    ageMs,
    latestRun
  };
}

function scheduleNext(tick, delayMs) {
  vaultSyncState.nextRunAt = new Date(Date.now() + delayMs).toISOString();
  return setTimeout(tick, delayMs);
}

function finishVaultSyncRun({ status, startedAt, rootPath, result }) {
  const finishedAt = new Date().toISOString();
  const failed = Number(result.failed || 0);
  const isHealthy = status === "ok" || status === "disabled";
  const nextFailures = isHealthy ? 0 : vaultSyncState.consecutiveFailures + 1;
  const run = {
    id: `vault_sync_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    status,
    rootPath,
    scanned: result.scanned || result.results?.length || 0,
    imported: (result.imported || 0) + (result.updated || 0),
    skipped: result.skipped || 0,
    failed,
    error: result.error || result.message || null,
    startedAt,
    finishedAt
  };

  recordVaultSyncRun(run);
  vaultSyncState = {
    ...vaultSyncState,
    running: false,
    lastFinishedAt: finishedAt,
    lastOkAt: isHealthy ? finishedAt : vaultSyncState.lastOkAt,
    lastErrorAt: isHealthy ? null : finishedAt,
    lastError: isHealthy ? null : (result.error || `${failed} 个文件同步失败`),
    consecutiveFailures: nextFailures,
    lastSummary: run
  };
}

function computeSyncStatus({ stale, latestRun }) {
  if (vaultSyncState.running) return "running";
  if (!vaultSyncState.enabled) return "disabled";
  if (vaultSyncState.consecutiveFailures >= 3) return "error";
  if (vaultSyncState.consecutiveFailures > 0 || latestRun?.status === "degraded") return "degraded";
  if (stale) return "stale";
  if (latestRun?.status === "ok" || vaultSyncState.lastOkAt) return "ok";
  return "unknown";
}

async function listVaultFiles(rootPath, vault) {
  const candidates = new Set();

  for (const relativePath of [vault.researchQueuePath, vault.trackingPath]) {
    if (relativePath) candidates.add(path.resolve(rootPath, relativePath));
  }

  for (const folder of vault.watchFolders || []) {
    if (!folder) continue;
    const folderPath = path.resolve(rootPath, folder);
    for (const filePath of await walkMarkdownFiles(folderPath).catch(() => [])) {
      candidates.add(filePath);
    }
  }

  return [...candidates].filter((filePath) => filePath.startsWith(rootPath)).sort();
}

async function walkMarkdownFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkMarkdownFiles(fullPath));
    } else if (entry.isFile() && MARKDOWN_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }

  return files;
}

async function importVaultFile(rootPath, filePath, vault, { force = false } = {}) {
  const vaultPath = path.relative(rootPath, filePath);

  try {
    const content = await fs.readFile(filePath, "utf8");
    const contentHash = hashContent(content);
    const existing = getVaultSnapshot(vaultPath);

    if (!force && existing?.content_hash === contentHash) {
      return { vaultPath, status: "skipped", reason: "unchanged" };
    }

    const input = parseVaultFile(vaultPath, content, vault);
    if (!shouldCreateVaultEvent(input, vaultPath)) {
      upsertVaultSnapshot({ vaultPath, contentHash, eventId: existing?.event_id || null });
      return { vaultPath, status: "skipped", reason: "low-signal-vault-file" };
    }

    // 同一路径已有事件：更新原事件，避免每次内容变化都生成重复卡片。
    const existingEvent = existing?.event_id ? getEvent(existing.event_id) : null;
    if (existingEvent) {
      const updated = await updateEventFromSource(existingEvent, input);
      upsertVaultSnapshot({ vaultPath, contentHash, eventId: existingEvent.id });
      return { vaultPath, status: "updated", eventId: existingEvent.id, title: updated.title };
    }

    const event = await createEvent(input);
    upsertVaultSnapshot({ vaultPath, contentHash, eventId: event.id });
    return { vaultPath, status: "imported", eventId: event.id, title: event.title };
  } catch (error) {
    return { vaultPath, status: "failed", error: error.message };
  }
}

// 单文件强制重读：绕过 content_hash 短路，用于外部脚本修复文件后立即刷新。
export async function reimportVaultFile(config, vaultPathInput) {
  const vault = config?.vault;
  if (!vault?.enabled || !vault.rootPath) {
    return { ok: false, error: "Vault import is disabled." };
  }

  const rootPath = path.resolve(vault.rootPath);
  const requested = String(vaultPathInput || "").trim();
  if (!requested) {
    return { ok: false, error: "vaultPath is required." };
  }

  const absolute = path.resolve(rootPath, requested);
  if (absolute !== rootPath && !absolute.startsWith(rootPath + path.sep)) {
    return { ok: false, error: "vaultPath is outside the vault root." };
  }

  const result = await importVaultFile(rootPath, absolute, vault, { force: true });
  return { ok: result.status !== "failed", ...result };
}

function parseVaultFile(vaultPath, content, vault) {
  const { frontmatter, body } = parseFrontmatter(content);
  const type = frontmatter.type || inferVaultType(vaultPath, vault);
  const cleanedBody = cleanVaultBody(body.trim() || content.trim(), type);
  const title = frontmatter.title || inferVaultTitle(vaultPath, cleanedBody, type) || path.basename(vaultPath, path.extname(vaultPath));
  const priority = frontmatter.priority || (type === "research_queue" ? "high" : "normal");

  return {
    ...frontmatter,
    source: "vault",
    actor: "Vault",
    type,
    priority,
    title,
    summary: frontmatter.summary,
    rawContent: cleanedBody,
    vaultPath,
    tags: [
      ...new Set([
        ...(Array.isArray(frontmatter.tags) ? frontmatter.tags : []),
        "vault",
        type
      ])
    ]
  };
}

function inferVaultType(vaultPath, vault) {
  if (vaultPath === vault.researchQueuePath || vaultPath.includes("研究队列")) return "research_queue";
  if (vaultPath === vault.trackingPath || vaultPath.includes("持仓") || vaultPath.toLowerCase().includes("tracking")) {
    return "tracking_update";
  }
  if (vaultPath.startsWith("A股研究/日报")) return "cn_market_report";
  if (vaultPath.includes("龙头评分池")) return "limit_up_report";
  if (vaultPath.startsWith("A股研究")) return "cn_market_report";
  if (vaultPath.startsWith("美股研究")) return "us_market_report";
  if (vaultPath.startsWith("港股研究")) return "hk_market_report";
  if (vaultPath.startsWith("日股研究")) return "jp_market_report";
  if (vaultPath.startsWith("operations")) return "system_report";
  if (vaultPath.startsWith("companies")) return "artifact";
  if (vaultPath.startsWith("sectors")) return "finding";
  if (vaultPath.startsWith("governor")) return "task";
  return "finding";
}

function inferVaultTitle(vaultPath, body, type) {
  if (type === "research_queue") return "研究队列更新";
  if (type === "tracking_update") return "持仓与跟踪";
  return extractMarkdownTitle(body);
}

function shouldCreateVaultEvent(input, vaultPath) {
  if ([
    "research_queue",
    "tracking_update",
    "finding",
    "task",
    "question",
    "alert",
    "decision",
    "cn_market_report",
    "limit_up_report",
    "us_market_report",
    "hk_market_report",
    "jp_market_report",
    "system_report"
  ].includes(input.type)) {
    return Boolean(input.rawContent.trim());
  }

  if (input.type !== "artifact") return true;
  const tags = input.tags || [];
  const hasExplicitSignal = tags.some((tag) => ["aiboard", "research", "decision", "tracking", "queue"].includes(String(tag).toLowerCase()));
  return hasExplicitSignal || /研究|决策|跟踪|催化剂|风险|OpenClaw|Hermes/i.test(input.rawContent.slice(0, 1200));
}

function cleanVaultBody(body, type) {
  if (type !== "research_queue") return body;

  const lines = body.split(/\r?\n/);
  const kept = [];
  let inShellBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^#\s*(Adding|Appending)\b/i.test(trimmed)) {
      inShellBlock = true;
      continue;
    }
    if (/^(if\s+!?\s*grep\b|then\b|fi\b|cat\s+>>|echo\s+['"]?\||ENTRIES\b)/.test(trimmed)) {
      inShellBlock = true;
      continue;
    }
    if (inShellBlock && /^\|/.test(trimmed)) {
      kept.push(line);
      continue;
    }
    if (inShellBlock && !trimmed) continue;
    inShellBlock = false;
    kept.push(line);
  }

  return kept
    .join("\n")
    .replace(/^\d+\|\|/gm, "|")
    .replace(/\|#\s*(Adding|Appending)\b.*$/gim, "|")
    .replace(/\|\s*#\s*Adding the header if missing[\s\S]*?(?=\n\| |$)/i, "|")
    .trim();
}

function hashContent(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function summarizeResults(results) {
  return {
    enabled: true,
    imported: results.filter((item) => item.status === "imported").length,
    updated: results.filter((item) => item.status === "updated").length,
    skipped: results.filter((item) => item.status === "skipped").length,
    failed: results.filter((item) => item.status === "failed").length,
    scanned: results.length,
    busy: false,
    results
  };
}
