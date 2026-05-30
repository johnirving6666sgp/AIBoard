import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { hasSourceImport, recordSourceImport } from "./db.js";
import { createEvent } from "./event-service.js";

const DEFAULT_SOURCES = [
  {
    source: "hermes",
    root: "/Users/lobai/.hermes/sessions",
    pattern: /\.jsonl$/
  },
  {
    source: "openclaw",
    root: "/Users/lobai/.openclaw/agents/main/sessions",
    pattern: /\.jsonl$/
  }
];

let importInProgress = false;

export async function importAgentOutputs({ recentHours = 24 } = {}) {
  if (importInProgress) {
    return { imported: 0, skipped: 0, failed: 0, busy: true, results: [] };
  }

  importInProgress = true;
  try {
    const results = [];
    for (const sourceConfig of DEFAULT_SOURCES) {
      const files = await listRecentFiles(sourceConfig, recentHours);
      for (const filePath of files) {
        results.push(...await importSessionFile(sourceConfig.source, filePath));
      }
    }
    return summarize(results);
  } finally {
    importInProgress = false;
  }
}

export function startAgentOutputWatcher({ intervalMs = 15000 } = {}) {
  let timer;
  const tick = async () => {
    try {
      await importAgentOutputs({ recentHours: 24 });
    } catch (error) {
      console.error("Agent output import failed:", error);
    } finally {
      timer = setTimeout(tick, intervalMs);
      timer.unref?.();
    }
  };
  timer = setTimeout(tick, 2500);
  timer.unref?.();
  return () => clearTimeout(timer);
}

async function listRecentFiles(sourceConfig, recentHours) {
  const cutoff = Date.now() - recentHours * 60 * 60 * 1000;
  const entries = await fs.readdir(sourceConfig.root, { withFileTypes: true }).catch(() => []);
  const files = [];

  for (const entry of entries) {
    if (!entry.isFile() || !sourceConfig.pattern.test(entry.name)) continue;
    const filePath = path.join(sourceConfig.root, entry.name);
    const stat = await fs.stat(filePath);
    if (stat.mtimeMs >= cutoff) files.push(filePath);
  }

  return files.sort();
}

async function importSessionFile(source, filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const results = [];

  for (const line of lines) {
    try {
      const item = JSON.parse(line);
      const parsed = source === "openclaw" ? parseOpenClawItem(item) : parseHermesItem(item);
      if (!parsed) {
        results.push({ status: "skipped", reason: "not-importable" });
        continue;
      }

      const sourceKey = sourceImportKey({ source, filePath, parsed, line });
      if (hasSourceImport(sourceKey)) {
        results.push({ status: "skipped", reason: "duplicate", sourceKey });
        continue;
      }

      const event = await createEvent({
        source,
        type: parsed.type,
        priority: parsed.priority,
        title: parsed.title,
        summary: parsed.summary,
        rawContent: parsed.rawContent,
        tags: ["agent-session", source, parsed.type]
      });
      recordSourceImport({ sourceKey, source, eventId: event.id });
      results.push({ status: "imported", source, eventId: event.id, title: event.title });
    } catch (error) {
      results.push({ status: "failed", source, error: error.message });
    }
  }

  return results;
}

function sourceImportKey({ source, filePath, parsed, line }) {
  if (parsed.errorFingerprint) {
    return `${source}:error:${parsed.errorFingerprint}`;
  }
  return `${source}:${filePath}:${parsed.id || hash(line)}`;
}

function parseHermesItem(item) {
  if (item.role !== "assistant") return null;
  const content = textFromContent(item.content);
  if (!content.trim()) return null;
  return {
    id: item.timestamp ? hash(`${item.timestamp}:${content}`) : hash(content),
    type: "artifact",
    priority: "normal",
    title: titleFromText("Hermes 输出", content),
    summary: content.slice(0, 360),
    rawContent: content
  };
}

function parseOpenClawItem(item) {
  if (item.type !== "message" || !item.message) return null;
  const role = item.message.role;
  if (role !== "assistant") return null;

  const content = textFromContent(item.message.content);
  const error = item.message.errorMessage;
  if (!content.trim() && !error) return null;

  if (error) {
    return {
      id: item.id || hash(JSON.stringify(item)),
      type: "alert",
      priority: "high",
      title: "OpenClaw session 错误",
      summary: error,
      rawContent: JSON.stringify(item, null, 2),
      errorFingerprint: hash(`openclaw:${error}`)
    };
  }

  return {
    id: item.id || hash(content),
    type: "artifact",
    priority: "normal",
    title: titleFromText("OpenClaw 输出", content),
    summary: content.slice(0, 360),
    rawContent: content
  };
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part?.type === "text") return part.text || "";
        return "";
      })
      .filter(Boolean)
      .join("\n\n");
  }
  return "";
}

function titleFromText(prefix, text) {
  const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return firstLine ? `${prefix}: ${firstLine.slice(0, 80)}` : prefix;
}

function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 24);
}

function summarize(results) {
  return {
    imported: results.filter((item) => item.status === "imported").length,
    skipped: results.filter((item) => item.status === "skipped").length,
    failed: results.filter((item) => item.status === "failed").length,
    busy: false,
    results
  };
}
