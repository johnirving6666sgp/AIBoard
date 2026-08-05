import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  getCommand,
  listCommands,
  markCommandCompleted,
  markCommandFailed,
  markCommandRunning,
  updateEventStatus,
  upsertCandidateStatus
} from "./db.js";
import { createEvent } from "./event-service.js";
import { loadConfig } from "./config.js";

const execFileAsync = promisify(execFile);

let cachedVaultRoot;
async function getVaultRoot() {
  if (cachedVaultRoot !== undefined) return cachedVaultRoot;
  try {
    const config = await loadConfig();
    cachedVaultRoot = config?.vault?.enabled ? config.vault.rootPath || "" : "";
  } catch {
    cachedVaultRoot = "";
  }
  return cachedVaultRoot;
}

// 深度研究需要长超时：OpenClaw 默认 25 分钟，Hermes 默认 10 分钟（可用环境变量覆盖）。
const TIMEOUTS_MS = {
  openclaw: Number(process.env.AIBOARD_OPENCLAW_TIMEOUT_MS || 25 * 60 * 1000),
  hermes: Number(process.env.AIBOARD_HERMES_TIMEOUT_MS || 10 * 60 * 1000)
};
const MAX_ATTEMPTS = Number(process.env.AIBOARD_COMMAND_MAX_ATTEMPTS || 2);

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

  const running = markCommandRunning(command.id);
  const startedAt = new Date().toISOString();

  try {
    const result = await executeForTarget(command);
    const event = await createEvent({
      source: command.target,
      type: "artifact",
      priority: "normal",
      title: `${agentLabel(command.target)} 已完成：${command.payload?.title || command.commandType}`,
      summary: result.stdout.slice(0, 360) || `${agentLabel(command.target)} 已完成命令 ${command.id}。`,
      rawContent: renderResult(command, result, startedAt),
      tags: ["agent-result", "command", "completed"],
      vaultPath: command.payload?.vaultPath || undefined
    });
    markCommandCompleted(command.id, event.id);
    persistCommandCompletion(command);
    return { id: command.id, status: "completed", eventId: event.id };
  } catch (error) {
    const attempts = running?.attempts || 1;

    // 还有重试机会：记录错误后重新排队，不生成告警事件（避免噪音）。
    if (attempts < MAX_ATTEMPTS) {
      markCommandFailed(command.id, { status: "dispatched", error: error.message });
      return { id: command.id, status: "retrying", attempts, error: error.message };
    }

    const output = [error.stdout, error.stderr, error.message].filter(Boolean).join("\n\n");
    const event = await createEvent({
      source: command.target,
      type: "alert",
      priority: "high",
      title: `${agentLabel(command.target)} 执行失败：${command.payload?.title || command.commandType}`,
      summary: output.slice(0, 360) || `${agentLabel(command.target)} 命令执行失败。`,
      rawContent: renderError(command, error, startedAt),
      tags: ["agent-result", "command", "failed"],
      vaultPath: command.payload?.vaultPath || undefined
    });
    markCommandFailed(command.id, { status: "failed", error: error.message, resultEventId: event.id });
    return { id: command.id, status: "failed", eventId: event.id, error: error.message, attempts };
  }
}

function persistCommandCompletion(command) {
  const candidate = command.payload?.candidate;
  if (command.eventId && candidate) {
    upsertCandidateStatus({
      eventId: command.eventId,
      candidateKey: candidateStateKey(command.eventId, candidate),
      status: `${agentLabel(command.target)} 已产出`,
      candidate
    });
    return;
  }

  if (command.eventId) {
    updateEventStatus(command.eventId, "done");
  }
}

function candidateStateKey(eventId, candidate) {
  return `aiboard:candidate:${eventId}:${candidate.code || ""}:${candidate.name || ""}`;
}

async function executeForTarget(command) {
  const prompt = await buildPrompt(command);

  if (command.target === "hermes") {
    return runCli("hermes", ["chat", "-q", prompt, "-Q", "--source", "aiboard"], { timeout: TIMEOUTS_MS.hermes });
  }

  if (command.target === "openclaw") {
    const cliTimeoutSec = String(Math.max(60, Math.round(TIMEOUTS_MS.openclaw / 1000)));
    return runCli("openclaw", ["agent", "--agent", "main", "--message", prompt, "--json", "--timeout", cliTimeoutSec], {
      timeout: TIMEOUTS_MS.openclaw + 30000
    });
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

async function buildPrompt(command) {
  const payload = command.payload || {};
  const candidate = payload.candidate;

  // 候选研究任务用结构化模板：要求 OpenClaw 把产出直接写进 Vault 的 companies/ 目录,
  // 这样 Vault watcher 会自动导入,前端"公司研究包"聚合逻辑会自动把各模块合并成一张卡。
  if (command.target === "openclaw" && candidate?.code) {
    return buildResearchPrompt(command, candidate, await getVaultRoot());
  }

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

function buildResearchPrompt(command, candidate, vaultRoot) {
  const code = String(candidate.code || "").trim();
  const name = String(candidate.name || "").trim();
  const label = [code, name].filter(Boolean).join(" ");
  const companyDir = vaultRoot ? `${vaultRoot}/companies/${code}` : null;

  const modules = [
    ["overview.md", "公司概览", "业务模式、核心逻辑、当前市场关注点"],
    ["bull_case.md", "多方观点", "看多逻辑、增长驱动、支持证据"],
    ["bear_case.md", "空方观点", "看空逻辑、主要质疑、反面证据"],
    ["valuation.md", "估值", "估值方法、关键假设、与同业对比"],
    ["risks.md", "风险", "主要风险、催化剂与关键时间线、需要跟踪的信号"]
  ];

  return [
    "你正在接收来自 AIBoard 的深度研究命令。",
    "",
    `命令 ID：${command.id}`,
    `研究标的：${label || "未命名"}`,
    candidate.market ? `市场：${candidate.market}` : null,
    candidate.priority ? `优先级：${candidate.priority}` : null,
    candidate.note ? `研究理由：${candidate.note}` : null,
    candidate.date ? `候选日期：${candidate.date}` : null,
    "",
    "请完成一次结构化深度研究，要求：",
    "",
    companyDir
      ? [
          "1. 把研究结果分模块写入本机 Obsidian Vault（文件已存在则覆盖更新）：",
          ...modules.map(([file, title, desc]) => `   ${companyDir}/${file} —— ${title}（${desc}）`),
          `2. 每个文件用中文 Markdown，第一行标题格式必须是：# ${code} — <模块名>（例如：# ${code} — 多方观点）`,
          "3. 内容要有具体数据和事实支撑，注明信息截至时间；没有把握的判断要标注不确定性。",
          "4. 全部写完后，在最终回复里给出一句话结论 + 已写入的文件路径列表。"
        ].join("\n")
      : [
          "1. 按以下模块输出中文 Markdown（Vault 未配置，直接在回复中输出全文）：",
          ...modules.map(([, title, desc]) => `   ## ${title} —— ${desc}`),
          "2. 内容要有具体数据和事实支撑，注明信息截至时间。"
        ].join("\n"),
    "",
    "不要发送任何外部消息。"
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
