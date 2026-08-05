import { createId } from "./ids.js";
import { getCommand, getEvent, insertCommand, listCommands, listEventCommands, markCommandDispatched, setCommandStatus, updateEventStatus } from "./db.js";
import { appendAuditNote } from "./markdown.js";
import { writeCommandOutbox } from "./outbox.js";

// 命令状态机：只允许这些转移，避免状态被随意改乱。
const ALLOWED_TRANSITIONS = {
  draft: ["dispatched", "cancelled"],
  dispatched: ["running", "cancelled", "draft"],
  running: ["completed", "failed"],
  failed: ["dispatched", "cancelled"],
  completed: [],
  cancelled: ["draft"]
};

export function queryCommands(filters) {
  return listCommands(filters);
}

export function queryEventCommands(eventId) {
  return listEventCommands(eventId);
}

export async function createCommandDraft(input) {
  const event = input.eventId ? getEvent(input.eventId) : null;
  const command = normalizeCommandInput(input, event);
  insertCommand(command);

  if (event) {
    updateEventStatus(event.id, "triaged");
    await appendAuditNote(event, `已为 ${command.target} 创建命令草稿：${command.commandType}。`);
  }

  return command;
}

export async function updateCommandStatus(id, status) {
  const command = getCommand(id);
  if (!command) return null;
  const allowed = ALLOWED_TRANSITIONS[command.status] || [];
  if (!allowed.includes(status)) {
    return { id, status: command.status, ok: false, error: `不允许从 ${command.status} 变更为 ${status}` };
  }
  if (status === "dispatched") {
    markCommandDispatched(id);
  } else {
    setCommandStatus(id, status);
  }
  return { id, status, ok: true };
}

// draft 首次派发；failed 允许重新派发（重试）。
export async function dispatchCommand(id) {
  const command = getCommand(id);
  if (!command) return null;
  if (!["draft", "failed"].includes(command.status)) {
    return { ...command, dispatched: false, reason: `命令当前状态为 ${command.status}。` };
  }

  const outbox = await writeCommandOutbox({ ...command, status: "dispatched" });
  markCommandDispatched(id);

  if (command.eventId) {
    const event = getEvent(command.eventId);
    updateEventStatus(command.eventId, "in_progress");
    await appendAuditNote(event, `命令已派发到 ${command.target} outbox：${outbox.jsonPath}。`);
  }

  return {
    ...command,
    status: "dispatched",
    dispatched: true,
    outbox
  };
}

function normalizeCommandInput(input, event) {
  const now = new Date().toISOString();
  const target = input.target || inferTarget(input.kind, event);
  const commandType = input.commandType || inferCommandType(input.kind, target);

  return {
    id: input.id || createId("cmd"),
    eventId: input.eventId || null,
    target,
    commandType,
    payload: {
      title: event?.title || input.title || "未命名命令",
      summary: event?.summary || input.summary || "",
      vaultPath: event?.vaultPath || input.vaultPath || null,
      markdownPath: event?.markdownPath || input.markdownPath || null,
      sourceEventId: event?.id || input.eventId || null,
      rawContent: event?.rawContent || input.rawContent || "",
      ...(input.payload || {})
    },
    status: input.status || "draft",
    createdBy: input.createdBy || "human",
    createdAt: now
  };
}

function inferTarget(kind, event) {
  if (kind === "assign") return "openclaw";
  if (kind === "ask_follow_up") return event?.source === "openclaw" ? "openclaw" : "hermes";
  if (kind === "update_vault") return "vault";
  if (event?.type === "research_queue") return "openclaw";
  if (event?.type === "tracking_update") return "vault";
  return event?.source === "openclaw" ? "openclaw" : "hermes";
}

function inferCommandType(kind, target) {
  if (kind === "assign") return "run_task";
  if (kind === "ask_follow_up") return "clarify";
  if (kind === "update_vault") return "update_vault";
  if (target === "vault") return "update_vault";
  return "run_task";
}
