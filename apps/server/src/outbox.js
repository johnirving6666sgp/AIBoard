import fs from "node:fs/promises";
import path from "node:path";
import { slugify } from "./ids.js";
import { commandOutboxDir, rootDir } from "./paths.js";

export async function writeCommandOutbox(command) {
  const target = command.target || "manual";
  const dir = path.join(commandOutboxDir, target);
  await fs.mkdir(dir, { recursive: true });

  const stamp = command.createdAt.replace(/[:.]/g, "");
  const title = slugify(command.payload?.title || command.commandType || command.id);
  const baseName = `${stamp}-${command.id}-${title}`;
  const jsonPath = path.join(dir, `${baseName}.json`);
  const markdownPath = path.join(dir, `${baseName}.md`);

  await fs.writeFile(jsonPath, JSON.stringify(command, null, 2), "utf8");
  await fs.writeFile(markdownPath, renderCommandMarkdown(command), "utf8");

  return {
    jsonPath: path.relative(rootDir, jsonPath),
    markdownPath: path.relative(rootDir, markdownPath)
  };
}

function renderCommandMarkdown(command) {
  const payload = command.payload || {};
  return `---
id: ${command.id}
target: ${command.target}
commandType: ${command.commandType}
status: ${command.status}
createdAt: ${command.createdAt}
eventId: ${command.eventId || ""}
---

# ${payload.title || command.commandType}

${payload.summary || ""}

## 命令

- 目标：${command.target}
- 类型：${command.commandType}
- 来源事件：${payload.sourceEventId || command.eventId || ""}
- Vault 路径：${payload.vaultPath || ""}
- Markdown 路径：${payload.markdownPath || ""}

## 原始内容

${payload.rawContent || ""}
`;
}
