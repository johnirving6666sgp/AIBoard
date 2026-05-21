import { createId } from "./ids.js";
import {
  addActions,
  addArtifact,
  getEvent,
  insertEvent,
  listEventCommands,
  listEvents,
  updateEventStatus,
  updateMarkdownPath
} from "./db.js";
import { appendAuditNote, writeMarkdownArchive } from "./markdown.js";
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
