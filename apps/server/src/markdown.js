import fs from "node:fs/promises";
import path from "node:path";
import { markdownRoot, rootDir } from "./paths.js";
import { slugify } from "./ids.js";

export async function writeMarkdownArchive(event, actions = []) {
  const date = event.createdAt.slice(0, 10);
  const source = event.source || "manual";
  const dir = path.join(markdownRoot, date, source);
  await fs.mkdir(dir, { recursive: true });

  const stamp = event.createdAt.replace(/[:.]/g, "").replace("Z", "Z");
  const fileName = `${stamp}-${slugify(event.title)}.md`;
  const absolutePath = path.join(dir, fileName);
  const relativePath = path.relative(rootDir, absolutePath);

  await fs.writeFile(absolutePath, renderMarkdown(event, actions), "utf8");
  return relativePath;
}

// 覆盖已有归档文件（事件内容更新时复用同一路径，不再新建文件）。
export async function rewriteMarkdownArchive(event, actions = []) {
  if (!event?.markdownPath) return null;
  const absolutePath = path.join(rootDir, event.markdownPath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, renderMarkdown(event, actions), "utf8");
  return event.markdownPath;
}

export async function appendAuditNote(event, note) {
  if (!event?.markdownPath) return;
  const absolutePath = path.join(rootDir, event.markdownPath);
  const line = `\n\n## 操作记录\n\n- ${new Date().toISOString()} ${note}\n`;
  await fs.appendFile(absolutePath, line, "utf8");
}

function renderMarkdown(event, actions) {
  const frontmatter = [
    "---",
    `id: ${event.id}`,
    `source: ${event.source}`,
    `actor: ${escapeYaml(event.actor)}`,
    `type: ${event.type}`,
    `priority: ${event.priority}`,
    `status: ${event.status}`,
    `createdAt: ${event.createdAt}`,
    event.threadId ? `threadId: ${event.threadId}` : null,
    event.workflowId ? `workflowId: ${event.workflowId}` : null,
    event.vaultPath ? `vaultPath: ${escapeYaml(event.vaultPath)}` : null,
    "tags:",
    ...(event.tags || []).map((tag) => `  - ${escapeYaml(tag)}`),
    "---"
  ].filter(Boolean).join("\n");

  const actionLines = actions.length
    ? actions.map((action) => `- ${action.label}${action.target ? ` (${action.target})` : ""}`).join("\n")
    : "- 如果不需要处理，可以归档";

  return `${frontmatter}

# ${event.title}

${event.summary}

## 原始输出

${event.rawContent}

## 建议动作

${actionLines}
`;
}

function escapeYaml(value) {
  const text = String(value ?? "");
  if (/[:#\n]/.test(text)) return JSON.stringify(text);
  return text;
}
