# AIBoard

AIBoard is a lightweight operating console for coordinating local AI agents.

The first use case is to pull output from OpenClaw and Hermes into a web interface so agent activity does not become an unreadable stream of logs and messages. Instead of mirroring raw output, AIBoard turns agent work into structured events, triage items, artifacts, and follow-up actions.

In the existing workflow, Hermes performs broad scheduled scanning, OpenClaw performs directed deep research, James makes decisions, and the Obsidian Vault acts as the shared state layer. AIBoard sits above that workflow as the review, triage, and action surface.

## Product Goal

Give the human operator a calm place to:

- See what needs attention now
- Review compressed agent activity
- Open generated artifacts
- Approve, reply, assign, archive, or continue work
- Preserve a searchable history of what happened and why

## Design Principle

AIBoard is not a traditional analytics dashboard. It is an operations console for agent collaboration.

The core object is not a chart. The core object is an actionable event.

## MVP Scope

The first version should stay intentionally small:

- Local ingestion API for agent events
- SQLite event store
- Local Markdown archive for agent output
- Web inbox for items needing human attention
- Agent stream view with collapsed summaries
- Artifact list
- Basic action states: new, triaged, in progress, done, archived

Avoid in the first version:

- Multi-user permissions
- Complex charts
- Fully custom dashboard builders
- Chat or notification-platform synchronization
- Autonomous irreversible agent decisions

## Repository Status

This repository currently contains architecture and product direction. Implementation will follow after the event model and MVP boundaries are stable.

## Planning Docs

- [Architecture](docs/ARCHITECTURE.md)
- [Project Plan](docs/PROJECT_PLAN.md)

## Local Development

```bash
npm run dev
```

Then open `http://127.0.0.1:4173`.

Useful commands:

```bash
npm run check
npm run healthcheck
npm run seed
npm run import:inbox
npm run import:vault
```

Runtime data is written to:

- `data/aiboard.sqlite`
- `agent-output/YYYY-MM-DD/{source}/*.md`

## Inbox Import

Drop `.md`, `.txt`, or `.json` files into `inbox/`. AIBoard imports them into SQLite, writes a Markdown archive copy, and moves the original file to `inbox/processed/`. Failed imports move to `inbox/failed/`.

Markdown files can include simple frontmatter:

```md
---
source: hermes
type: research_queue
priority: high
vaultPath: 研究队列.md
tags:
  - research
---

# Candidate for deep research

Raw agent output goes here.
```

JSON files should contain one event object:

```json
{
  "source": "openclaw",
  "type": "artifact",
  "title": "Deep research completed",
  "rawContent": "Original agent output"
}
```

## Vault Import

Vault import is read-only and disabled by default. Configure it in `config/aiboard.config.json`:

```json
{
  "vault": {
    "enabled": true,
    "rootPath": "/absolute/path/to/Obsidian/Vault",
    "researchQueuePath": "研究队列.md",
    "trackingPath": "持仓与跟踪.md",
    "watchFolders": ["companies", "sectors", "governor"],
    "pollMs": 15000
  }
}
```

When enabled, AIBoard watches selected Markdown files and folders, imports changed content into SQLite, writes Markdown archive copies, and records `vaultPath` on each event. It uses content hashes to avoid duplicate events when files have not changed.

For deployment health checks:

```bash
curl http://127.0.0.1:4173/api/health
curl http://127.0.0.1:4173/api/import/vault
```

`/api/health` reports the live Vault sync state. A healthy sync returns `ok: true` with `vault.status: "ok"`, the last run summary, consecutive failure count, and the next scheduled poll time. AIBoard also stores recent sync runs in SQLite, so transient failures are visible after refresh instead of disappearing into server logs.

The browser UI refreshes every 15 seconds while visible and shows the same status under `手动接入`:

- `Vault 同步健康`: latest poll completed successfully.
- `Vault 正在同步`: a poll is currently running.
- `Vault 同步有失败项`: the poll completed but one or more files failed.
- `Vault 同步过期`: no successful poll has completed within the expected window.
- `Vault 同步异常`: repeated poll failures; check `/api/health` and server logs.

## Command Drafts

Suggested actions create local draft commands. Drafts are recorded in SQLite and shown in the `Command Drafts` panel, but they do not execute OpenClaw, Hermes, or Vault writes yet.

This keeps the current loop safe:

```text
event -> suggested action -> draft command -> later adapter execution
```

Draft commands can be dispatched to a local file outbox:

```text
command-outbox/{target}/*.json
command-outbox/{target}/*.md
```

This is the first safe adapter surface. OpenClaw or Hermes can later watch their target folder and pick up commands without AIBoard directly executing external processes.

## Agent Adapters

AIBoard can also run dispatched commands through local CLI adapters:

```bash
npm run adapters:run
```

Current adapters:

- Hermes: `hermes chat -q <prompt> -Q --source aiboard`
- OpenClaw: `openclaw agent --agent main --message <prompt> --json --timeout 180`

Adapter behavior:

- Reads commands with status `dispatched`
- Marks each command `running`
- Calls the target CLI
- Marks the command `completed` or `failed`
- Creates a new AIBoard event with the CLI result
- Writes the result into `agent-output/YYYY-MM-DD/{target}/`

Smoke test status:

- Hermes adapter: passed
- OpenClaw adapter: passed

## Deployment

See [Deployment Notes](docs/DEPLOYMENT.md).

For a local always-on service:

```bash
HOST=0.0.0.0 PORT=4173 npm run start
```

The homepage now starts with a compact daily cockpit:

- 今日待处理
- 待研究候选
- OpenClaw 流转
- 已回流结果

When an OpenClaw command completes, AIBoard creates a result event, writes the Markdown archive, and marks the related candidate row as `OpenClaw 已产出`.
