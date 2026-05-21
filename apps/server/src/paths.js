import path from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = path.dirname(fileURLToPath(import.meta.url));
export const rootDir = path.resolve(serverDir, "../../..");
export const webDir = path.join(rootDir, "apps", "web", "public");
export const dataDir = path.join(rootDir, "data");
export const configDir = path.join(rootDir, "config");
export const configPath = path.join(configDir, "aiboard.config.json");
export const inboxDir = path.join(rootDir, "inbox");
export const processedInboxDir = path.join(inboxDir, "processed");
export const failedInboxDir = path.join(inboxDir, "failed");
export const markdownRoot = path.join(rootDir, "agent-output");
export const commandOutboxDir = path.join(rootDir, "command-outbox");
export const dbPath = path.join(dataDir, "aiboard.sqlite");
