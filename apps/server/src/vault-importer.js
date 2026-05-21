import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getVaultSnapshot, listVaultSnapshots, upsertVaultSnapshot } from "./db.js";
import { createEvent } from "./event-service.js";
import { extractMarkdownTitle, parseFrontmatter } from "./inbox-importer.js";

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);
let vaultImportInProgress = false;

export async function importVault(config) {
  const vault = config?.vault;
  if (!vault?.enabled || !vault.rootPath) {
    return {
      enabled: false,
      imported: 0,
      skipped: 0,
      failed: 0,
      results: [],
      message: "Vault import is disabled. Set vault.enabled and vault.rootPath in config/aiboard.config.json."
    };
  }

  if (vaultImportInProgress) {
    return { enabled: true, imported: 0, skipped: 0, failed: 0, busy: true, results: [] };
  }

  vaultImportInProgress = true;
  try {
    const rootPath = path.resolve(vault.rootPath);
    const files = await listVaultFiles(rootPath, vault);
    const results = [];

    for (const filePath of files) {
      results.push(await importVaultFile(rootPath, filePath, vault));
    }

    return summarizeResults(results);
  } finally {
    vaultImportInProgress = false;
  }
}

export function startVaultWatcher(getConfig, { intervalMs } = {}) {
  let timer;
  const tick = async () => {
    try {
      const config = await getConfig();
      const pollMs = Number(intervalMs || config?.vault?.pollMs || 15000);
      await importVault(config);
      timer = setTimeout(tick, pollMs);
      timer.unref?.();
    } catch (error) {
      console.error("Vault import failed:", error);
      timer = setTimeout(tick, Number(intervalMs || 15000));
      timer.unref?.();
    }
  };

  timer = setTimeout(tick, 1500);
  timer.unref?.();
  return () => clearTimeout(timer);
}

export function getVaultImportStatus() {
  return {
    snapshots: listVaultSnapshots(20)
  };
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

async function importVaultFile(rootPath, filePath, vault) {
  const vaultPath = path.relative(rootPath, filePath);

  try {
    const content = await fs.readFile(filePath, "utf8");
    const contentHash = hashContent(content);
    const existing = getVaultSnapshot(vaultPath);

    if (existing?.content_hash === contentHash) {
      return { vaultPath, status: "skipped", reason: "unchanged" };
    }

    const input = parseVaultFile(vaultPath, content, vault);
    if (!shouldCreateVaultEvent(input, vaultPath)) {
      upsertVaultSnapshot({ vaultPath, contentHash, eventId: null });
      return { vaultPath, status: "skipped", reason: "low-signal-vault-file" };
    }

    const event = await createEvent(input);
    upsertVaultSnapshot({ vaultPath, contentHash, eventId: event.id });
    return { vaultPath, status: "imported", eventId: event.id, title: event.title };
  } catch (error) {
    return { vaultPath, status: "failed", error: error.message };
  }
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
  if (["research_queue", "tracking_update", "finding", "task", "question", "alert", "decision"].includes(input.type)) {
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
    skipped: results.filter((item) => item.status === "skipped").length,
    failed: results.filter((item) => item.status === "failed").length,
    busy: false,
    results
  };
}
