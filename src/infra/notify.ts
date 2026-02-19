/**
 * notify.ts — Unified notification provider for dispatch lifecycle events.
 *
 * Uses OpenClaw's native runtime channel API for all providers (Discord, Slack,
 * Telegram, Signal, etc). One formatter, one send function, config-driven
 * fan-out with per-event-type toggles.
 *
 * Modeled on DevClaw's notify.ts pattern — the runtime handles token resolution,
 * formatting differences (markdown vs mrkdwn), and delivery per channel.
 */
import type { PluginRuntime } from "openclaw/plugin-sdk";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NotifyKind =
  | "dispatch"       // issue dispatched to worker
  | "working"        // worker started
  | "auditing"       // audit triggered
  | "audit_pass"     // audit passed → done
  | "audit_fail"     // audit failed → rework
  | "escalation"     // 2x fail or stale → stuck
  | "stuck"          // stale detection
  | "watchdog_kill"; // agent killed by inactivity watchdog

export interface NotifyPayload {
  identifier: string;
  title: string;
  status: string;
  attempt?: number;
  reason?: string;
  verdict?: { pass: boolean; gaps?: string[] };
}

export type NotifyFn = (kind: NotifyKind, payload: NotifyPayload) => Promise<void>;

// ---------------------------------------------------------------------------
// Provider config
// ---------------------------------------------------------------------------

export interface NotifyTarget {
  /** OpenClaw channel name: "discord", "slack", "telegram", "signal", etc. */
  channel: string;
  /** Channel/group/user ID to send to */
  target: string;
  /** Optional account ID for multi-account channel setups */
  accountId?: string;
}

export interface NotificationsConfig {
  targets?: NotifyTarget[];
  events?: Partial<Record<NotifyKind, boolean>>;
}

// ---------------------------------------------------------------------------
// Unified message formatter
// ---------------------------------------------------------------------------

export function formatMessage(kind: NotifyKind, payload: NotifyPayload): string {
  const id = payload.identifier;
  switch (kind) {
    case "dispatch":
      return `${id} dispatched — ${payload.title}`;
    case "working":
      return `${id} worker started (attempt ${payload.attempt ?? 0})`;
    case "auditing":
      return `${id} audit in progress`;
    case "audit_pass":
      return `${id} passed audit. PR ready.`;
    case "audit_fail": {
      const gaps = payload.verdict?.gaps?.join(", ") ?? "unspecified";
      return `${id} failed audit (attempt ${payload.attempt ?? 0}). Gaps: ${gaps}`;
    }
    case "escalation":
      return `🚨 ${id} needs human review — ${payload.reason ?? "audit failed 2x"}`;
    case "stuck":
      return `⏰ ${id} stuck — ${payload.reason ?? "stale 2h"}`;
    case "watchdog_kill":
      return `⚡ ${id} killed by watchdog (${payload.reason ?? "no I/O for 120s"}). ${
        payload.attempt != null ? `Retrying (attempt ${payload.attempt}).` : "Will retry."
      }`;
    default:
      return `${id} — ${kind}: ${payload.status}`;
  }
}

// ---------------------------------------------------------------------------
// Unified send — routes to OpenClaw runtime channel API
// ---------------------------------------------------------------------------

export async function sendToTarget(
  target: NotifyTarget,
  message: string,
  runtime: PluginRuntime,
): Promise<void> {
  const ch = target.channel;
  const to = target.target;

  if (ch === "discord") {
    await runtime.channel.discord.sendMessageDiscord(to, message);
  } else if (ch === "slack") {
    await runtime.channel.slack.sendMessageSlack(to, message, {
      accountId: target.accountId,
    });
  } else if (ch === "telegram") {
    await runtime.channel.telegram.sendMessageTelegram(to, message, { silent: true });
  } else if (ch === "signal") {
    await runtime.channel.signal.sendMessageSignal(to, message);
  } else {
    // Fallback: use CLI for any channel the runtime doesn't expose directly
    const { execFileSync } = await import("node:child_process");
    execFileSync("openclaw", ["message", "send", "--channel", ch, "--target", to, "--message", message, "--json"], {
      timeout: 30_000,
      stdio: "ignore",
    });
  }
}

// ---------------------------------------------------------------------------
// Config-driven factory
// ---------------------------------------------------------------------------

/**
 * Parse notification config from plugin config.
 */
export function parseNotificationsConfig(
  pluginConfig: Record<string, unknown> | undefined,
): NotificationsConfig {
  const raw = pluginConfig?.notifications as NotificationsConfig | undefined;
  return {
    targets: raw?.targets ?? [],
    events: raw?.events ?? {},
  };
}

/**
 * Create a notifier from plugin config. Returns a NotifyFn that:
 * 1. Checks event toggles (skip suppressed events)
 * 2. Formats the message
 * 3. Fans out to all configured targets (failures isolated via Promise.allSettled)
 */
export function createNotifierFromConfig(
  pluginConfig: Record<string, unknown> | undefined,
  runtime: PluginRuntime,
): NotifyFn {
  const config = parseNotificationsConfig(pluginConfig);

  if (!config.targets?.length) return createNoopNotifier();

  return async (kind, payload) => {
    // Check event toggle — default is enabled (true)
    if (config.events?.[kind] === false) return;

    const message = formatMessage(kind, payload);

    await Promise.allSettled(
      config.targets!.map(async (target) => {
        try {
          await sendToTarget(target, message, runtime);
        } catch (err) {
          console.error(`Notify error (${target.channel}:${target.target}):`, err);
        }
      }),
    );
  };
}

// ---------------------------------------------------------------------------
// Noop fallback
// ---------------------------------------------------------------------------

export function createNoopNotifier(): NotifyFn {
  return async () => {};
}
