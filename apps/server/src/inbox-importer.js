import fs from "node:fs/promises";
import path from "node:path";
import { recordImportedFile } from "./db.js";
import { createEvent } from "./event-service.js";
import { failedInboxDir, inboxDir, processedInboxDir, rootDir } from "./paths.js";

const SUPPORTED_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".json"]);
let importInProgress = false;

export async function importInbox() {
  if (importInProgress) {
    return { imported: 0, failed: 0, skipped: 0, busy: true, results: [] };
  }

  importInProgress = true;
  try {
    await ensureInboxDirs();
    const files = await listImportableFiles(inboxDir);
    const results = [];

    for (const filePath of files) {
      const result = await importInboxFile(filePath);
      results.push(result);
    }

    return {
      imported: results.filter((item) => item.status === "imported").length,
      failed: results.filter((item) => item.status === "failed").length,
      skipped: results.filter((item) => item.status === "skipped").length,
      busy: false,
      results
    };
  } finally {
    importInProgress = false;
  }
}

export function startInboxWatcher({ intervalMs = 5000 } = {}) {
  let timer;
  const tick = async () => {
    try {
      await importInbox();
    } catch (error) {
      console.error("Inbox import failed:", error);
    } finally {
      timer = setTimeout(tick, intervalMs);
      timer.unref?.();
    }
  };

  timer = setTimeout(tick, 1000);
  timer.unref?.();
  return () => clearTimeout(timer);
}

async function importInboxFile(filePath) {
  const relative = path.relative(rootDir, filePath);
  try {
    const input = await parseInboxFile(filePath);
    const event = await createEvent({
      ...input,
      rawContent: input.rawContent || input.content || "",
      tags: [...new Set([...(input.tags || []), "inbox"])],
      vaultPath: input.vaultPath,
      source: input.source || inferSourceFromPath(filePath)
    });

    await moveInboxFile(filePath, processedInboxDir);
    recordImportedFile({ path: relative, status: "imported", eventId: event.id });
    return { path: relative, status: "imported", eventId: event.id, title: event.title };
  } catch (error) {
    await moveInboxFile(filePath, failedInboxDir).catch(() => {});
    recordImportedFile({ path: relative, status: "failed", error: error.message });
    return { path: relative, status: "failed", error: error.message };
  }
}

async function listImportableFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (["processed", "failed", "samples"].includes(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listImportableFiles(fullPath));
      continue;
    }

    if (entry.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

async function parseInboxFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const content = await fs.readFile(filePath, "utf8");

  if (extension === ".json") {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      throw new Error("JSON arrays are not supported in file watcher import yet; use one event per file.");
    }
    return parsed;
  }

  const { frontmatter, body } = parseFrontmatter(content);
  return {
    ...frontmatter,
    title: frontmatter.title || extractMarkdownTitle(body) || path.basename(filePath, extension),
    rawContent: body.trim() || content.trim()
  };
}

export function parseFrontmatter(content) {
  if (!content.startsWith("---")) {
    return { frontmatter: {}, body: content };
  }

  const end = content.indexOf("\n---", 3);
  if (end === -1) {
    return { frontmatter: {}, body: content };
  }

  const raw = content.slice(3, end).trim();
  const body = content.slice(end + 4).trimStart();
  return { frontmatter: parseSimpleYaml(raw), body };
}

export function parseSimpleYaml(raw) {
  const result = {};
  const lines = raw.split(/\r?\n/);
  let currentListKey = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    const listMatch = line.match(/^\s*-\s+(.+)$/);
    if (listMatch && currentListKey) {
      result[currentListKey].push(coerceScalar(listMatch[1]));
      continue;
    }

    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;

    const [, key, value] = match;
    if (value === "") {
      result[key] = [];
      currentListKey = key;
    } else {
      result[key] = coerceScalar(value);
      currentListKey = null;
    }
  }

  return result;
}

function coerceScalar(value) {
  const trimmed = String(value).trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1).split(",").map((item) => item.trim()).filter(Boolean);
  }
  return trimmed;
}

export function extractMarkdownTitle(content) {
  const line = content.split(/\r?\n/).find((item) => item.trim().startsWith("# "));
  return line ? line.replace(/^#\s+/, "").trim() : "";
}

function inferSourceFromPath(filePath) {
  const lowered = filePath.toLowerCase();
  if (lowered.includes("hermes")) return "hermes";
  if (lowered.includes("openclaw")) return "openclaw";
  if (lowered.includes("vault")) return "vault";
  return "manual";
}

async function moveInboxFile(filePath, targetDir) {
  await fs.mkdir(targetDir, { recursive: true });
  const target = await uniqueTargetPath(path.join(targetDir, path.basename(filePath)));
  await fs.rename(filePath, target);
}

async function uniqueTargetPath(target) {
  let candidate = target;
  let index = 1;
  while (await exists(candidate)) {
    const parsed = path.parse(target);
    candidate = path.join(parsed.dir, `${parsed.name}-${index}${parsed.ext}`);
    index += 1;
  }
  return candidate;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureInboxDirs() {
  await fs.mkdir(inboxDir, { recursive: true });
  await fs.mkdir(processedInboxDir, { recursive: true });
  await fs.mkdir(failedInboxDir, { recursive: true });
}
