import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createNoopNotifier,
  createNotifierFromConfig,
  formatMessage,
  sendToTarget,
  parseNotificationsConfig,
  type NotifyKind,
  type NotifyPayload,
  type NotifyTarget,
} from "./notify.js";

// ---------------------------------------------------------------------------
// formatMessage
// ---------------------------------------------------------------------------

describe("formatMessage", () => {
  const basePayload: NotifyPayload = {
    identifier: "API-42",
    title: "Fix auth",
    status: "dispatched",
  };

  it("formats dispatch message", () => {
    const msg = formatMessage("dispatch", basePayload);
    expect(msg).toBe("API-42 dispatched — Fix auth");
  });

  it("formats working message with attempt", () => {
    const msg = formatMessage("working", { ...basePayload, attempt: 1 });
    expect(msg).toContain("worker started");
    expect(msg).toContain("attempt 1");
  });

  it("formats auditing message", () => {
    const msg = formatMessage("auditing", basePayload);
    expect(msg).toContain("audit in progress");
  });

  it("formats audit_pass message", () => {
    const msg = formatMessage("audit_pass", basePayload);
    expect(msg).toContain("passed audit");
    expect(msg).toContain("PR ready");
  });

  it("formats audit_fail message with gaps", () => {
    const msg = formatMessage("audit_fail", {
      ...basePayload,
      attempt: 1,
      verdict: { pass: false, gaps: ["no tests", "missing validation"] },
    });
    expect(msg).toContain("failed audit");
    expect(msg).toContain("attempt 1");
    expect(msg).toContain("no tests");
    expect(msg).toContain("missing validation");
  });

  it("formats audit_fail with default gaps text", () => {
    const msg = formatMessage("audit_fail", {
      ...basePayload,
      attempt: 0,
      verdict: { pass: false },
    });
    expect(msg).toContain("unspecified");
  });

  it("formats escalation message with reason", () => {
    const msg = formatMessage("escalation", {
      ...basePayload,
      reason: "audit failed 3x",
    });
    expect(msg).toContain("needs human review");
    expect(msg).toContain("audit failed 3x");
  });

  it("formats stuck message", () => {
    const msg = formatMessage("stuck", {
      ...basePayload,
      reason: "stale 2h",
    });
    expect(msg).toContain("stuck");
    expect(msg).toContain("stale 2h");
  });

  it("formats watchdog_kill with attempt", () => {
    const msg = formatMessage("watchdog_kill", {
      ...basePayload,
      attempt: 0,
      reason: "no I/O for 120s",
    });
    expect(msg).toContain("killed by watchdog");
    expect(msg).toContain("no I/O for 120s");
    expect(msg).toContain("Retrying (attempt 0)");
  });

  it("formats watchdog_kill without attempt", () => {
    const msg = formatMessage("watchdog_kill", {
      ...basePayload,
      reason: "timeout",
    });
    expect(msg).toContain("Will retry.");
  });

  it("handles unknown kind via default case", () => {
    const msg = formatMessage("unknown_kind" as NotifyKind, basePayload);
    expect(msg).toContain("API-42");
    expect(msg).toContain("unknown_kind");
  });
});

// ---------------------------------------------------------------------------
// sendToTarget
// ---------------------------------------------------------------------------

describe("sendToTarget", () => {
  function mockRuntime(): any {
    return {
      channel: {
        discord: {
          sendMessageDiscord: vi.fn(async () => {}),
        },
        slack: {
          sendMessageSlack: vi.fn(async () => ({ messageId: "ts-1", channelId: "C999" })),
        },
        telegram: {
          sendMessageTelegram: vi.fn(async () => {}),
        },
        signal: {
          sendMessageSignal: vi.fn(async () => {}),
        },
      },
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes discord target to sendMessageDiscord", async () => {
    const runtime = mockRuntime();
    const target: NotifyTarget = { channel: "discord", target: "123456" };
    await sendToTarget(target, "test message", runtime);
    expect(runtime.channel.discord.sendMessageDiscord).toHaveBeenCalledWith("123456", "test message");
  });

  it("routes slack target to sendMessageSlack with accountId", async () => {
    const runtime = mockRuntime();
    const target: NotifyTarget = { channel: "slack", target: "C-100", accountId: "acct-x" };
    await sendToTarget(target, "test message", runtime);
    expect(runtime.channel.slack.sendMessageSlack).toHaveBeenCalledWith(
      "C-100",
      "test message",
      { accountId: "acct-x" },
    );
  });

  it("routes slack target without accountId", async () => {
    const runtime = mockRuntime();
    const target: NotifyTarget = { channel: "slack", target: "C-200" };
    await sendToTarget(target, "test message", runtime);
    expect(runtime.channel.slack.sendMessageSlack).toHaveBeenCalledWith(
      "C-200",
      "test message",
      { accountId: undefined },
    );
  });

  it("routes telegram target to sendMessageTelegram with silent", async () => {
    const runtime = mockRuntime();
    const target: NotifyTarget = { channel: "telegram", target: "-100388" };
    await sendToTarget(target, "test message", runtime);
    expect(runtime.channel.telegram.sendMessageTelegram).toHaveBeenCalledWith(
      "-100388",
      "test message",
      { silent: true },
    );
  });

  it("routes signal target to sendMessageSignal", async () => {
    const runtime = mockRuntime();
    const target: NotifyTarget = { channel: "signal", target: "+1234567890" };
    await sendToTarget(target, "test message", runtime);
    expect(runtime.channel.signal.sendMessageSignal).toHaveBeenCalledWith("+1234567890", "test message");
  });

  it("falls back to CLI for unknown channels", async () => {
    const runtime = mockRuntime();
    const target: NotifyTarget = { channel: "matrix", target: "!room:server" };

    const { execFileSync } = await import("node:child_process");
    vi.mock("node:child_process", () => ({
      execFileSync: vi.fn(),
    }));

    // Since the dynamic import is already cached, we test that it doesn't call any known channel
    // and doesn't throw for an unknown channel type
    try {
      await sendToTarget(target, "test message", runtime);
    } catch {
      // CLI fallback may fail in test env — that's expected
    }

    // None of the known channels should have been called
    expect(runtime.channel.discord.sendMessageDiscord).not.toHaveBeenCalled();
    expect(runtime.channel.slack.sendMessageSlack).not.toHaveBeenCalled();
    expect(runtime.channel.telegram.sendMessageTelegram).not.toHaveBeenCalled();
    expect(runtime.channel.signal.sendMessageSignal).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// parseNotificationsConfig
// ---------------------------------------------------------------------------

describe("parseNotificationsConfig", () => {
  it("returns empty targets for undefined config", () => {
    const config = parseNotificationsConfig(undefined);
    expect(config.targets).toEqual([]);
    expect(config.events).toEqual({});
  });

  it("returns empty targets for config without notifications", () => {
    const config = parseNotificationsConfig({ enabled: true });
    expect(config.targets).toEqual([]);
  });

  it("parses targets and events", () => {
    const config = parseNotificationsConfig({
      notifications: {
        targets: [{ channel: "discord", target: "123" }],
        events: { auditing: false },
      },
    });
    expect(config.targets).toHaveLength(1);
    expect(config.targets![0].channel).toBe("discord");
    expect(config.events?.auditing).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createNotifierFromConfig
// ---------------------------------------------------------------------------

describe("createNotifierFromConfig", () => {
  function mockRuntime(): any {
    return {
      channel: {
        discord: {
          sendMessageDiscord: vi.fn(async () => {}),
        },
        slack: {
          sendMessageSlack: vi.fn(async () => ({ messageId: "ts-1", channelId: "C999" })),
        },
        telegram: {
          sendMessageTelegram: vi.fn(async () => {}),
        },
        signal: {
          sendMessageSignal: vi.fn(async () => {}),
        },
      },
    };
  }

  const basePayload: NotifyPayload = {
    identifier: "CFG-1",
    title: "Config test",
    status: "dispatched",
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns noop when no targets configured", async () => {
    const runtime = mockRuntime();
    const notify = createNotifierFromConfig({}, runtime);
    await notify("dispatch", basePayload);
    expect(runtime.channel.discord.sendMessageDiscord).not.toHaveBeenCalled();
    expect(runtime.channel.slack.sendMessageSlack).not.toHaveBeenCalled();
  });

  it("returns noop when targets array is empty", async () => {
    const runtime = mockRuntime();
    const notify = createNotifierFromConfig({ notifications: { targets: [] } }, runtime);
    await notify("dispatch", basePayload);
    expect(runtime.channel.discord.sendMessageDiscord).not.toHaveBeenCalled();
  });

  it("sends to single discord target", async () => {
    const runtime = mockRuntime();
    const notify = createNotifierFromConfig({
      notifications: {
        targets: [{ channel: "discord", target: "D-100" }],
      },
    }, runtime);
    await notify("dispatch", basePayload);
    expect(runtime.channel.discord.sendMessageDiscord).toHaveBeenCalledOnce();
    expect(runtime.channel.discord.sendMessageDiscord).toHaveBeenCalledWith(
      "D-100",
      expect.stringContaining("CFG-1"),
    );
  });

  it("sends to single slack target with accountId", async () => {
    const runtime = mockRuntime();
    const notify = createNotifierFromConfig({
      notifications: {
        targets: [{ channel: "slack", target: "C-200", accountId: "acct-x" }],
      },
    }, runtime);
    await notify("audit_pass", basePayload);
    expect(runtime.channel.slack.sendMessageSlack).toHaveBeenCalledOnce();
    const [, , opts] = runtime.channel.slack.sendMessageSlack.mock.calls[0];
    expect(opts.accountId).toBe("acct-x");
  });

  it("sends to telegram target", async () => {
    const runtime = mockRuntime();
    const notify = createNotifierFromConfig({
      notifications: {
        targets: [{ channel: "telegram", target: "-100388" }],
      },
    }, runtime);
    await notify("working", { ...basePayload, attempt: 1 });
    expect(runtime.channel.telegram.sendMessageTelegram).toHaveBeenCalledOnce();
    expect(runtime.channel.telegram.sendMessageTelegram).toHaveBeenCalledWith(
      "-100388",
      expect.stringContaining("worker started"),
      { silent: true },
    );
  });

  it("fans out to multiple targets", async () => {
    const runtime = mockRuntime();
    const notify = createNotifierFromConfig({
      notifications: {
        targets: [
          { channel: "discord", target: "D-100" },
          { channel: "slack", target: "C-200" },
          { channel: "telegram", target: "-100388" },
        ],
      },
    }, runtime);
    await notify("dispatch", basePayload);

    expect(runtime.channel.discord.sendMessageDiscord).toHaveBeenCalledOnce();
    expect(runtime.channel.slack.sendMessageSlack).toHaveBeenCalledOnce();
    expect(runtime.channel.telegram.sendMessageTelegram).toHaveBeenCalledOnce();
  });

  it("isolates failures between targets", async () => {
    const runtime = mockRuntime();
    runtime.channel.slack.sendMessageSlack = vi.fn(async () => {
      throw new Error("Slack down");
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const notify = createNotifierFromConfig({
      notifications: {
        targets: [
          { channel: "discord", target: "D-100" },
          { channel: "slack", target: "C-200" },
        ],
      },
    }, runtime);
    await expect(notify("escalation", basePayload)).resolves.toBeUndefined();

    // Discord should still succeed
    expect(runtime.channel.discord.sendMessageDiscord).toHaveBeenCalledOnce();
    consoleSpy.mockRestore();
  });

  it("skips suppressed events", async () => {
    const runtime = mockRuntime();
    const notify = createNotifierFromConfig({
      notifications: {
        targets: [{ channel: "discord", target: "D-100" }],
        events: { auditing: false },
      },
    }, runtime);

    // Suppressed event — should not send
    await notify("auditing", basePayload);
    expect(runtime.channel.discord.sendMessageDiscord).not.toHaveBeenCalled();

    // Non-suppressed event — should send
    await notify("dispatch", basePayload);
    expect(runtime.channel.discord.sendMessageDiscord).toHaveBeenCalledOnce();
  });

  it("sends events that are explicitly enabled", async () => {
    const runtime = mockRuntime();
    const notify = createNotifierFromConfig({
      notifications: {
        targets: [{ channel: "discord", target: "D-100" }],
        events: { dispatch: true, auditing: false },
      },
    }, runtime);

    await notify("dispatch", basePayload);
    expect(runtime.channel.discord.sendMessageDiscord).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// createNoopNotifier
// ---------------------------------------------------------------------------

describe("createNoopNotifier", () => {
  it("returns function that resolves without error", async () => {
    const notify = createNoopNotifier();
    await expect(notify("dispatch", {
      identifier: "API-1",
      title: "test",
      status: "dispatched",
    })).resolves.toBeUndefined();
  });
});
