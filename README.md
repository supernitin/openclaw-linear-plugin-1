# @calltelemetry/openclaw-linear

An OpenClaw plugin that connects your Linear workspace to AI agents. Issues get triaged automatically, agents respond to @mentions, and a full plan-implement-audit pipeline runs when you assign work to the agent.

## Features

- **Auto-triage** — New issues get story point estimates, labels, and priority automatically
- **@mention routing** — `@qa`, `@infra`, `@docs` in comments route to specialized agents
- **Agent pipeline** — Assign an issue to the agent and it plans, implements, and audits the work
- **Branded replies** — Each agent posts with its own name and avatar in Linear
- **Real-time progress** — Agent activity (thinking, acting, responding) shows in Linear's UI
- **Unified `code_run` tool** — One tool, three coding CLI backends (Codex, Claude Code, Gemini CLI), configurable per agent
- **Issue management via `linearis`** — Agents use the `linearis` CLI to update status, close issues, add comments, and more

## Architecture

### Webhook Flow

```
  Linear                  OpenClaw Gateway              AI Agents
    |                           |                          |
    |  Webhook (issue created)  |                          |
    |  ────────────────────────>|                          |
    |                           |  Dispatch triage agent   |
    |                           |  ───────────────────────>|
    |                           |                          |
    |                           |  Estimate + labels       |
    |                           |  <───────────────────────|
    |  Update issue             |                          |
    |  <────────────────────────|                          |
    |  Post assessment comment  |                          |
    |  <────────────────────────|                          |
```

```
  Linear                  OpenClaw Gateway              AI Agents
    |                           |                          |
    |  "@qa check this"         |                          |
    |  ────────────────────────>|                          |
    |                           |  Route to QA agent       |
    |                           |  ───────────────────────>|
    |                           |                          |
    |                           |  Response                |
    |                           |  <───────────────────────|
    |  Comment from "QA"        |                          |
    |  <────────────────────────|                          |
```

### Two Webhook Systems

Linear delivers events through two separate webhook paths:

1. **Workspace webhook** (Settings > API > Webhooks) — handles Comment, Issue, and User events
2. **OAuth app webhook** (Settings > API > Applications > your app) — handles `AgentSessionEvent` (created/prompted)

Both must point to the same URL: `https://<your-domain>/linear/webhook`

### Source Layout

```
index.ts                  Plugin entry point, CLI checks, tool/webhook registration
src/
  webhook.ts              Webhook handler — routes events to agents, builds prompts
  pipeline.ts             3-stage pipeline: plan → implement → audit
  agent.ts                Agent execution wrapper
  active-session.ts       In-process session registry (issueId → session)

  code-tool.ts            Unified code_run tool — dispatches to configured backend
  cli-shared.ts           Shared helpers for CLI tools (buildLinearApi, resolveSession)
  codex-tool.ts           Codex CLI runner (JSONL stream → Linear activities)
  claude-tool.ts          Claude Code CLI runner (JSONL stream → Linear activities)
  gemini-tool.ts          Gemini CLI runner (JSONL stream → Linear activities)
  coding-tools.json       Backend config (default tool, per-agent overrides, aliases)

  tools.ts                Tool registration (code_run + orchestration)
  orchestration-tools.ts  spawn_agent / ask_agent for multi-agent delegation
  linear-api.ts           Linear GraphQL API client, token resolution, activity streaming
  client.ts               Lightweight Linear GraphQL client (legacy, unused by tools)
  auth.ts                 OAuth token management and profile storage
  oauth-callback.ts       OAuth callback handler
  cli.ts                  CLI subcommands (auth, status)
  codex-worktree.ts       Git worktree management for isolated Codex runs
```

## Coding Tool (`code_run`)

The plugin provides a single `code_run` tool that dispatches to one of three coding CLI backends. Agents call `code_run` without needing to know which backend is active — the dispatcher handles routing.

### Supported Backends

| Backend | CLI | Stream Format | Key Flags |
|---|---|---|---|
| **Codex** (OpenAI) | `codex` | JSONL | `--full-auto`, `-q` |
| **Claude Code** (Anthropic) | `claude` | JSONL (`stream-json`) | `--print`, `--dangerously-skip-permissions`, `--verbose` |
| **Gemini CLI** (Google) | `gemini` | JSONL (`stream-json`) | `--yolo`, `-o stream-json` |

All three stream JSONL events that get mapped to Linear agent activities in real-time (thoughts, actions, tool results).

### Backend Resolution Priority

When `code_run` is called:

1. **Explicit `backend` parameter** — Agent passes `backend: "gemini"` (or any alias)
2. **Per-agent override** — `agentCodingTools` in `coding-tools.json`
3. **Global default** — `codingTool` in `coding-tools.json`
4. **Hardcoded fallback** — `"claude"`

### Configuration (`coding-tools.json`)

```json
{
  "codingTool": "codex",
  "agentCodingTools": {
    "kaylee": "claude",
    "inara": "gemini"
  },
  "backends": {
    "claude": {
      "aliases": ["claude", "claude code", "anthropic"]
    },
    "codex": {
      "aliases": ["codex", "openai"]
    },
    "gemini": {
      "aliases": ["gemini", "google"]
    }
  }
}
```

- **`codingTool`** — Default backend for all agents
- **`agentCodingTools`** — Per-agent overrides (keyed by agent ID)
- **`backends.*.aliases`** — Alias strings so the agent (or user) can say "use google" and it resolves to `gemini`

### Backend-Specific Notes

**Claude Code:**
- Must unset `CLAUDECODE` env var to avoid "nested session" error
- Requires `--verbose` alongside `stream-json` for full event output
- Content blocks are arrays: `message.content[].type` can be `text` or `tool_use`

**Gemini CLI:**
- Working directory set via `spawn()` `cwd` option (no `-C` flag)
- Model override via `-m <model>` flag
- Stderr may include "YOLO mode" warnings — filtered from output

**Codex:**
- Uses git worktrees for isolated runs (see `codex-worktree.ts`)
- Model/timeout configurable via plugin config (`codexModel`, `codexTimeoutMs`)

## Linear Issue Management (`linearis` Skill)

Issue management (update status, close, assign, comment, labels, etc.) is handled by the **`linearis`** CLI, installed as an OpenClaw skill. This replaces custom GraphQL tools — agents use `linearis` via exec.

### Install

```bash
npx clawhub install linearis
npm install -g linearis
```

### Auth

```bash
echo "lin_api_..." > ~/.linear_api_token
```

Or set `LINEAR_API_TOKEN` env var.

### Key Commands

```bash
linearis issues list -l 20               # List recent issues
linearis issues list --team UAT           # Filter by team
linearis issues search "auth bug"         # Full-text search
linearis issues read API-123              # Get issue details
linearis issues update API-123 --status "Done"     # Close issue
linearis issues update API-123 --status "In Progress"
linearis issues update API-123 --assignee user123
linearis issues update API-123 --labels "Bug" --label-by adding
linearis issues create --title "Fix it" --team UAT --priority 2
linearis comments create API-123 --body "Fixed in PR #456"
linearis teams list
linearis users list --active
linearis projects list
linearis documents list
linearis usage                            # Full command reference
```

All output is JSON, suitable for piping to `jq`.

## Prerequisites

- **OpenClaw** gateway running (v2026.2+)
- **Linear** workspace with API access
- **Public URL** for webhook delivery (Cloudflare Tunnel recommended)
- **Coding CLIs** (at least one): `codex`, `claude`, `gemini` — installed in PATH
- **linearis** CLI — for issue management

## Install

```bash
openclaw plugins install @calltelemetry/openclaw-linear
```

## Setup

### 1. Create a Linear OAuth App

Go to **Linear Settings > API > Applications** and create a new application:

- **Webhook URL:** `https://<your-domain>/linear/webhook`
- **Redirect URI:** `https://<your-domain>/linear/oauth/callback`
- Enable webhook events: **Agent Sessions**, **Comments**, **Issues**

Save the **Client ID** and **Client Secret**.

### 2. Set Credentials

Add to your gateway's environment (systemd service or shell):

```bash
export LINEAR_CLIENT_ID="your_client_id"
export LINEAR_CLIENT_SECRET="your_client_secret"
```

For systemd:

```ini
[Service]
Environment=LINEAR_CLIENT_ID=your_client_id
Environment=LINEAR_CLIENT_SECRET=your_client_secret
```

Then reload: `systemctl --user daemon-reload && systemctl --user restart openclaw-gateway`

### 3. Expose the Gateway

Linear needs to reach your gateway over HTTPS to deliver webhooks. A [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) is the recommended approach — no open ports, no TLS certificates to manage.

#### a. Install `cloudflared`

```bash
# RHEL / Rocky / Alma
sudo dnf install -y cloudflared

# Debian / Ubuntu
sudo apt install -y cloudflared

# macOS
brew install cloudflare/cloudflare/cloudflared
```

#### b. Authenticate with Cloudflare

```bash
cloudflared tunnel login
```

This opens your browser. Log in, select the domain you want to use, and click **Authorize**.

#### c. Create a tunnel

```bash
cloudflared tunnel create openclaw
```

Note the **Tunnel ID** (a UUID) from the output.

#### d. Point a subdomain at the tunnel

```bash
cloudflared tunnel route dns openclaw linear.yourdomain.com
```

This creates a DNS record so `linear.yourdomain.com` routes through the tunnel.

#### e. Configure the tunnel

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: <TUNNEL_ID>
credentials-file: ~/.cloudflared/<TUNNEL_ID>.json

ingress:
  - hostname: linear.yourdomain.com
    service: http://localhost:18789
  - service: http_status:404
```

#### f. Start the tunnel

```bash
# Install as a system service (starts on boot)
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

To test without installing as a service:

```bash
cloudflared tunnel run openclaw
```

#### g. Verify the tunnel

```bash
curl -s https://linear.yourdomain.com/linear/webhook \
  -X POST -H "Content-Type: application/json" \
  -d '{"type":"test","action":"ping"}'
# Should return: "ok"
```

### 4. Authorize with Linear

```bash
openclaw openclaw-linear auth
```

This opens your browser to authorize the agent. The plugin needs these OAuth scopes:

| Scope | What it enables |
|---|---|
| `read` / `write` | Read and update issues, post comments |
| `app:assignable` | Agent appears in Linear's assignment menus |
| `app:mentionable` | Users can @mention the agent in comments |

After authorization, restart the gateway:

```bash
systemctl --user restart openclaw-gateway
```

Verify it's working:

```bash
openclaw openclaw-linear status
```

You should see `token: profile` in the gateway logs.

### 5. Configure Agents

Create `~/.openclaw/agent-profiles.json` to define your agent team:

```json
{
  "agents": {
    "lead": {
      "label": "Lead",
      "mission": "Product owner. Sets direction, prioritizes backlog.",
      "isDefault": true,
      "mentionAliases": ["lead"],
      "avatarUrl": "https://example.com/lead.png"
    },
    "qa": {
      "label": "QA",
      "mission": "Test engineer. Quality guardian, test strategy.",
      "mentionAliases": ["qa", "tester"]
    },
    "infra": {
      "label": "Infra",
      "mission": "Backend engineer. Performance, reliability, observability.",
      "mentionAliases": ["infra", "backend"]
    }
  }
}
```

Each agent name must match an agent definition in your `~/.openclaw/openclaw.json`.

One agent must be marked `isDefault: true` — this is the agent that handles issue assignments and the pipeline.

### 6. Configure Coding Tools

Create `coding-tools.json` in the plugin root:

```json
{
  "codingTool": "codex",
  "agentCodingTools": {},
  "backends": {
    "claude": { "aliases": ["claude", "claude code", "anthropic"] },
    "codex": { "aliases": ["codex", "openai"] },
    "gemini": { "aliases": ["gemini", "google"] }
  }
}
```

### 7. Install linearis

```bash
npm install -g linearis
npx clawhub install linearis
echo "lin_api_YOUR_KEY" > ~/.linear_api_token
```

### 8. Verify

```bash
systemctl --user restart openclaw-gateway
```

Check the logs for a clean startup:

```
[plugins] Linear agent extension registered (agent: default, token: profile,
  codex: codex-cli 0.101.0, claude: 2.1.45, gemini: 0.28.2, orchestration: enabled)
```

Test the webhook:

```bash
curl -s -X POST https://your-domain.com/linear/webhook \
  -H "Content-Type: application/json" \
  -d '{"type":"test","action":"ping"}'
# Should return: "ok"
```

## Usage

Once set up, the plugin responds to Linear events automatically:

| What you do in Linear | What happens |
|---|---|
| Create a new issue | Agent triages it (estimate, labels, priority) and posts an assessment |
| Assign an issue to the agent | Agent triages and posts assessment |
| Trigger an agent session | 3-stage pipeline: plan, implement, audit |
| Comment `@qa check the tests` | QA agent responds with its expertise |
| Comment `@infra why is this slow` | Infra agent investigates and replies |
| Ask "close this issue" | Agent runs `linearis issues update API-123 --status Done` |
| Ask "use gemini to review" | Agent calls `code_run` with `backend: "gemini"` |

## Configuration Reference

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `LINEAR_CLIENT_ID` | Yes | OAuth app client ID |
| `LINEAR_CLIENT_SECRET` | Yes | OAuth app client secret |
| `LINEAR_API_KEY` | No | Personal API key (fallback if no OAuth) |
| `LINEAR_REDIRECT_URI` | No | Override the OAuth callback URL |
| `OPENCLAW_GATEWAY_PORT` | No | Gateway port (default: 18789) |

### Plugin Config

Optional overrides in `openclaw.json` under the plugin entry:

| Key | Type | Default | Description |
|---|---|---|---|
| `defaultAgentId` | string | — | Override which agent handles pipeline/triage |
| `enableAudit` | boolean | `true` | Run the auditor stage after implementation |
| `enableOrchestration` | boolean | `true` | Allow agents to use `spawn_agent`/`ask_agent` |
| `codexBaseRepo` | string | `/home/claw/ai-workspace` | Git repo path for Codex worktrees |
| `codexModel` | string | — | Default Codex model |
| `codexTimeoutMs` | number | `600000` | Default timeout for coding CLIs |

### Coding Tools Config (`coding-tools.json`)

| Key | Type | Default | Description |
|---|---|---|---|
| `codingTool` | string | `"claude"` | Default coding backend |
| `agentCodingTools` | object | `{}` | Per-agent backend overrides (`agentId → backendId`) |
| `backends` | object | `{}` | Per-backend config (aliases, etc.) |
| `backends.*.aliases` | string[] | `[backendId]` | Alias names that resolve to this backend |

### Agent Profile Fields

| Field | Required | Description |
|---|---|---|
| `label` | Yes | Display name shown on comments in Linear |
| `mission` | Yes | Role description (injected as context when the agent runs) |
| `isDefault` | One agent | Handles issue triage and the pipeline |
| `mentionAliases` | Yes | `@mention` triggers (e.g., `["qa", "tester"]`) |
| `avatarUrl` | No | Avatar for branded comments |

### CLI

```bash
openclaw openclaw-linear auth      # Run OAuth authorization
openclaw openclaw-linear status    # Check connection and token status
```

## Troubleshooting

Quick checks:

```bash
systemctl --user status openclaw-gateway        # Is the gateway running?
openclaw openclaw-linear status                  # Is the token valid?
journalctl --user -u openclaw-gateway -f         # Watch live logs
linearis issues list -l 1                        # Is linearis authenticated?
```

### Common Issues

| Problem | Cause | Fix |
|---|---|---|
| Agent says "closing" but doesn't | No issue management tool available | Install `linearis` skill: `npx clawhub install linearis` |
| `code_run` uses wrong backend | Default/per-agent config mismatch | Check `coding-tools.json` |
| Claude Code "nested session" error | `CLAUDECODE` env var set | Plugin handles this automatically (unsets the var) |
| Gateway rejects plugin config keys | Strict validator in `openclaw.json` | Custom config goes in `coding-tools.json`, not `openclaw.json` |
| Webhook events not arriving | Wrong webhook URL | Both workspace and OAuth app webhooks must point to `/linear/webhook` |
| OAuth token expired | Tokens expire ~24h | Auto-refreshes via refresh token; restart gateway if stuck |

## License

MIT
