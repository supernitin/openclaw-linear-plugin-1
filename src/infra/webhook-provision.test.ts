/**
 * webhook-provision.test.ts — Unit tests for webhook auto-provisioning.
 *
 * Tests getWebhookStatus() and provisionWebhook() with inline mock objects.
 * No vi.mock needed — both functions accept linearApi as a parameter.
 */
import { describe, expect, it, vi } from "vitest";
import {
  getWebhookStatus,
  provisionWebhook,
  REQUIRED_RESOURCE_TYPES,
  WEBHOOK_LABEL,
} from "./webhook-provision.js";

// ── Helpers ────────────────────────────────────────────────────────

const TEST_URL = "https://example.com/linear/webhook";

function makeWebhook(overrides?: Record<string, unknown>) {
  return {
    id: "wh-1",
    label: WEBHOOK_LABEL,
    url: TEST_URL,
    enabled: true,
    resourceTypes: ["Comment", "Issue"],
    allPublicTeams: true,
    team: null,
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeMockApi(overrides?: Record<string, unknown>) {
  return {
    listWebhooks: vi.fn().mockResolvedValue([]),
    createWebhook: vi.fn().mockResolvedValue({ id: "new-wh", enabled: true }),
    updateWebhook: vi.fn().mockResolvedValue(true),
    deleteWebhook: vi.fn().mockResolvedValue(true),
    ...overrides,
  } as any;
}

// ── Tests ──────────────────────────────────────────────────────────

describe("REQUIRED_RESOURCE_TYPES", () => {
  it("contains exactly Comment and Issue", () => {
    expect([...REQUIRED_RESOURCE_TYPES]).toEqual(["Comment", "Issue"]);
  });
});

describe("getWebhookStatus", () => {
  it("returns null when no webhook matches URL", async () => {
    const api = makeMockApi({
      listWebhooks: vi.fn().mockResolvedValue([
        makeWebhook({ url: "https://other.com/webhook" }),
      ]),
    });
    const status = await getWebhookStatus(api, TEST_URL);
    expect(status).toBeNull();
  });

  it("returns status with no issues when webhook is correctly configured", async () => {
    const api = makeMockApi({
      listWebhooks: vi.fn().mockResolvedValue([makeWebhook()]),
    });
    const status = await getWebhookStatus(api, TEST_URL);
    expect(status).not.toBeNull();
    expect(status!.id).toBe("wh-1");
    expect(status!.issues).toEqual([]);
  });

  it("reports disabled webhook", async () => {
    const api = makeMockApi({
      listWebhooks: vi.fn().mockResolvedValue([
        makeWebhook({ enabled: false }),
      ]),
    });
    const status = await getWebhookStatus(api, TEST_URL);
    expect(status!.issues).toContain("disabled");
  });

  it("reports missing event types", async () => {
    const api = makeMockApi({
      listWebhooks: vi.fn().mockResolvedValue([
        makeWebhook({ resourceTypes: ["Comment"] }),
      ]),
    });
    const status = await getWebhookStatus(api, TEST_URL);
    expect(status!.issues.some((i) => i.includes("missing event type: Issue"))).toBe(true);
  });

  it("reports unnecessary event types", async () => {
    const api = makeMockApi({
      listWebhooks: vi.fn().mockResolvedValue([
        makeWebhook({ resourceTypes: ["Comment", "Issue", "User"] }),
      ]),
    });
    const status = await getWebhookStatus(api, TEST_URL);
    expect(status!.issues.some((i) => i.includes("unnecessary event types: User"))).toBe(true);
  });
});

describe("provisionWebhook", () => {
  it("creates new webhook when none exists", async () => {
    const api = makeMockApi();
    const result = await provisionWebhook(api, TEST_URL);

    expect(result.action).toBe("created");
    expect(result.webhookId).toBe("new-wh");
    expect(result.changes).toContain("created new webhook");
    expect(api.createWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        url: TEST_URL,
        resourceTypes: [...REQUIRED_RESOURCE_TYPES],
        enabled: true,
      }),
    );
  });

  it("returns already_ok when webhook is correct", async () => {
    const api = makeMockApi({
      listWebhooks: vi.fn().mockResolvedValue([makeWebhook()]),
    });
    const result = await provisionWebhook(api, TEST_URL);

    expect(result.action).toBe("already_ok");
    expect(result.webhookId).toBe("wh-1");
    expect(api.createWebhook).not.toHaveBeenCalled();
    expect(api.updateWebhook).not.toHaveBeenCalled();
  });

  it("updates webhook to fix issues", async () => {
    const api = makeMockApi({
      listWebhooks: vi.fn().mockResolvedValue([
        makeWebhook({
          enabled: false,
          resourceTypes: ["Comment", "Issue", "User", "Customer"],
        }),
      ]),
    });
    const result = await provisionWebhook(api, TEST_URL);

    expect(result.action).toBe("updated");
    expect(result.webhookId).toBe("wh-1");
    expect(result.changes).toBeDefined();
    expect(result.changes!.some((c) => c.includes("enabled"))).toBe(true);
    expect(result.changes!.some((c) => c.includes("removed event types"))).toBe(true);
    expect(api.updateWebhook).toHaveBeenCalledWith("wh-1", expect.objectContaining({
      enabled: true,
      resourceTypes: [...REQUIRED_RESOURCE_TYPES],
    }));
  });

  it("passes teamId option to createWebhook", async () => {
    const api = makeMockApi();
    await provisionWebhook(api, TEST_URL, { teamId: "team-1" });

    expect(api.createWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: "team-1" }),
    );
  });
});
