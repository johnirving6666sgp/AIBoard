import { countEvents } from "./db.js";
import { createEvent } from "./event-service.js";

const seeds = [
  {
    source: "hermes",
    type: "research_queue",
    priority: "high",
    title: "Hermes 标记了一家公司待研究",
    summary: "Hermes 发现一个可能值得做单家公司深度研究的市场信号。",
    rawContent: `Hermes 市场扫描完成。

信号：一家 AI 基础设施供应商反复出现在行业笔记中。
原因：客户扩张被多次提及，同时毛利率评论改善。
建议下一步：加入 研究队列.md，并让 OpenClaw 做聚焦深度研究。`,
    vaultPath: "研究队列.md",
    tags: ["research", "market", "company"]
  },
  {
    source: "openclaw",
    type: "artifact",
    priority: "normal",
    title: "OpenClaw 完成公司深度研究笔记",
    summary: "OpenClaw 生成了一份公司研究笔记，等待 James 审阅。",
    rawContent: `OpenClaw 深度研究完成。

产出：公司研究笔记，包含商业模式、催化剂地图、关键风险和决策清单。
待处理：James 审阅，并视情况更新 持仓与跟踪.md。`,
    vaultPath: "companies/example-company.md",
    tags: ["research", "artifact", "company"]
  },
  {
    source: "vault",
    type: "tracking_update",
    priority: "normal",
    title: "持仓跟踪需要后续处理",
    summary: "一家公司仍有待验证催化剂，应继续留在跟踪视图中。",
    rawContent: `检测到 持仓与跟踪.md 更新。

待跟进：复盘 earnings call 文字稿。
决策状态：等待 OpenClaw 研究更新后，再决定是否调整仓位。`,
    vaultPath: "持仓与跟踪.md",
    tags: ["tracking", "decision"]
  },
  {
    source: "hermes",
    type: "status",
    priority: "low",
    status: "in_progress",
    title: "行业定时扫描运行中",
    summary: "Hermes 正在运行定时行业扫描，并通过 Governor 路由候选标的。",
    rawContent: `Hermes cron 组已启动。

Sector Agent：运行中。
Functional Pipeline：运行中。
Governor 路由：正在收集下一轮复盘候选。`,
    tags: ["sector", "governor"]
  }
];

export async function seedIfEmpty() {
  if (countEvents() > 0) return false;
  for (const seed of seeds) {
    await createEvent(seed);
  }
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const seeded = await seedIfEmpty();
  console.log(seeded ? "Seeded AIBoard sample events." : "Seed skipped; events already exist.");
}
