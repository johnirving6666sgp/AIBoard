export const SOURCES = ["hermes", "openclaw", "vault", "manual"];

export const EVENT_TYPES = [
  "status",
  "finding",
  "task",
  "question",
  "alert",
  "artifact",
  "decision",
  "research_queue",
  "tracking_update"
];

export const STATUSES = ["new", "triaged", "in_progress", "done", "archived"];

export const PRIORITIES = ["low", "normal", "high", "urgent"];

export const SOURCE_LABELS = {
  hermes: "Hermes",
  openclaw: "OpenClaw",
  vault: "Vault",
  manual: "手动"
};

export const TYPE_LABELS = {
  status: "状态",
  finding: "发现",
  task: "任务",
  question: "待确认",
  alert: "提醒",
  artifact: "产出",
  decision: "决策",
  research_queue: "研究队列",
  tracking_update: "跟踪更新"
};
