import { createId } from "./ids.js";
import { SOURCE_LABELS } from "../../../packages/shared/src/model.js";

const DEFAULT_ACTIONS = [
  { kind: "archive", label: "归档" },
  { kind: "status", label: "标记完成", payload: { status: "done" } }
];

export function normalizeInput(input) {
  const now = new Date().toISOString();
  const source = normalizeSource(input.source);
  const rawContent = String(input.rawContent || input.content || input.body || "").trim();
  const title = cleanTitle(input.title || extractTitle(rawContent) || "未命名事件");
  const type = input.type || inferType(rawContent, input.vaultPath);
  const priority = input.priority || inferPriority(rawContent, type);
  const tags = normalizeTags(input.tags || inferTags(rawContent, source, type));

  const event = {
    id: input.id || createId("evt"),
    source,
    actor: input.actor || SOURCE_LABELS[source] || "手动",
    type,
    status: input.status || "new",
    priority,
    title,
    summary: input.summary || summarize(rawContent, title),
    rawContent: rawContent || title,
    markdownPath: input.markdownPath,
    vaultPath: input.vaultPath,
    threadId: input.threadId || createId("th"),
    workflowId: input.workflowId,
    tags,
    createdAt: input.createdAt || now,
    updatedAt: now
  };

  const actions = buildActions(event, input.suggestedActions);
  return { event, actions };
}

function normalizeSource(source) {
  if (["hermes", "openclaw", "vault", "manual"].includes(source)) return source;
  return "manual";
}

function cleanTitle(title) {
  return String(title).replace(/^#+\s*/, "").trim().slice(0, 140);
}

function extractTitle(rawContent) {
  const lines = rawContent.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => !line.startsWith("---")) || "";
}

function summarize(rawContent, fallbackTitle) {
  const cleaned = rawContent
    .replace(/^---[\s\S]*?---/m, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .filter(Boolean)
    .filter((line) => line !== fallbackTitle);
  const summary = cleaned.slice(0, 3).join(" ");
  return (summary || fallbackTitle).slice(0, 360);
}

function inferType(rawContent, vaultPath = "") {
  const text = `${vaultPath}\n${rawContent}`.toLowerCase();
  if (text.includes("研究队列") || text.includes("research queue")) return "research_queue";
  if (text.includes("持仓") || text.includes("tracking") || text.includes("watchlist")) return "tracking_update";
  if (text.includes("approve") || text.includes("批准") || text.includes("需要你")) return "question";
  if (text.includes("urgent") || text.includes("风险") || text.includes("alert")) return "alert";
  if (text.includes("artifact") || text.includes("report") || text.includes("brief")) return "artifact";
  if (text.includes("decision") || text.includes("决策")) return "decision";
  if (text.includes("todo") || text.includes("task") || text.includes("任务")) return "task";
  return "finding";
}

function inferPriority(rawContent, type) {
  const text = rawContent.toLowerCase();
  if (text.includes("urgent") || text.includes("紧急")) return "urgent";
  if (type === "alert" || text.includes("high priority") || text.includes("高优先级")) return "high";
  if (type === "status") return "low";
  return "normal";
}

function inferTags(rawContent, source, type) {
  const tags = new Set([source, type]);
  const text = rawContent.toLowerCase();
  if (text.includes("market") || text.includes("市场")) tags.add("market");
  if (text.includes("sector") || text.includes("行业")) tags.add("sector");
  if (text.includes("company") || text.includes("公司")) tags.add("company");
  if (text.includes("governor")) tags.add("governor");
  if (text.includes("research") || text.includes("研究")) tags.add("research");
  return [...tags];
}

function normalizeTags(tags) {
  return [...new Set(tags.map((tag) => String(tag).trim()).filter(Boolean))];
}

function buildActions(event, suggestedActions = []) {
  const actions = suggestedActions.length
    ? suggestedActions
    : [
        ...defaultPrimaryActions(event),
        ...DEFAULT_ACTIONS
      ];

  return actions.map((action) => ({
    id: action.id || createId("act"),
    kind: action.kind,
    label: action.label,
    target: action.target,
    payload: action.payload || {}
  }));
}

function defaultPrimaryActions(event) {
  if (event.type === "research_queue") {
    return [{ kind: "assign", label: "交给 OpenClaw", target: "openclaw" }];
  }
  if (event.type === "tracking_update") {
    return [{ kind: "update_vault", label: "更新跟踪", target: "vault" }];
  }
  if (event.source === "hermes") {
    return [{ kind: "ask_follow_up", label: "追问 Hermes", target: "hermes" }];
  }
  if (event.source === "openclaw") {
    return [{ kind: "open_artifact", label: "查看输出", target: "openclaw" }];
  }
  return [{ kind: "status", label: "已分流", payload: { status: "triaged" } }];
}
