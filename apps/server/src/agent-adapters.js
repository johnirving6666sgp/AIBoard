import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getCommand, listCommands, setCommandStatus } from "./db.js";
import { createEvent } from "./event-service.js";

const execFileAsync = promisify(execFile);

export async function runDispatchedCommands({ limit = 5, target = null } = {}) {
  const commands = listCommands({ status: "dispatched", limit: 50 })
    .filter((command) => !target || command.target === target)
    .slice(0, limit);
  const results = [];

  for (const command of commands) {
    results.push(await runCommand(command));
  }

  return {
    processed: results.length,
    completed: results.filter((item) => item.status === "completed").length,
    failed: results.filter((item) => item.status === "failed").length,
    results
  };
}

export async function runCommandById(id) {
  const command = getCommand(id);
  if (!command) return null;
  return runCommand(command);
}

async function runCommand(command) {
  if (!["dispatched", "running"].includes(command.status)) {
    return { id: command.id, status: command.status, skipped: true };
  }

  setCommandStatus(command.id, "running");
  const startedAt = new Date().toISOString();

  try {
    const result = await executeForTarget(command);
    setCommandStatus(command.id, "completed");
    const event = await createEvent({
      source: command.target,
      type: "artifact",
      priority: "normal",
      title: `${agentLabel(command.target)} 已完成：${command.payload?.title || command.commandType}`,
      summary: result.stdout.slice(0, 360) || `${agentLabel(command.target)} 已完成命令 ${command.id}。`,
      rawContent: renderResult(command, result, startedAt),
      tags: ["adapter", "command", "completed"],
      vaultPath: command.payload?.vaultPath || undefined
    });
    return { id: command.id, status: "completed", eventId: event.id };
  } catch (error) {
    setCommandStatus(command.id, "failed");
    const output = [error.stdout, error.stderr, error.message].filter(Boolean).join("\n\n");
    const event = await createEvent({
      source: command.target,
      type: "alert",
      priority: "high",
      title: `${agentLabel(command.target)} 执行失败：${command.payload?.title || command.commandType}`,
      summary: output.slice(0, 360) || `${agentLabel(command.target)} 命令执行失败。`,
      rawContent: renderError(command, error, startedAt),
      tags: ["adapter", "command", "failed"],
      vaultPath: command.payload?.vaultPath || undefined
    });
    return { id: command.id, status: "failed", eventId: event.id, error: error.message };
  }
}

async function executeForTarget(command) {
  const prompt = buildPrompt(command);

  if (command.target === "hermes") {
    return runCli("hermes", ["chat", "-q", prompt, "-Q", "--source", "aiboard"], { timeout: 180000 });
  }

  if (command.target === "openclaw") {
    return runCli("openclaw", ["agent", "--agent", "main", "--message", prompt, "--json", "--timeout", "180"], { timeout: 190000 });
  }

  if (command.target === "vault") {
    return {
      stdout: `Vault 更新草稿已创建，请手动检查。\n\n${prompt}`,
      stderr: "",
      command: "vault-local-draft"
    };
  }

  throw new Error(`No adapter configured for target ${command.target}`);
}

async function runCli(command, args, options) {
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd: process.cwd(),
    timeout: options.timeout,
    maxBuffer: 1024 * 1024 * 4
  });
  return { stdout: stdout.trim(), stderr: stderr.trim(), command: `${command} ${args.join(" ")}` };
}

function buildPrompt(command) {
  const payload = command.payload || {};
  return [
    "你正在接收来自 AIBoard 的命令。",
    "",
    `命令 ID：${command.id}`,
    `命令类型：${command.commandType}`,
    `目标：${command.target}`,
    payload.vaultPath ? `Vault 路径：${payload.vaultPath}` : null,
    payload.markdownPath ? `AIBoard Markdown 路径：${payload.markdownPath}` : null,
    "",
    `标题：${payload.title || command.commandType}`,
    "",
    payload.summary ? `摘要：\n${payload.summary}` : null,
    "",
    "来源内容：",
    payload.rawContent || "（无）",
    "",
    "请使用中文返回适合 AIBoard 展示的简洁结果。不要发送任何外部消息。"
  ].filter(Boolean).join("\n");
}

function renderResult(command, result, startedAt) {
  return [
    `命令 ${command.id} 已完成。`,
    "",
    `开始时间：${startedAt}`,
    `完成时间：${new Date().toISOString()}`,
    `目标：${command.target}`,
    `类型：${command.commandType}`,
    "",
    "## CLI",
    result.command,
    "",
    "## STDOUT",
    result.stdout || "(empty)",
    "",
    "## STDERR",
    result.stderr || "(empty)"
  ].join("\n");
}

function renderError(command, error, startedAt) {
  return [
    `命令 ${command.id} 执行失败。`,
    "",
    `开始时间：${startedAt}`,
    `结束时间：${new Date().toISOString()}`,
    `目标：${command.target}`,
    `类型：${command.commandType}`,
    "",
    "## 错误",
    error.message,
    "",
    "## STDOUT",
    error.stdout || "(empty)",
    "",
    "## STDERR",
    error.stderr || "(empty)"
  ].join("\n");
}

function agentLabel(target) {
  if (target === "openclaw") return "OpenClaw";
  if (target === "hermes") return "Hermes";
  if (target === "vault") return "Vault";
  return target;
}
