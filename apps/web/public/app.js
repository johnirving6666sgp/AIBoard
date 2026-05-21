const state = {
  events: [],
  artifacts: [],
  commands: [],
  selectedId: null,
  view: "now",
  query: ""
};

const statsEl = document.querySelector("#stats");
const eventListEl = document.querySelector("#eventList");
const detailEl = document.querySelector("#eventDetail");
const artifactListEl = document.querySelector("#artifactList");
const artifactCountEl = document.querySelector("#artifactCount");
const commandListEl = document.querySelector("#commandList");
const commandCountEl = document.querySelector("#commandCount");
const runAdaptersButton = document.querySelector("#runAdaptersButton");
const searchInput = document.querySelector("#searchInput");
const refreshButton = document.querySelector("#refreshButton");
const intakeForm = document.querySelector("#intakeForm");
const importInboxButton = document.querySelector("#importInboxButton");
const importVaultButton = document.querySelector("#importVaultButton");
const importAgentsButton = document.querySelector("#importAgentsButton");
const importResult = document.querySelector("#importResult");
const vaultStatus = document.querySelector("#vaultStatus");

const labels = {
  hermes: "Hermes",
  openclaw: "OpenClaw",
  vault: "Vault",
  manual: "手动",
  research_queue: "研究队列",
  tracking_update: "跟踪更新",
  finding: "发现",
  artifact: "产出",
  status: "状态",
  alert: "提醒",
  question: "待确认",
  decision: "决策",
  task: "任务",
  low: "低",
  normal: "普通",
  high: "高",
  urgent: "紧急",
  new: "新事件",
  triaged: "已分流",
  in_progress: "处理中",
  done: "已完成",
  archived: "已归档",
  draft: "草稿",
  dispatched: "已派发",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  run_task: "执行任务",
  clarify: "追问澄清",
  update_vault: "更新 Vault",
  approve: "批准",
  reply: "回复",
  cancel: "取消"
};

document.querySelectorAll(".tab").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((tab) => tab.classList.remove("active"));
    button.classList.add("active");
    state.view = button.dataset.view;
    renderEvents();
  });
});

searchInput.addEventListener("input", () => {
  state.query = searchInput.value.trim();
  loadEvents();
});

refreshButton.addEventListener("click", () => loadAll());

runAdaptersButton.addEventListener("click", async () => {
  runAdaptersButton.disabled = true;
  try {
    await api("/api/adapters/run", { method: "POST" });
    await loadAll();
  } finally {
    runAdaptersButton.disabled = false;
  }
});

importInboxButton.addEventListener("click", async () => {
  importInboxButton.disabled = true;
  importResult.textContent = "正在导入 inbox...";
  try {
    const result = await api("/api/import/inbox", { method: "POST" });
    importResult.textContent = `已导入 ${result.imported} 条，失败 ${result.failed} 条，跳过 ${result.skipped} 条。`;
    await loadAll();
  } finally {
    importInboxButton.disabled = false;
  }
});

importVaultButton.addEventListener("click", async () => {
  importVaultButton.disabled = true;
  vaultStatus.textContent = "正在导入 Vault...";
  try {
    const result = await api("/api/import/vault", { method: "POST" });
    if (!result.enabled) {
      vaultStatus.textContent = "Vault 尚未启用。请在 config/aiboard.config.json 中配置只读导入。";
    } else {
      vaultStatus.textContent = `Vault 已导入 ${result.imported} 条，跳过 ${result.skipped} 条，失败 ${result.failed} 条。`;
    }
    await loadAll();
  } finally {
    importVaultButton.disabled = false;
  }
});

importAgentsButton.addEventListener("click", async () => {
  importAgentsButton.disabled = true;
  importResult.textContent = "正在导入智能体 session 输出...";
  try {
    const result = await api("/api/import/agents", { method: "POST" });
    importResult.textContent = `智能体输出已导入 ${result.imported} 条，跳过 ${result.skipped} 条，失败 ${result.failed} 条。`;
    await loadAll();
  } finally {
    importAgentsButton.disabled = false;
  }
});

intakeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(intakeForm));
  if (!data.rawContent.trim() && !data.title.trim()) return;
  await api("/api/events", {
    method: "POST",
    body: JSON.stringify({
      source: data.source,
      type: data.type || undefined,
      title: data.title || undefined,
      rawContent: data.rawContent
    })
  });
  intakeForm.reset();
  await loadAll();
});

await loadAll();

async function loadAll() {
  const [stats, artifacts, commands] = await Promise.all([
    api("/api/stats"),
    api("/api/artifacts"),
    api("/api/commands?limit=20")
  ]);
  state.artifacts = artifacts;
  state.commands = commands;
  renderArtifacts();
  renderCommands();
  await loadEvents();
  renderStats(stats);
  await loadConfigStatus();
}

async function loadConfigStatus() {
  const config = await api("/api/config");
  if (config.vault?.configured) {
    vaultStatus.textContent = `Vault 已启用：${config.vault.rootPath}`;
  } else {
    vaultStatus.textContent = "Vault 未启用。可在 config/aiboard.config.json 中开启只读导入。";
  }
}

async function loadEvents() {
  const params = new URLSearchParams();
  if (state.query) params.set("q", state.query);
  state.events = await api(`/api/events?${params}`);
  if (!state.selectedId && state.events.length) state.selectedId = state.events[0].id;
  if (state.selectedId && !state.events.some((event) => event.id === state.selectedId)) {
    state.selectedId = state.events[0]?.id || null;
  }
  renderEvents();
  await renderDetail();
}

function renderStats(stats) {
  const realEvents = state.events.filter((event) => !isDebugNoise(event));
  const researchFlow = state.events.filter(isResearchFlowEvent);
  const items = [
    ["需要处理", realEvents.filter((event) => ["new", "triaged"].includes(event.status)).length || stats.needAttention],
    ["研究主线", researchFlow.length],
    ["研究队列", stats.researchQueue],
    ["产出文件", stats.artifacts],
    ["持仓跟踪", stats.tracking],
    ["命令草稿", stats.draftCommands]
  ];

  statsEl.innerHTML = items.map(([label, value]) => `
    <article class="stat">
      <span class="stat-value">${value || 0}</span>
      <span class="stat-label">${label}</span>
    </article>
  `).join("");
}

function renderEvents() {
  const events = filteredEvents();
  if (state.selectedId && !events.some((event) => event.id === state.selectedId)) {
    state.selectedId = events[0]?.id || null;
  }

  if (!events.length) {
    eventListEl.innerHTML = `<div class="empty-state">这个视图暂时没有事件</div>`;
    detailEl.innerHTML = `<div class="empty-state">请选择一个事件</div>`;
    return;
  }

  eventListEl.innerHTML = events.map((event) => `
    <button class="event-card ${event.id === state.selectedId ? "active" : ""}" data-id="${event.id}">
      <div class="event-meta">
        ${badge(event.source, labels[event.source] || event.source)}
        ${badge(event.priority, labels[event.priority] || event.priority)}
        ${badge(event.status, labels[event.status] || event.status)}
        ${isDebugNoise(event) ? badge("debug", "调试") : ""}
      </div>
      <div class="event-title">${escapeHtml(event.title)}</div>
      <div class="event-summary">${escapeHtml(event.summary)}</div>
    </button>
  `).join("");

  eventListEl.querySelectorAll(".event-card").forEach((card) => {
    card.addEventListener("click", async () => {
      state.selectedId = card.dataset.id;
      renderEvents();
      await renderDetail();
      detailEl.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

async function renderDetail() {
  if (!state.selectedId) {
    detailEl.innerHTML = `<div class="empty-state">请选择一个事件</div>`;
    return;
  }

  const event = await api(`/api/events/${state.selectedId}`);
  const draftCommands = (event.commands || []).filter((command) => command.status === "draft" && !isDebugCommand(command));
  const markdownButton = event.markdownPath
    ? `<button class="secondary-button" data-open-markdown="${encodeURIComponent(event.markdownPath)}">查看 Markdown</button>`
    : "";

  detailEl.innerHTML = `
    <p class="detail-kicker">已选事件</p>
    <div class="detail-meta">
      ${badge(event.source, labels[event.source] || event.source)}
      ${badge(event.type, labels[event.type] || event.type)}
      ${badge(event.priority, labels[event.priority] || event.priority)}
      ${badge(event.status, labels[event.status] || event.status)}
      ${isDebugNoise(event) ? badge("debug", "调试") : ""}
    </div>
    <h3>${escapeHtml(event.title)}</h3>
    <p class="detail-summary">${escapeHtml(event.summary)}</p>
    <div class="detail-actions">
      <button class="status-button" data-status="triaged">已分流</button>
      <button class="status-button" data-status="in_progress">处理中</button>
      <button class="status-button" data-status="done">已完成</button>
      <button class="status-button" data-status="archived">归档</button>
      ${markdownButton}
    </div>
    ${event.vaultPath ? `<p class="muted">Vault: ${escapeHtml(event.vaultPath)}</p>` : ""}
    ${event.markdownPath ? `<p class="muted">Markdown: ${escapeHtml(event.markdownPath)}</p>` : ""}
    <div class="tags">
      ${(event.tags || []).map((tag) => badge("tag", tag)).join("")}
    </div>
    <section class="detail-section">
      <h2>建议动作</h2>
      <div class="detail-actions">
        ${(event.actions || []).map((action) => `
          <button class="secondary-button" data-command-action="${escapeHtml(action.id)}">${escapeHtml(actionLabel(action))}</button>
        `).join("")}
      </div>
    </section>
    <section class="detail-section">
      <h2>命令草稿</h2>
      <div class="command-list compact">
        ${draftCommands.map(renderCommandItem).join("") || '<p class="muted">这个事件还没有命令草稿。</p>'}
      </div>
    </section>
    <section class="detail-section">
      <h2>原始输出</h2>
      <pre class="raw-output">${escapeHtml(event.rawContent)}</pre>
    </section>
    <section id="markdownPreviewWrap" class="detail-section" hidden>
      <h2>Markdown 归档</h2>
      <pre id="markdownPreview" class="markdown-preview"></pre>
    </section>
  `;

  detailEl.querySelectorAll("[data-status]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api(`/api/events/${event.id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status: button.dataset.status })
      });
      await loadAll();
    });
  });

  const openMarkdown = detailEl.querySelector("[data-open-markdown]");
  if (openMarkdown) {
    openMarkdown.addEventListener("click", async () => {
      const content = await fetch(`/api/markdown/${openMarkdown.dataset.openMarkdown}`).then((res) => res.text());
      detailEl.querySelector("#markdownPreviewWrap").hidden = false;
      detailEl.querySelector("#markdownPreview").textContent = content;
    });
  }

  detailEl.querySelectorAll("[data-command-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const action = (event.actions || []).find((item) => item.id === button.dataset.commandAction);
      if (!action) return;
      button.disabled = true;
      await api("/api/commands", {
        method: "POST",
        body: JSON.stringify({
          eventId: event.id,
          kind: action.kind,
          target: action.target,
          payload: action.payload || {}
        })
      });
      await loadAll();
    });
  });
}

function renderArtifacts() {
  const visibleArtifacts = state.artifacts.filter((artifact) => !isDebugArtifact(artifact));
  artifactCountEl.textContent = `${visibleArtifacts.length} 个文件`;
  artifactListEl.innerHTML = visibleArtifacts.map((artifact) => `
    <article class="artifact-item">
      <div>
        <strong>${escapeHtml(artifact.title)}</strong>
        <div class="artifact-path">${escapeHtml(artifact.path)}</div>
      </div>
      <span class="badge">${escapeHtml(labels[artifact.kind] || artifact.kind)}</span>
    </article>
  `).join("") || `<div class="empty-state">暂时没有产出文件</div>`;
}

function renderCommands() {
  const draftCommands = state.commands.filter((command) => command.status === "draft" && !isDebugCommand(command));
  commandCountEl.textContent = `${draftCommands.length} 个草稿`;
  commandListEl.innerHTML = draftCommands.map((command) => renderCommandItem(command, { showDispatch: true })).join("") || `<div class="empty-state">暂时没有命令草稿</div>`;
  commandListEl.querySelectorAll("[data-dispatch-command]").forEach((button) => {
    button.addEventListener("click", async () => {
      button.disabled = true;
      await api(`/api/commands/${button.dataset.dispatchCommand}/dispatch`, { method: "POST" });
      await loadAll();
    });
  });
}

function renderCommandItem(command, options = {}) {
  const title = command.payload?.title || command.commandType;
  const path = command.payload?.vaultPath || command.payload?.markdownPath || "";
  return `
    <article class="command-item">
      <div>
        <div class="event-meta">
          ${badge(command.target, command.target)}
          ${badge(command.status, labels[command.status] || command.status)}
          ${badge(command.commandType, labels[command.commandType] || command.commandType)}
        </div>
        <strong>${escapeHtml(title)}</strong>
        ${path ? `<div class="artifact-path">${escapeHtml(path)}</div>` : ""}
      </div>
      ${options.showDispatch && command.status === "draft" ? `<button class="secondary-button" data-dispatch-command="${escapeHtml(command.id)}">派发</button>` : ""}
    </article>
  `;
}

function actionLabel(action) {
  const byKind = {
    archive: "归档",
    status: action.payload?.status ? (labels[action.payload.status] || "更新状态") : "更新状态",
    assign: "交给 OpenClaw",
    ask_follow_up: action.target === "openclaw" ? "追问 OpenClaw" : "追问 Hermes",
    update_vault: "更新 Vault",
    open_artifact: "查看输出"
  };
  return byKind[action.kind] || action.label || "创建命令";
}

function filteredEvents() {
  const visibleEvents = state.events.filter((event) => !isDebugNoise(event));
  if (state.view === "now") {
    return visibleEvents.filter((event) => ["new", "triaged"].includes(event.status));
  }
  if (state.view === "research_flow") {
    return state.events.filter(isResearchFlowEvent);
  }
  if (state.view === "activity") {
    return visibleEvents.filter((event) => ["hermes", "openclaw"].includes(event.source));
  }
  if (state.view === "artifacts") {
    return visibleEvents.filter((event) => event.type === "artifact");
  }
  if (state.view === "debug") {
    return state.events.filter(isDebugNoise);
  }
  if (state.view === "history") {
    return state.events;
  }
  return visibleEvents.filter((event) => event.type === state.view);
}

function isResearchFlowEvent(event) {
  if (isDebugNoise(event)) return false;
  const tags = event.tags || [];
  if (["research_queue", "tracking_update", "decision"].includes(event.type)) return true;
  if (event.vaultPath && /研究队列|持仓|tracking|companies|sectors|governor/i.test(event.vaultPath)) return true;
  return tags.some((tag) => ["research", "market", "sector", "company", "governor"].includes(String(tag).toLowerCase()));
}

function isDebugNoise(event) {
  return isDebugText([
    event.title,
    event.summary,
    event.rawContent,
    ...(event.tags || [])
  ]);
}

function isDebugArtifact(artifact) {
  return isDebugText([artifact.title, artifact.path, artifact.kind]);
}

function isDebugCommand(command) {
  return isDebugText([
    command.commandType,
    command.status,
    command.payload?.title,
    command.payload?.summary,
    command.payload?.rawContent
  ]);
}

function isDebugText(parts) {
  const haystack = parts.join("\n").toLowerCase();

  return (
    haystack.includes("adapter ok") ||
    haystack.includes("适配器 ok") ||
    haystack.includes("adapter") ||
    haystack.includes("command failed") ||
    haystack.includes("执行失败") ||
    haystack.includes("session 错误") ||
    haystack.includes("session error") ||
    haystack.includes("smoke")
  );
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json();
}

function badge(className, text) {
  return `<span class="badge ${escapeHtml(className)}">${escapeHtml(text)}</span>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
