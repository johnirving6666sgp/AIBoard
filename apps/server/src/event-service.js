import { createId } from "./ids.js";
import {
  addActions,
  addArtifact,
  getEvent,
  insertEvent,
  listEventCommands,
  listEvents,
  updateEventContent,
  updateEventStatus,
  updateMarkdownPath
} from "./db.js";
import { appendAuditNote, rewriteMarkdownArchive, writeMarkdownArchive } from "./markdown.js";
import { normalizeInput } from "./normalizer.js";

export async function createEvent(input) {
  const { event, actions } = normalizeInput(input);
  insertEvent(event);
  addActions(event.id, actions);
  const markdownPath = await writeMarkdownArchive(event, actions);
  const saved = updateMarkdownPath(event.id, markdownPath);

  addArtifact({
    id: createId("art"),
    eventId: event.id,
    title: `${event.title}.md`,
    path: markdownPath,
    kind: "markdown",
    createdAt: event.createdAt
  });

  return { ...saved, actions };
}

// 同一 vault_path 的文件内容变化时，更新原事件而不是新建，避免重复卡片。
export async function updateEventFromSource(existing, input) {
  const { event } = normalizeInput({
    ...input,
    id: existing.id,
    threadId: existing.threadId,
    workflowId: existing.workflowId,
    createdAt: existing.createdAt,
    // 已归档/已完成的事件收到新内容时重新浮出，其余保持人工设定的状态。
    status: ["archived", "done"].includes(existing.status) ? "new" : existing.status
  });

  const saved = updateEventContent(existing.id, event);

  if (existing.markdownPath) {
    await rewriteMarkdownArchive(saved, saved.actions || []);
  } else {
    const markdownPath = await writeMarkdownArchive(saved, saved.actions || []);
    updateMarkdownPath(existing.id, markdownPath);
  }

  return getEvent(existing.id);
}

export function getEventWithActions(id) {
  const event = getEvent(id);
  if (!event) return null;
  event.commands = listEventCommands(id);
  return event;
}

export function queryEvents(filters) {
  return listEvents(filters);
}

export async function setEventStatus(id, status) {
  const updated = updateEventStatus(id, status);
  if (!updated) return null;
  await appendAuditNote(updated, `状态已更新为 ${status}。`);
  return updated;
}
