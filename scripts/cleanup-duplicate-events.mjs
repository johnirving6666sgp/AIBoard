// 一次性清理：同一 vault_path 的重复事件只保留一条（优先保留 vault_snapshots 指向的事件，
// 否则保留最新创建的），其余事件连同其 artifacts 一并删除，候选状态迁移到保留的事件上。
//
// 用法：
//   node scripts/cleanup-duplicate-events.mjs --dry-run   # 只打印将要做什么
//   node scripts/cleanup-duplicate-events.mjs             # 实际执行（自动先备份数据库）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptsDir, "..");
const dbPath = process.env.AIBOARD_DB || path.join(rootDir, "data", "aiboard.sqlite");
const dryRun = process.argv.includes("--dry-run");

if (!fs.existsSync(dbPath)) {
  console.error(`数据库不存在：${dbPath}`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON;");

const duplicates = db.prepare(`
  SELECT vault_path, COUNT(*) AS c FROM events
  WHERE vault_path IS NOT NULL
  GROUP BY vault_path HAVING c > 1
  ORDER BY c DESC
`).all();

if (!duplicates.length) {
  console.log("没有发现重复的 vault 事件，无需清理。");
  process.exit(0);
}

const selectEventsForPath = db.prepare(`
  SELECT id, created_at, status FROM events WHERE vault_path = ? ORDER BY created_at DESC
`);
const selectSnapshot = db.prepare(`SELECT event_id FROM vault_snapshots WHERE vault_path = ?`);
const selectCandidateStatuses = db.prepare(`SELECT * FROM candidate_statuses WHERE event_id = ?`);

let totalRemoved = 0;
let totalArtifactsRemoved = 0;
let totalCandidatesMigrated = 0;
const plan = [];

for (const { vault_path: vaultPath, c } of duplicates) {
  const events = selectEventsForPath.all(vaultPath);
  const snapshotEventId = selectSnapshot.get(vaultPath)?.event_id || null;
  const keep = events.find((event) => event.id === snapshotEventId) || events[0];
  const remove = events.filter((event) => event.id !== keep.id);
  plan.push({ vaultPath, count: c, keepId: keep.id, removeIds: remove.map((event) => event.id) });
}

console.log(`发现 ${duplicates.length} 个重复路径，共需删除 ${plan.reduce((sum, item) => sum + item.removeIds.length, 0)} 条重复事件。`);

if (dryRun) {
  for (const item of plan) {
    console.log(`[dry-run] ${item.vaultPath}: ${item.count} 条 → 保留 ${item.keepId}，删除 ${item.removeIds.length} 条`);
  }
  process.exit(0);
}

// 备份数据库（先把 WAL 合并进主文件再复制）
const backupDir = path.join(path.dirname(dbPath), "backups");
fs.mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
const backupPath = path.join(backupDir, `aiboard-before-dedup-${stamp}.sqlite`);
db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
fs.copyFileSync(dbPath, backupPath);
console.log(`已备份数据库到 ${backupPath}`);

const migrateCandidate = db.prepare(`
  INSERT INTO candidate_statuses (event_id, candidate_key, status, candidate_json, updated_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(event_id, candidate_key) DO UPDATE SET
    status = excluded.status,
    candidate_json = excluded.candidate_json,
    updated_at = excluded.updated_at
  WHERE excluded.updated_at > candidate_statuses.updated_at
`);
const deleteArtifactsForEvent = db.prepare(`DELETE FROM artifacts WHERE event_id = ?`);
const deleteEvent = db.prepare(`DELETE FROM events WHERE id = ?`);
const repointSnapshot = db.prepare(`UPDATE vault_snapshots SET event_id = ? WHERE vault_path = ?`);
const countArtifacts = db.prepare(`SELECT COUNT(*) AS c FROM artifacts WHERE event_id = ?`);

db.exec("BEGIN");
try {
  for (const item of plan) {
    for (const removeId of item.removeIds) {
      // 把旧事件上的候选状态迁移到保留的事件（key 里包含 eventId，需要重写）
      for (const row of selectCandidateStatuses.all(removeId)) {
        const newKey = String(row.candidate_key).replace(removeId, item.keepId);
        migrateCandidate.run(item.keepId, newKey, row.status, row.candidate_json, row.updated_at);
        totalCandidatesMigrated += 1;
      }
      totalArtifactsRemoved += countArtifacts.get(removeId).c;
      deleteArtifactsForEvent.run(removeId);
      deleteEvent.run(removeId); // actions / candidate_statuses 级联删除
      totalRemoved += 1;
    }
    repointSnapshot.run(item.keepId, item.vaultPath);
  }
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  console.error("清理失败，已回滚：", error.message);
  process.exit(1);
}

db.exec("VACUUM;");
console.log(`完成：删除重复事件 ${totalRemoved} 条、关联 artifacts ${totalArtifactsRemoved} 条，迁移候选状态 ${totalCandidatesMigrated} 条。`);
console.log("如需回滚，直接用备份文件覆盖 data/aiboard.sqlite 即可。");
