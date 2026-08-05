// 后台命令执行器：让"交给 OpenClaw"真正自动跑起来。
//
// - 每隔 intervalMs 轮询一次：
//   1. 自动派发最近 24 小时内创建的 openclaw 草稿命令（更早的旧草稿保持不动，避免部署后突然批量执行历史遗留）
//   2. 取最早的 dispatched 命令串行执行（一次一条，避免并发打爆本机 agent）
// - 进程启动时把遗留的 running 命令重新排队（单进程执行，重启后不可能还在跑）
// - 关闭自动派发：AIBOARD_AUTO_DISPATCH=0
import { listDispatchedCommands, resetOrphanRunningCommands } from "./db.js";
import { runCommandById } from "./agent-adapters.js";
import { dispatchCommand, queryCommands } from "./command-service.js";

const AUTO_DISPATCH_WINDOW_MS = 24 * 60 * 60 * 1000;
let workerBusy = false;

export function startCommandWorker({ intervalMs = 15000, autoDispatch } = {}) {
  const auto = autoDispatch ?? process.env.AIBOARD_AUTO_DISPATCH !== "0";
  resetOrphanRunningCommands();

  let timer;
  const tick = async () => {
    try {
      await runWorkerOnce({ autoDispatch: auto });
    } catch (error) {
      console.error("Command worker failed:", error);
    } finally {
      timer = setTimeout(tick, intervalMs);
      timer.unref?.();
    }
  };

  timer = setTimeout(tick, 5000);
  timer.unref?.();
  return () => clearTimeout(timer);
}

export async function runWorkerOnce({ autoDispatch = true, limit = 1 } = {}) {
  if (workerBusy) return { busy: true, dispatched: 0, processed: 0, results: [] };
  workerBusy = true;

  try {
    let dispatched = 0;
    if (autoDispatch) {
      const cutoff = Date.now() - AUTO_DISPATCH_WINDOW_MS;
      const drafts = queryCommands({ status: "draft", limit: 50 }).filter((command) => {
        if (command.target !== "openclaw") return false;
        if (command.payload?.status === "done") return false;
        const createdAt = new Date(command.createdAt || 0).getTime();
        return createdAt >= cutoff;
      });
      for (const command of drafts) {
        const result = await dispatchCommand(command.id);
        if (result?.dispatched) dispatched += 1;
      }
    }

    const pending = listDispatchedCommands(limit);
    const results = [];
    for (const command of pending) {
      results.push(await runCommandById(command.id));
    }

    return {
      busy: false,
      dispatched,
      processed: results.length,
      completed: results.filter((item) => item?.status === "completed").length,
      failed: results.filter((item) => item?.status === "failed").length,
      retrying: results.filter((item) => item?.status === "retrying").length,
      results
    };
  } finally {
    workerBusy = false;
  }
}
