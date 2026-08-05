# AIBoard 项目交接说明

这份文档用于把 AIBoard 项目快速交给 Claude 或其他工程助手继续优化。请优先阅读本文件，再看代码。

> 最后校对：2026-08-06。项目已于 2026-08-02 从 `~/Documents/Codex/2026-05-20/aiboardinhk`
> 迁移到 `~/Projects/AIBoard`（避开 macOS 对 `Documents` 下后台进程的隐私限制），
> 旧目录只剩这份文档的副本，不要再往那里写代码。

## 一句话定位

AIBoard 是一个本地优先的 Agent 输出驾驶舱。

它的目标不是替代 OpenClaw 或 Hermes，而是把它们产生的大量研究输出，从 Telegram/零散 Markdown 中收拢到一个网页界面里，让用户每天可以快速看到：

- 哪些研究结果刚产生
- 哪些候选需要处理
- 哪些内容已经交给 OpenClaw 深度研究
- 哪些报告已经沉淀到 Vault
- 哪些链路出现异常

## 当前核心目标

用户希望 AIBoard 成为每天真正使用的“研究驾驶舱”，重点关注：

- A股多轮报告：第一报、第二报、第三报、全日复盘
- 研究队列：Hermes 或 Vault 产生的待研究候选
- OpenClaw 队列：已经派发给 OpenClaw 的深度研究任务
- 公司研究包：同一家公司多个模块的聚合展示
- Vault 实时同步：本地 Markdown 文件变化后自动出现在网页
- 系统健康：Vault 同步、Agent 输出回流、OpenClaw/Hermes 运行状态

## 角色分工

### Hermes

定位：自进化智能体，负责定时扫描、长期记忆、自动学习和研究队列生成。

典型职责：

- A股第一报、第二报、第三报、全日复盘
- 美股、港股、日股市场扫描
- Governor / Priority Queue
- Sector Agent / Functional Pipeline
- 将输出写入 Obsidian Vault

### OpenClaw

定位：生态协调者和深度研究执行者。

典型职责：

- 对单只公司做深度研究
- 产出公司研究包
- 接收 AIBoard 中“交给 OpenClaw”的候选
- 生成本地 Markdown 输出

### AIBoard

定位：网页驾驶舱和同步层。

典型职责：

- 读取 Vault / Agent output / SQLite
- 将 Markdown 内容结构化展示
- 提供“交给 OpenClaw / 暂不研究 / 已完成 / 归档”等轻量操作
- 把 Agent 输出同时保留为本地 Markdown

## 当前数据流

```text
Hermes cron
  -> /Users/lobai/JohnAI/A股研究/日报/YYYY-MM-DD.md
  -> /Users/lobai/JohnAI/研究队列.md
  -> /Users/lobai/JohnAI/governor/priority_queue.md
  -> AIBoard Vault watcher
  -> SQLite events
  -> Web UI

AIBoard UI action
  -> command draft / dispatched command
  -> OpenClaw queue / local markdown command file
  -> OpenClaw output
  -> agent-output markdown
  -> AIBoard UI
```

## 关键本地路径

项目代码：

```text
/Users/lobai/Projects/AIBoard
```

Vault：

```text
/Users/lobai/JohnAI
```

Hermes 配置和 session：

```text
/Users/lobai/.hermes/cron/jobs.json
/Users/lobai/.hermes/sessions
/Users/lobai/.hermes/scripts
```

AIBoard 数据库：

```text
data/aiboard.sqlite
```

Agent 输出目录：

```text
agent-output/
```

## 主要代码结构

```text
apps/server/src/server.js            # 后端入口
apps/server/src/db.js                # SQLite 表和查询
apps/server/src/vault-importer.js    # Vault Markdown 导入
apps/server/src/normalizer.js        # 事件归一化
apps/server/src/command-service.js   # 命令草稿/派发/状态机
apps/server/src/command-worker.js    # 后台自动派发与串行执行
apps/server/src/agent-adapters.js    # OpenClaw/Hermes adapter
apps/web/public/index.html           # 前端 HTML
apps/web/public/app.js               # 前端主逻辑
apps/web/public/styles.css           # 前端样式
config/aiboard.config.json           # AIBoard 配置
scripts/healthcheck.mjs              # 健康检查
wrangler.toml                        # Cloudflare Workers/Assets 配置
```

## 当前部署方式

本地服务：

```text
http://127.0.0.1:4173
```

公网访问通过 Cloudflare Tunnel：

```text
https://aiboardhk.giantdawn.com/
```

已知 launchd：

```text
com.aiboard.local
com.aiboardhk.tunnel
```

说明：

Cloudflare Worker / Pages 只能部署静态前端，不能直接访问本机 Vault、SQLite、OpenClaw 和 Hermes。因此当前真正可用的线上形态是 Cloudflare Tunnel 指向本地 AIBoard 服务。

## 常用命令

```bash
npm run check
npm run import:vault
npm run healthcheck
npm run cleanup:duplicates
npm run start
```

健康接口：

```bash
curl http://127.0.0.1:4173/api/health
```

注意：公网域名现在挂在 Cloudflare Access 后面，未登录时 `curl` 会拿到 302
跳转到 `*.cloudflareaccess.com`，不是服务故障。探活请用本地 127.0.0.1。

## 当前已解决的问题

### 1. 不再接 Telegram

项目方向已经明确：不再把 Telegram 作为主要展示面。Telegram 可以保留为通知渠道，但 AIBoard 才是主界面。

### 2. Vault 实时同步

AIBoard 已经接入 Vault，并监听以下类型内容：

- `companies/`
- `sectors/`
- `governor/`
- `A股研究/`
- `美股研究/`
- `港股研究/`
- `日股研究/`
- `operations/`

### 3. A股成果展示

前端已有 `A股成果` 视图，可以展示：

- A股日报
- 龙头评分池
- 本周校准报告

A股日报按 Markdown 二级标题拆成多轮卡片：

- 第一报
- 第二报
- 第三报
- 全日复盘

### 4. A股时间排序

曾经按 `createdAt` 排序，导致历史文件批量导入后顺序乱。

现在前端会从 `vaultPath` 或 `title` 中提取真实报告日期，例如：

```text
A股研究/日报/2026-05-29.md
```

再按真实日期倒序展示。

### 5. A股一报/二报未读取问题

2026-05-29 的问题根因：

- Hermes 一报、二报 cron 实际跑过
- session 中有输出
- 但没有成功追加进当天 Vault 日报
- 17:00 全日复盘只读到了三报
- 所以写出了 `(未读取)`

已做的修复：

- 从 Hermes session 回填 2026-05-29 的一报、二报
- 修正当天全日复盘命中表
- 在 Hermes wrapper 增加守门机制：
  - 二报前补一报
  - 三报前补一报、二报
  - 全日复盘前补一报、二报、三报

相关外部文件：

```text
/Users/lobai/.hermes/scripts/_wrapper_helpers.py
/Users/lobai/.hermes/scripts/run_a_share_second.py
/Users/lobai/.hermes/scripts/run_a_share_third.py
/Users/lobai/.hermes/scripts/run_a_share_review.py
```

注意：这些 Hermes wrapper 文件在项目 repo 外部，不一定已经进入 AIBoard GitHub 仓库。

## 仍然不够顺的地方

### 1. AIBoard 对 Vault 文件更新的处理可能会产生重复事件

**已修（2026-08-02）**：importer 以 `vault_path` 为稳定键做 upsert，同一路径内容变化时
更新原 event 并覆写归档 Markdown；历史重复事件用 `npm run cleanup:duplicates` 清理过一轮。
版本历史（revisions 表）仍未做。

原始描述：当前 Vault importer 在文件内容变化时可能创建新 event，而不是稳定更新同一路径的已有 event。

建议优化：

- 以 `vault_path` 作为稳定唯一键
- 同一 Vault 文件内容变化时更新原 event
- 保留版本历史可以单独做 revisions 表
- 前端只展示最新版本，避免同一路径重复卡片

### 2. Vault snapshot 有时不直观

**已修（2026-08-02）**：`POST /api/vault/reimport` 与事件详情里的「重新读取 Vault」按钮已上线。

如果文件被外部脚本修复，AIBoard 可能需要等待 watcher 或手动 import 才刷新。

建议优化：

- 提供单文件强制刷新接口，例如：

```text
POST /api/vault/reimport
{ "vaultPath": "A股研究/日报/2026-05-29.md" }
```

- UI 增加“重新读取 Vault”按钮，仅刷新当前事件

### 3. A股日报完整性应该在 AIBoard 上有状态灯

**已修（2026-08-02）**：日报卡片直接显示四段完整性，缺段时提供「从 Hermes session 补回」
按钮（派发 `backfill_report` 命令给 Hermes）。

当前用户要点进详情才知道缺不缺一报/二报。

建议在 A股成果列表上直接显示：

```text
第一报 ✅ / 第二报 ✅ / 第三报 ✅ / 复盘 ✅
```

如果缺段：

```text
第一报 缺失
第二报 缺失
```

并且提供：

```text
尝试从 Hermes session 补回
```

### 4. OpenClaw 执行后的文件入口还可以更清晰

用户曾问：“在哪里看 OpenClaw 执行后的文件？”

建议：

- 每个“交给 OpenClaw”的候选卡片下显示状态：
  - 已派发
  - 运行中
  - 已产出
  - 失败
- 如果已有输出，直接展示：
  - 查看研究结果
  - 打开 Markdown
  - Vault 路径

### 5. 首页还可以更像“驾驶舱”

当前首页已比最初简洁，但还可以进一步收敛为用户每天真正用的 4 个区块：

- 今日需要处理
- 今日 A股报告
- OpenClaw 进行中/已完成
- 系统健康

其他视图放进二级导航。

## Claude 优化重点建议

请 Claude 优先从以下问题入手：

### P0：稳定性

1. Vault 同一路径事件去重和更新。
2. A股日报四段完整性检测。
3. OpenClaw/Hermes 输出回流状态机。
4. 健康检查覆盖 launchd、Vault watcher、Cloudflare Tunnel。

### P1：信息架构

1. 首页收敛为“每日研究驾驶舱”。
2. A股成果做日报聚合，而不是普通事件列表。
3. 公司研究包只展示有实际内容的详情按钮。
4. 建议动作放在具体候选附近，不要全局孤立展示。

### P2：产品体验

1. 所有状态操作点击后必须有视觉反馈。
2. 已归档/已完成/已交给 OpenClaw 的卡片状态要明显不同。
3. 移动端优先优化 A股日报阅读体验。
4. Markdown 表格在手机上要能横向滚动或转卡片展示。

## Claude 看代码时的切入点

建议 Claude 按这个顺序读：

1. `apps/server/src/server.js`
2. `apps/server/src/db.js`
3. `apps/server/src/vault-importer.js`
4. `apps/server/src/normalizer.js`
5. `apps/server/src/command-service.js`
6. `apps/web/public/app.js`
7. `apps/web/public/styles.css`
8. `config/aiboard.config.json`

如果要看 Hermes A股链路，再读：

1. `/Users/lobai/.hermes/cron/jobs.json`
2. `/Users/lobai/.hermes/scripts/run_a_share_first.py`
3. `/Users/lobai/.hermes/scripts/run_a_share_second.py`
4. `/Users/lobai/.hermes/scripts/run_a_share_third.py`
5. `/Users/lobai/.hermes/scripts/run_a_share_review.py`
6. `/Users/lobai/.hermes/scripts/_wrapper_helpers.py`
7. `/Users/lobai/.hermes/sessions/session_cron_*`

## 不要误判的点

### AIBoard 不是独立 SaaS

它依赖本机：

- Vault
- SQLite
- Hermes
- OpenClaw
- launchd
- Cloudflare Tunnel

所以“部署到 Cloudflare Worker 后完全独立运行”不是当前目标。

### Telegram 不是主链路

不要再围绕 Telegram 做主功能。最多保留通知。

### AIBoard 不应该重新生成研究内容

AIBoard 负责展示、路由、状态和回流，不负责替代 Hermes/OpenClaw 做推理。

### Vault 是共享状态层

Vault 里的 Markdown 是最终可读资产，AIBoard 只是把它变成更好操作的界面。

## 建议的下一轮优化方案

### Phase 1：数据层稳定

- 为 Vault event 增加 upsert by `vault_path`
- 增加 `source_updated_at` 或 `content_hash`
- 清理重复历史事件
- 增加单文件 reimport API

### Phase 2：A股日报产品化

- 后端解析 A股日报四段状态
- 前端 A股成果列表展示四段完整性
- 缺段时提示“可从 Hermes session 补回”
- 全日复盘表避免显示 `(未读取)` 这种半成品状态

### Phase 3：OpenClaw 回流闭环

**已完成（2026-08-02）**：状态机 + 后台 worker 已上线，转移收敛到白名单，
失败可重试，`dispatched_at/started_at/finished_at/result_event_id/error/attempts` 全部落库。
仍未做：按公司聚合 OpenClaw 结果。

- 命令状态机：
  - draft
  - dispatched
  - running
  - completed
  - failed
- 每个候选直接显示 OpenClaw 输出入口
- 支持按公司聚合 OpenClaw 结果

### Phase 4：首页收敛

首页只保留：

- 今日待处理
- 今日 A股
- OpenClaw 状态
- 系统健康

其他内容进入二级页。

## 当前给 Claude 的一句话任务

请优化 AIBoard 的数据一致性和每日研究驾驶舱体验，重点解决 Vault 同路径重复事件、A股日报多轮完整性检测、OpenClaw 输出回流状态、首页信息架构收敛，并保持当前“不接 Telegram、以 Vault Markdown 为共享状态层”的方向不变。
