const state = {
  events: [],
  artifacts: [],
  commands: [],
  candidateStatuses: {},
  selectedId: null,
  view: "now",
  query: "",
  loading: false
};

const eventListEl = document.querySelector("#eventList");
const artifactListEl = document.querySelector("#artifactList");
const artifactCountEl = document.querySelector("#artifactCount");
const commandListEl = document.querySelector("#commandList");
const commandCountEl = document.querySelector("#commandCount");
const openClawPreviewWrap = document.querySelector("#openClawPreviewWrap");
const openClawPreview = document.querySelector("#openClawPreview");
const runAdaptersButton = document.querySelector("#runAdaptersButton");
const searchInput = document.querySelector("#searchInput");
const refreshButton = document.querySelector("#refreshButton");
const intakeForm = document.querySelector("#intakeForm");
const importInboxButton = document.querySelector("#importInboxButton");
const importVaultButton = document.querySelector("#importVaultButton");
const importAgentsButton = document.querySelector("#importAgentsButton");
const importResult = document.querySelector("#importResult");
const vaultStatus = document.querySelector("#vaultStatus");
const cockpitEl = document.querySelector("#cockpit");

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
  cn_market_report: "A股日报",
  limit_up_report: "涨停/龙头",
  us_market_report: "美股成果",
  hk_market_report: "港股成果",
  jp_market_report: "日股成果",
  system_report: "系统报告",
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

const viewLabels = {
  now: "现在",
  research_flow: "研究全局",
  research_queue: "待研究候选",
  cn_market: "A股成果",
  activity: "智能体动态",
  artifacts: "产出文件",
  tracking_update: "持仓跟踪",
  debug: "系统调试",
  history: "历史归档"
};

document.querySelectorAll(".tab").forEach((button) => {
  button.addEventListener("click", () => {
    selectView(button.dataset.view);
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
setInterval(() => {
  if (!document.hidden) loadAll();
}, 15000);

async function loadAll() {
  if (state.loading) return;
  state.loading = true;
  try {
    const [artifacts, commands, candidateStatuses] = await Promise.all([
      api("/api/artifacts"),
      api("/api/commands?limit=50"),
      api("/api/candidates/statuses")
    ]);
    state.artifacts = artifacts;
    state.commands = commands;
    state.candidateStatuses = Object.fromEntries(candidateStatuses.map((item) => [
      item.candidateKey,
      item.status
    ]));
    renderArtifacts();
    await loadEvents();
    renderCockpit();
    renderCommands();
    await loadConfigStatus();
  } finally {
    state.loading = false;
  }
}

function renderCockpit() {
  const primary = state.events.filter(isPrimaryEvent);
  const needTriage = primary.filter(isActionableNow);
  const highPriority = needTriage.filter((event) => ["high", "urgent"].includes(event.priority));
  const researchQueue = primary.filter((event) => event.type === "research_queue");
  const cnMarket = state.events.filter(isCnMarketEvent);
  const queueCommands = openClawQueueCommands(state.commands);
  const runningCommands = queueCommands.filter((command) => ["dispatched", "running"].includes(command.status));
  const results = openClawResults();
  const candidateDone = Object.values(state.candidateStatuses).filter((status) => normalizeCandidateState(status) === "OpenClaw 已产出").length;

  cockpitEl.innerHTML = `
    <button class="cockpit-card ${highPriority.length ? "is-hot" : ""}" data-cockpit-view="now">
      <span>今日待处理</span>
      <strong>${needTriage.length}</strong>
      <small>${highPriority.length ? `${highPriority.length} 个高优先级` : "没有高优先级积压"}</small>
    </button>
    <button class="cockpit-card" data-cockpit-view="research_queue">
      <span>待研究候选</span>
      <strong>${researchQueue.length}</strong>
      <small>Hermes / Governor 候选池</small>
    </button>
    <button class="cockpit-card ${cnMarket.length ? "is-active" : ""}" data-cockpit-view="cn_market">
      <span>A股成果</span>
      <strong>${cnMarket.length}</strong>
      <small>日报 / 涨停 / 龙头评分</small>
    </button>
    <button class="cockpit-card ${queueCommands.length ? "is-active" : ""}" data-cockpit-view="activity">
      <span>OpenClaw 流转</span>
      <strong>${queueCommands.length}</strong>
      <small>${runningCommands.length ? `${runningCommands.length} 个执行中` : "等待派发或执行"}</small>
    </button>
    <button class="cockpit-card" data-cockpit-view="artifacts">
      <span>已回流结果</span>
      <strong>${results.length}</strong>
      <small>${candidateDone ? `${candidateDone} 个候选已产出` : "查看 OpenClaw Markdown"}</small>
    </button>
  `;

  cockpitEl.querySelectorAll("[data-cockpit-view]").forEach((card) => {
    card.addEventListener("click", () => selectView(card.dataset.cockpitView));
  });
}

async function loadConfigStatus() {
  const [config, vaultImport] = await Promise.all([
    api("/api/config"),
    api("/api/import/vault")
  ]);
  if (config.vault?.configured) {
    const latestSnapshot = vaultImport.snapshots?.[0];
    const sync = vaultImport.sync || {};
    const statusText = vaultSyncStatusText(sync.status);
    const latestText = latestSnapshot
      ? `最近同步：${latestSnapshot.vaultPath} · ${formatDateTime(latestSnapshot.importedAt)}`
      : "等待首次同步";
    const nextText = sync.nextRunAt ? `下次：${formatDateTime(sync.nextRunAt)}` : "下次：等待调度";
    const runText = sync.latestRun
      ? `本轮扫描 ${sync.latestRun.scanned} 个，新增 ${sync.latestRun.imported} 个，失败 ${sync.latestRun.failed} 个`
      : "尚无同步记录";
    vaultStatus.className = `import-result sync-health ${syncHealthClass(sync.status)}`;
    vaultStatus.textContent = `${statusText} · Vault：${config.vault.rootPath} · ${latestText} · ${nextText} · ${runText}`;
  } else {
    vaultStatus.className = "import-result sync-health muted";
    vaultStatus.textContent = "Vault 未启用。可在 config/aiboard.config.json 中开启只读导入。";
  }
}

async function loadEvents() {
  const params = new URLSearchParams();
  params.set("limit", "500");
  if (state.query) params.set("q", state.query);
  state.events = await api(`/api/events?${params}`);
  if (state.selectedId && !isCompanyPackId(state.selectedId) && !state.events.some((event) => event.id === state.selectedId)) {
    state.selectedId = null;
  }
  await renderEvents();
}

async function selectView(view) {
  state.view = view;
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.view === view);
  });
  await renderEvents();
}

async function renderEvents() {
  const events = filteredEvents();
  if (state.selectedId && !isCompanyPackId(state.selectedId) && !events.some((event) => event.id === state.selectedId)) {
    state.selectedId = null;
  }
  const groupedEvents = groupCompanyResearchEvents(events);
  if (state.selectedId && !groupedEvents.some((item) => item.id === state.selectedId)) {
    state.selectedId = null;
  }

  if (!groupedEvents.length) {
    renderTabCounts();
    eventListEl.innerHTML = `<div class="empty-state">这个视图暂时没有事件</div>`;
    return;
  }

  renderTabCounts();

  eventListEl.innerHTML = groupedEvents.map((item) => `
    <article class="event-item ${item.id === state.selectedId ? "active" : ""}">
      <button class="event-card ${item.id === state.selectedId ? "active" : ""}" data-id="${item.id}">
        <div class="event-meta">
          ${item.kind === "company_pack" ? badge("company", "公司研究包") : badge(item.source, labels[item.source] || item.source)}
          ${item.kind === "company_pack" ? badge("tag", `${item.events.length} 个模块`) : badge(item.priority, labels[item.priority] || item.priority)}
          ${item.kind !== "company_pack" ? badge(item.status, labels[item.status] || item.status) : ""}
          ${item.kind !== "company_pack" && isDebugNoise(item) ? badge("debug", "调试") : ""}
        </div>
        <div class="event-card-head">
          <div class="event-title">${escapeHtml(item.title)}</div>
          <span class="event-toggle">${item.id === state.selectedId ? "收起" : "详情"}</span>
        </div>
        <div class="event-summary">${escapeHtml(item.kind === "company_pack" ? compactCompanyPackSummary(item) : compactEventSummary(item))}</div>
      </button>
      ${item.id === state.selectedId ? '<div id="eventDetail" class="event-detail inline-detail"></div>' : ""}
    </article>
  `).join("");

  eventListEl.querySelectorAll(".event-card").forEach((card) => {
    card.addEventListener("click", async () => {
      state.selectedId = state.selectedId === card.dataset.id ? null : card.dataset.id;
      await renderEvents();
    });
  });

  const inlineDetail = eventListEl.querySelector("#eventDetail");
  if (inlineDetail && state.selectedId) {
    await renderDetail(inlineDetail);
  }
}

function renderTabCounts() {
  document.querySelectorAll(".tab").forEach((tab) => {
    const view = tab.dataset.view;
    const count = countForView(view);
    tab.innerHTML = `
      <span>${escapeHtml(viewLabels[view] || tab.textContent)}</span>
      <span class="tab-count">${count}</span>
    `;
  });
}

function countForView(view) {
  const primary = state.events.filter(isPrimaryEvent);
  if (view === "now") return primary.filter(isActionableNow).length;
  if (view === "research_flow") return state.events.filter(isResearchFlowEvent).length;
  if (view === "cn_market") return state.events.filter(isCnMarketEvent).length;
  if (view === "activity") return primary.filter((event) => ["hermes", "openclaw"].includes(event.source)).length;
  if (view === "artifacts") return state.events.filter((event) => event.type === "artifact" && !isDebugNoise(event)).length;
  if (view === "debug") return state.events.filter(isDebugNoise).length;
  if (view === "history") return state.events.length;
  return primary.filter((event) => event.type === view).length;
}

function groupCompanyResearchEvents(events) {
  const groups = new Map();
  const output = [];

  for (const event of events) {
    const key = companyResearchKey(event);
    if (!key) {
      output.push(event);
      continue;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }

  for (const [key, group] of groups) {
    if (group.length < 3) {
      output.push(...group);
      continue;
    }
    output.push({
      id: `company_pack:${key}`,
      kind: "company_pack",
      key,
      title: `${key} 公司研究包`,
      events: group.sort((a, b) => moduleOrder(a.title) - moduleOrder(b.title))
    });
  }

  return output.sort((a, b) => {
    const aTime = a.kind === "company_pack" ? newestTime(a.events) : eventSortTime(a);
    const bTime = b.kind === "company_pack" ? newestTime(b.events) : eventSortTime(b);
    return String(bTime || "").localeCompare(String(aTime || ""));
  });
}

function isCompanyPackId(id) {
  return String(id || "").startsWith("company_pack:");
}

function companyResearchKey(event) {
  if (event.source !== "vault") return null;
  const title = String(event.title || "").trim();
  const match = title.match(/^([A-Z0-9]{1,8})(?:\s*[—-]\s*|\s+)(.+)$/);
  if (!match) return null;
  const key = match[1];
  const moduleName = match[2] || "";
  if (/估值|产业链|关键时间线|风险|跟踪|空方|多方|公司|概览|逻辑|分析/i.test(moduleName)) return key;
  return null;
}

function moduleOrder(title) {
  const order = ["公司", "概览", "产业链", "关键时间线", "风险", "跟踪", "空方", "多方", "估值"];
  const index = order.findIndex((item) => String(title).includes(item));
  return index === -1 ? 99 : index;
}

function newestTime(events) {
  return events.map((event) => eventSortTime(event)).filter(Boolean).sort().at(-1) || "";
}

function eventSortTime(event, view = state.view) {
  const reportTime = marketReportSortTime(event);
  if (reportTime) return reportTime;
  if (view === "cn_market" && isCnMarketEvent(event)) return "0000-01-01T00:00:00.000Z";
  return event.createdAt || "";
}

function marketReportSortTime(event) {
  const text = `${event.vaultPath || ""}\n${event.title || ""}`;
  const dashedDate = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (dashedDate) return `${dashedDate[1]}T23:59:59.999Z`;

  const compactDate = text.match(/(?:^|[^\d])(20\d{6})(?:[^\d]|$)/);
  if (!compactDate) return "";
  const value = compactDate[1];
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T23:59:59.999Z`;
}

function sortEventsForView(events, view = state.view) {
  return [...events].sort((a, b) => {
    const timeCompare = String(eventSortTime(b, view)).localeCompare(String(eventSortTime(a, view)));
    if (timeCompare !== 0) return timeCompare;
    return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
  });
}

function compactCompanyPackSummary(pack) {
  return pack.events.map((event) => moduleNameFromTitle(event.title, pack.key)).join(" · ");
}

function renderCompanyPackDetail(targetEl, packId) {
  const key = packId.replace("company_pack:", "");
  const packEvents = state.events
    .filter((event) => companyResearchKey(event) === key)
    .sort((a, b) => moduleOrder(a.title) - moduleOrder(b.title));

  if (!packEvents.length) {
    targetEl.innerHTML = `<div class="empty-state">这个公司研究包暂时没有可显示的模块</div>`;
    return;
  }

  targetEl.innerHTML = `
    <p class="detail-kicker">公司研究包</p>
    <div class="detail-meta">
      ${badge("company", key)}
      ${badge("tag", `${packEvents.length} 个模块`)}
    </div>
    <h3>${escapeHtml(key)} 公司研究包</h3>
    <div class="module-list">
      ${packEvents.map((event) => `
        <article class="module-item">
          <strong>${escapeHtml(moduleNameFromTitle(event.title, key))}</strong>
          <p>${escapeHtml(compactEventSummary(event))}</p>
          ${event.vaultPath ? `<div class="artifact-path">Vault: ${escapeHtml(event.vaultPath)}</div>` : ""}
        </article>
      `).join("")}
    </div>
  `;
}

function moduleNameFromTitle(title, key) {
  return String(title || "").replace(new RegExp(`^${key}\\s*[—-]?\\s*`), "").trim() || title;
}

async function renderDetail(targetEl) {
  if (!state.selectedId) {
    targetEl.innerHTML = `<div class="empty-state">请选择一个事件</div>`;
    return;
  }
  if (isCompanyPackId(state.selectedId)) {
    renderCompanyPackDetail(targetEl, state.selectedId);
    return;
  }

  const event = await api(`/api/events/${state.selectedId}`);
  const draftCommands = visibleDraftCommands(event.commands || []);
  targetEl.innerHTML = `
    <p class="detail-kicker">已选事件</p>
    <div class="detail-meta">
      ${badge(event.source, labels[event.source] || event.source)}
      ${badge(event.type, labels[event.type] || event.type)}
      ${badge(event.priority, labels[event.priority] || event.priority)}
      ${badge(event.status, labels[event.status] || event.status)}
      ${isDebugNoise(event) ? badge("debug", "调试") : ""}
    </div>
    <h3>${escapeHtml(event.title)}</h3>
    ${renderStructuredSummary(event)}
    ${event.vaultPath ? `<p class="muted">Vault: ${escapeHtml(event.vaultPath)}</p>` : ""}
    ${event.markdownPath ? `<p class="muted">Markdown: ${escapeHtml(event.markdownPath)}</p>` : ""}
    <div class="tags">
      ${(event.tags || []).map((tag) => badge("tag", tag)).join("")}
    </div>
    <section class="detail-section">
      <h2>OpenClaw 队列</h2>
      <div class="command-list compact">
        ${draftCommands.map(renderCommandItem).join("") || '<p class="muted">这个事件还没有 OpenClaw 队列。</p>'}
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

  const openMarkdown = targetEl.querySelector("[data-open-markdown]");
  if (openMarkdown) {
    openMarkdown.addEventListener("click", async () => {
      const content = await fetch(`/api/markdown/${openMarkdown.dataset.openMarkdown}`).then((res) => res.text());
      targetEl.querySelector("#markdownPreviewWrap").hidden = false;
      targetEl.querySelector("#markdownPreview").textContent = content;
    });
  }

  targetEl.querySelectorAll("[data-command-action]").forEach((button) => {
    button.addEventListener("click", async (clickEvent) => {
      clickEvent.stopPropagation();
      const action = actionFromButton(button, event.actions || []);
      if (!action) return;
      const candidate = button.dataset.candidate ? JSON.parse(button.dataset.candidate) : null;
      const rowEl = button.closest(".summary-row");
      button.disabled = true;
      const directState = candidate ? candidateActionMessage(action) : null;
      if (directState) {
        await saveCandidateState(event.id, candidate, directState);
        markCandidateRow(rowEl, directState);
        return;
      }
      await api("/api/commands", {
        method: "POST",
        body: JSON.stringify({
          eventId: event.id,
          kind: action.kind,
          target: action.target,
          payload: {
            ...(action.payload || {}),
            ...(candidate ? {
              title: [candidate.code, candidate.name].filter(Boolean).join(" "),
              summary: candidate.note,
              rawContent: formatCandidateForCommand(candidate),
              candidate
            } : {})
          }
        })
      });
      if (candidate) {
        const message = "已交给 OpenClaw";
        await saveCandidateState(event.id, candidate, message);
        markCandidateRow(rowEl, message);
      }
      state.commands = await api("/api/commands?limit=50");
      renderCommands();
    });
  });
}

function renderArtifacts() {
  const visibleArtifacts = state.artifacts.filter((artifact) => !isDebugArtifact(artifact)).slice(0, 12);
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

function renderStructuredSummary(event) {
  if (event.type === "cn_market_report") {
    return renderAshareReport(event.rawContent || event.summary || "");
  }

  const rows = parseMarkdownTableRows(event.rawContent || event.summary || "");
  if (rows.length) {
    if (!isCandidateTable(rows, event)) {
      return renderReadonlyTable(rows);
    }
    return `
      <div class="structured-summary">
        ${rows.slice(0, 8).map((row) => renderQueueRow(event.id, row, event.actions || [])).join("")}
        ${rows.length > 8 ? `<p class="muted">还有 ${rows.length - 8} 条，点“查看 Markdown”看完整内容。</p>` : ""}
      </div>
    `;
  }
  return `<p class="detail-summary">${escapeHtml(event.summary)}</p>`;
}

function renderAshareReport(content) {
  const sections = parseMarkdownSections(content);
  if (!sections.length) return `<p class="detail-summary">${escapeHtml(content)}</p>`;

  const roundOrder = ["第一报", "第二报", "第三报", "全日复盘"];
  const sortedSections = [...sections].sort((a, b) => {
    const aIndex = roundOrder.findIndex((name) => a.title.includes(name));
    const bIndex = roundOrder.findIndex((name) => b.title.includes(name));
    const safeA = aIndex === -1 ? 99 : aIndex;
    const safeB = bIndex === -1 ? 99 : bIndex;
    return safeA - safeB;
  });

  return `
    <div class="ashare-report">
      ${sortedSections.map((section) => `
        <article class="report-round">
          <div class="report-round-head">
            <strong>${escapeHtml(section.title)}</strong>
            ${badge(reportRoundBadgeClass(section.title), reportRoundStatus(section.title))}
          </div>
          ${renderMarkdownBlocks(section.body)}
        </article>
      `).join("")}
    </div>
  `;
}

function parseMarkdownSections(content) {
  const lines = String(content || "").split(/\r?\n/);
  const sections = [];
  let current = null;

  for (const line of lines) {
    const sectionMatch = line.match(/^##\s+(.+)$/);
    if (sectionMatch) {
      if (current) sections.push(current);
      current = { title: sectionMatch[1].trim(), body: [] };
      continue;
    }
    if (current) current.body.push(line);
  }

  if (current) sections.push(current);
  return sections.filter((section) => section.title && section.body.join("\n").trim());
}

function renderMarkdownBlocks(lines) {
  const blocks = [];
  let paragraph = [];
  let table = [];
  let list = [];

  const flushParagraph = () => {
    const text = paragraph.join(" ").trim();
    if (text) blocks.push(`<p>${escapeHtml(text)}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list.length) blocks.push(`<ul>${list.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`);
    list = [];
  };
  const flushTable = () => {
    if (!table.length) return;
    const rows = parseMarkdownTableRows(table.join("\n"), { keepHeader: true });
    if (rows.length) blocks.push(renderReadonlyTable(rows, { limit: 12, showMoreText: "查看原始输出可看完整表格。" }));
    table = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      flushList();
      flushTable();
      continue;
    }
    if (/^###\s+/.test(trimmed)) {
      flushParagraph();
      flushList();
      flushTable();
      blocks.push(`<h4>${escapeHtml(trimmed.replace(/^###\s+/, ""))}</h4>`);
      continue;
    }
    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      flushParagraph();
      flushList();
      table.push(trimmed);
      continue;
    }
    if (/^\d+\.\s+/.test(trimmed) || /^[-*]\s+/.test(trimmed)) {
      flushParagraph();
      flushTable();
      list.push(trimmed.replace(/^\d+\.\s+|^[-*]\s+/, ""));
      continue;
    }
    flushList();
    flushTable();
    paragraph.push(trimmed);
  }

  flushParagraph();
  flushList();
  flushTable();
  return blocks.join("");
}

function reportRoundBadgeClass(title) {
  if (title.includes("复盘")) return "high";
  if (title.includes("第三报")) return "openclaw";
  return "tag";
}

function reportRoundStatus(title) {
  if (title.includes("复盘")) return "收盘复盘";
  if (title.includes("第一报")) return "盘前/早盘";
  if (title.includes("第二报")) return "盘中";
  if (title.includes("第三报")) return "确认";
  return "报告";
}

function compactEventSummary(event) {
  const rows = parseMarkdownTableRows(event.rawContent || event.summary || "");
  if (!rows.length) return event.summary;
  if (!isCandidateTable(rows, event)) return `${rows.length} 行结构化表格`;

  const highPriorityCount = rows.filter((row) => row[4] === "高").length;
  const names = rows
    .slice(0, 3)
    .map((row) => row[2])
    .filter(Boolean)
    .join("、");
  const priorityText = highPriorityCount ? `，${highPriorityCount} 条高优先级` : "";
  const namesText = names ? `：${names}${rows.length > 3 ? "..." : ""}` : "";
  return `${rows.length} 条研究候选${priorityText}${namesText}`;
}

function isCandidateTable(rows, event) {
  if (event.type === "research_queue") return true;
  const candidateLikeRows = rows.filter(isCandidateRow);
  return candidateLikeRows.length >= 2 && candidateLikeRows.length >= Math.ceil(rows.length * 0.6);
}

function isCandidateRow(row) {
  const [date, market, codeCell, note, priority, status] = row;
  const firstCell = String(date || "").trim();
  const code = String(codeCell || "").trim();
  const maybeCode = code.split(/\s+/)[0] || "";
  const hasDate = /^\d{4}-\d{2}-\d{2}$/.test(firstCell);
  const hasMarket = /^(A股|港股|美股|HK|US|CN|NASDAQ|NYSE)$/i.test(String(market || "").trim());
  const hasTicker = /^(\d{4,6}|[A-Z]{1,6}(\.[A-Z]{1,3})?)$/.test(maybeCode);
  const hasPriority = ["高", "中", "低", "普通", "紧急"].includes(String(priority || "").trim());
  const hasResearchStatus = /待研究|研究中|已完成|持仓|观察/.test(String(status || ""));
  return Boolean(note && (hasDate || hasMarket) && hasTicker && (hasPriority || hasResearchStatus));
}

function renderReadonlyTable(rows, options = {}) {
  const limit = options.limit || 16;
  const width = Math.max(...rows.map((row) => row.length));
  return `
    <div class="readonly-table-wrap">
      <table class="readonly-table">
        <tbody>
          ${rows.slice(0, limit).map((row) => `
            <tr>
              ${Array.from({ length: width }).map((_, index) => `<td>${escapeHtml(row[index] || "")}</td>`).join("")}
            </tr>
          `).join("")}
        </tbody>
      </table>
      ${rows.length > limit ? `<p class="muted">还有 ${rows.length - limit} 行，${escapeHtml(options.showMoreText || "查看原始输出可看完整内容。")}</p>` : ""}
    </div>
  `;
}

function renderQueueRow(eventId, row, actions = []) {
  const [date, market, code, note, priority, status] = row;
  const candidate = candidateFromRow(row);
  const candidateJson = escapeHtml(JSON.stringify(candidate));
  const savedState = readCandidateState(eventId, candidate);
  const stateKind = candidateStateKind(savedState);
  const isHandled = Boolean(savedState);
  return `
    <article class="summary-row ${isHandled ? "has-row-result" : ""} ${stateKind ? `row-state-${stateKind}` : ""}">
      <div class="summary-row-head">
        <strong>${escapeHtml(code || "未命名")}</strong>
        <span>${escapeHtml(market || "")}</span>
        ${priority ? badge(priority === "高" ? "high" : "normal", priority) : ""}
        ${savedState ? badge("tag", savedState) : (status ? badge("tag", status) : "")}
      </div>
      <p>${escapeHtml(note || "")}</p>
      ${date ? `<div class="artifact-path">${escapeHtml(date)}</div>` : ""}
      <div class="row-actions">
        <span>建议动作</span>
        <div>
          ${candidateActions(actions).map((action) => `
            <button class="secondary-button row-action-button" data-command-action="${escapeHtml(action.id)}" data-command-kind="${escapeHtml(action.kind)}" data-command-target="${escapeHtml(action.target || "")}" data-command-payload="${escapeHtml(JSON.stringify(action.payload || {}))}" data-candidate="${candidateJson}" ${isHandled ? "disabled" : ""}>
              ${escapeHtml(actionLabel(action))}
            </button>
          `).join("") || '<span class="muted">暂无建议动作</span>'}
        </div>
      </div>
      <div class="row-result" ${savedState ? "" : "hidden"}>${escapeHtml(savedState || "")}</div>
    </article>
  `;
}

function candidateFromRow(row) {
  const [date, market, codeCell, note, priority, status] = row;
  const parts = String(codeCell || "").trim().split(/\s+/).filter(Boolean);
  return {
    date: date || null,
    market: market || null,
    code: parts[0] || codeCell || null,
    name: parts.slice(1).join(" ") || null,
    note: note || "",
    priority: priority || null,
    status: status || null
  };
}

function candidateActions(actions = []) {
  const byKey = new Map();
  const add = (action) => {
    const key = action.kind === "status" ? `${action.kind}:${action.payload?.status || ""}` : action.kind;
    byKey.set(key, {
      id: action.id || key,
      kind: action.kind,
      label: action.label,
      target: action.target,
      payload: action.payload || {}
    });
  };

  add({ id: "candidate_assign_openclaw", kind: "assign", label: "交给 OpenClaw", target: "openclaw" });
  for (const action of actions) {
    if (action.kind === "archive") add({ ...action, label: "暂不研究" });
    if (action.kind === "status" && action.payload?.status === "done") add(action);
  }
  if (!byKey.has("archive")) add({ id: "candidate_archive", kind: "archive", label: "暂不研究" });
  if (!byKey.has("status:done")) add({ id: "candidate_done", kind: "status", label: "已完成", payload: { status: "done" } });

  return [
    byKey.get("assign"),
    byKey.get("archive"),
    byKey.get("status:done")
  ].filter(Boolean);
}

function actionFromButton(button, actions = []) {
  const existing = actions.find((item) => item.id === button.dataset.commandAction);
  if (existing) return existing;
  return {
    id: button.dataset.commandAction,
    kind: button.dataset.commandKind,
    target: button.dataset.commandTarget || undefined,
    payload: button.dataset.commandPayload ? JSON.parse(button.dataset.commandPayload) : {}
  };
}

function formatCandidateForCommand(candidate) {
  const title = [candidate.code, candidate.name].filter(Boolean).join(" ");
  return [
    `研究标的：${title || "未命名"}`,
    candidate.market ? `市场：${candidate.market}` : "",
    candidate.priority ? `优先级：${candidate.priority}` : "",
    candidate.status ? `状态：${candidate.status}` : "",
    candidate.date ? `日期：${candidate.date}` : "",
    candidate.note ? `研究理由：${candidate.note}` : ""
  ].filter(Boolean).join("\n");
}

function candidateStateKey(eventId, candidate) {
  return `aiboard:candidate:${eventId}:${candidate.code || ""}:${candidate.name || ""}`;
}

function readCandidateState(eventId, candidate) {
  const key = candidateStateKey(eventId, candidate);
  return normalizeCandidateState(state.candidateStatuses[key] || localStorage.getItem(key));
}

async function saveCandidateState(eventId, candidate, message) {
  const candidateKey = candidateStateKey(eventId, candidate);
  state.candidateStatuses[candidateKey] = message;
  localStorage.setItem(candidateKey, message);
  await api("/api/candidates/statuses", {
    method: "POST",
    body: JSON.stringify({ eventId, candidateKey, status: message, candidate })
  });
}

function markCandidateRow(rowEl, message) {
  if (!rowEl) return;
  rowEl.classList.add("has-row-result");
  rowEl.classList.remove("row-state-done", "row-state-archived", "row-state-openclaw");
  const stateKind = candidateStateKind(message);
  if (stateKind) rowEl.classList.add(`row-state-${stateKind}`);
  rowEl.querySelectorAll(".row-action-button").forEach((button) => {
    button.disabled = true;
  });
  const resultEl = rowEl.querySelector(".row-result");
  if (resultEl) {
    resultEl.hidden = false;
    resultEl.textContent = message;
  }
}

function candidateActionMessage(action) {
  if (action.kind === "archive") return "已暂不研究";
  if (action.kind === "status" && action.payload?.status === "done") return "已完成";
  return null;
}

function normalizeCandidateState(message) {
  if (message === "已加入命令草稿") return "已交给 OpenClaw";
  if (message === "已归档") return "已暂不研究";
  return message || "";
}

function candidateStateKind(message) {
  if (message === "已完成") return "done";
  if (message === "已暂不研究") return "archived";
  if (message === "已交给 OpenClaw" || message === "OpenClaw 已产出") return "openclaw";
  return "";
}

function parseMarkdownTableRows(content, options = {}) {
  return String(content || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|"))
    .filter((line) => !/^\|\s*-+/.test(line))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 4)
    .filter((cells) => options.keepHeader || !["日期", "市场"].includes(cells[0]));
}

function renderCommands() {
  const queueCommands = openClawQueueCommands(state.commands);
  const results = openClawResults();
  commandCountEl.textContent = `${queueCommands.length} 个队列 / ${results.length} 个结果`;
  commandListEl.innerHTML = `
    <div class="work-section">
      <h3>待执行队列</h3>
      <div class="command-list compact">
        ${queueCommands.map((command) => renderCommandItem(command)).join("") || `<div class="empty-state compact-empty">暂时没有 OpenClaw 队列</div>`}
      </div>
    </div>
    <div class="work-section">
      <h3>已产出文件</h3>
      <div class="artifact-list">
        ${results.map(renderOpenClawResultItem).join("") || `<div class="empty-state compact-empty">暂时还没有 OpenClaw 输出文件</div>`}
      </div>
    </div>
  `;
  commandListEl.querySelectorAll("[data-open-result-markdown]").forEach((button) => {
    button.addEventListener("click", async () => {
      const content = await fetch(`/api/markdown/${button.dataset.openResultMarkdown}`).then((res) => res.text());
      openClawPreviewWrap.hidden = false;
      openClawPreview.textContent = content;
    });
  });
}

function openClawQueueCommands(commands) {
  return uniqueCommands(commands.filter((command) => {
    if (!["draft", "dispatched", "running"].includes(command.status)) return false;
    if (command.target !== "openclaw") return false;
    if (isDebugCommand(command)) return false;
    if (command.payload?.status === "done") return false;
    const candidate = command.payload?.candidate;
    if (!candidate) return true;
    const stateText = readCandidateState(command.eventId, candidate);
    return !stateText || stateText === "已交给 OpenClaw";
  }));
}

function openClawResults() {
  const byPath = new Map();
  for (const event of state.events) {
    if (event.source !== "openclaw") continue;
    if (isDebugNoise(event)) continue;
    if (!event.markdownPath) continue;
    byPath.set(event.markdownPath, {
      title: event.title,
      summary: event.summary,
      path: event.markdownPath,
      createdAt: event.createdAt
    });
  }
  for (const artifact of state.artifacts) {
    if (!String(artifact.path || "").includes("/openclaw/")) continue;
    byPath.set(artifact.path, {
      title: artifact.title,
      summary: "OpenClaw Markdown 输出",
      path: artifact.path,
      createdAt: artifact.createdAt
    });
  }
  return [...byPath.values()]
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, 8);
}

function renderOpenClawResultItem(result) {
  return `
    <article class="artifact-item">
      <div>
        <div class="event-meta">
          ${badge("openclaw", "OpenClaw")}
          ${badge("completed", "已产出")}
        </div>
        <strong>${escapeHtml(result.title)}</strong>
        <div class="artifact-path">${escapeHtml(result.path)}</div>
      </div>
      <button class="secondary-button" data-open-result-markdown="${encodeURIComponent(result.path)}">查看</button>
    </article>
  `;
}

function visibleDraftCommands(commands) {
  return uniqueCommands(commands.filter((command) => {
    if (command.status !== "draft") return false;
    if (isDebugCommand(command)) return false;
    if (command.payload?.status === "done") return false;
    const candidate = command.payload?.candidate;
    if (!candidate) return true;
    const stateText = readCandidateState(command.eventId, candidate);
    return !stateText || stateText === "已交给 OpenClaw";
  }));
}

function uniqueCommands(commands) {
  const seen = new Set();
  return commands.filter((command) => {
    const candidate = command.payload?.candidate || {};
    const key = [
      command.target,
      command.commandType,
      command.payload?.title,
      candidate.code,
      candidate.name,
      command.payload?.rawContent
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
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
    archive: "暂不研究",
    status: action.payload?.status ? (labels[action.payload.status] || "更新状态") : "更新状态",
    assign: "交给 OpenClaw",
    ask_follow_up: action.target === "openclaw" ? "追问 OpenClaw" : "追问 Hermes",
    update_vault: "更新 Vault",
    open_artifact: "查看输出"
  };
  return byKind[action.kind] || action.label || "创建命令";
}

function filteredEvents() {
  const visibleEvents = state.events.filter(isPrimaryEvent);
  let events;
  if (state.view === "now") {
    events = visibleEvents.filter(isActionableNow);
  } else if (state.view === "research_flow") {
    events = state.events.filter(isResearchFlowEvent);
  } else if (state.view === "cn_market") {
    events = state.events.filter(isCnMarketEvent);
  } else if (state.view === "activity") {
    events = visibleEvents.filter((event) => ["hermes", "openclaw"].includes(event.source));
  } else if (state.view === "artifacts") {
    events = state.events.filter((event) => event.type === "artifact" && !isDebugNoise(event));
  } else if (state.view === "debug") {
    events = state.events.filter(isDebugNoise);
  } else if (state.view === "history") {
    events = state.events;
  } else {
    events = visibleEvents.filter((event) => event.type === state.view);
  }
  return sortEventsForView(events, state.view);
}

function isResearchFlowEvent(event) {
  if (isDebugNoise(event)) return false;
  const tags = event.tags || [];
  if (["research_queue", "tracking_update", "decision", "cn_market_report", "limit_up_report", "us_market_report", "hk_market_report", "jp_market_report"].includes(event.type)) return true;
  if (event.vaultPath && /研究队列|持仓|tracking|sectors|governor|A股研究|美股研究|港股研究|日股研究/i.test(event.vaultPath)) return true;
  return tags.some((tag) => ["research", "market", "sector", "company", "governor"].includes(String(tag).toLowerCase()));
}

function isPrimaryEvent(event) {
  if (isDebugNoise(event)) return false;
  if (event.status === "archived") return false;
  if (["research_queue", "tracking_update", "finding", "task", "question", "alert", "decision", "status", "cn_market_report", "limit_up_report", "us_market_report", "hk_market_report", "jp_market_report", "system_report"].includes(event.type)) {
    return true;
  }
  if (event.source !== "vault" && event.type === "artifact") return true;
  return false;
}

function isActionableNow(event) {
  if (!["new", "triaged", "in_progress"].includes(event.status)) return false;
  if (isDebugNoise(event)) return false;
  return ["research_queue", "tracking_update", "question", "alert", "decision", "task"].includes(event.type);
}

function isCnMarketEvent(event) {
  if (isDebugNoise(event) || event.status === "archived") return false;
  return event.type === "cn_market_report"
    || event.type === "limit_up_report"
    || String(event.vaultPath || "").startsWith("A股研究/");
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

function formatDateTime(value) {
  if (!value) return "未知时间";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function vaultSyncStatusText(status) {
  const byStatus = {
    ok: "Vault 同步健康",
    running: "Vault 正在同步",
    degraded: "Vault 同步有失败项",
    stale: "Vault 同步过期",
    error: "Vault 同步异常",
    disabled: "Vault 未启用",
    unknown: "Vault 等待同步"
  };
  return byStatus[status] || byStatus.unknown;
}

function syncHealthClass(status) {
  if (status === "ok") return "sync-ok";
  if (status === "running") return "sync-running";
  if (["degraded", "stale"].includes(status)) return "sync-warn";
  if (status === "error") return "sync-error";
  return "muted";
}
