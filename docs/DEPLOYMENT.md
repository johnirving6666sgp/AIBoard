# AIBoard Deployment Notes

## Launch Command

```bash
cd /Users/lobai/Documents/Codex/2026-05-20/aiboardinhk
HOST=0.0.0.0 PORT=4173 npm run start
```

Use `HOST=0.0.0.0` only when the machine is on a trusted network or behind a private tunnel.

## Health Check

```bash
npm run healthcheck
curl http://127.0.0.1:4173/api/health
```

Healthy output should report:

- `ok: true`
- `vault.status: "ok"` or `"running"`
- `vault.consecutiveFailures: 0`
- a recent `vault.lastOkAt`

## Suggested PM2 Setup

```bash
pm2 start npm --name aiboard -- run start
pm2 save
pm2 logs aiboard
pm2 restart aiboard
```

For LAN access:

```bash
HOST=0.0.0.0 PORT=4173 pm2 start npm --name aiboard -- run start
```

## Current macOS launchd Setup

This machine is deployed through the user LaunchAgent:

```text
~/Library/LaunchAgents/com.aiboard.local.plist
```

The source plist is tracked in:

```text
deploy/com.aiboard.local.plist
```

Useful commands:

```bash
launchctl print gui/501/com.aiboard.local
launchctl kickstart -k gui/501/com.aiboard.local
launchctl bootout gui/501 ~/Library/LaunchAgents/com.aiboard.local.plist
tail -f logs/aiboard.out.log
tail -f logs/aiboard.err.log
```

Current binding:

```text
HOST=0.0.0.0
PORT=4173
```

Local access:

```text
http://127.0.0.1:4173
```

LAN access on the current network:

```text
http://192.168.1.90:4173
```

## Runbook

1. Check `/api/health`.
2. If Vault is stale or degraded, click `立即同步 Vault` in the UI or run `npm run import:vault`.
3. If OpenClaw queue has pending items, click `运行队列`.
4. Confirm completed OpenClaw outputs appear in `OpenClaw 队列 / 结果`.
5. Confirm candidate rows move from `已交给 OpenClaw` to `OpenClaw 已产出` after adapter completion.
