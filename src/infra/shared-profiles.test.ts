import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockReadFileSync } = vi.hoisted(() => ({
  mockReadFileSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  readFileSync: mockReadFileSync,
}));

// ---------------------------------------------------------------------------
// Imports (AFTER mocks)
// ---------------------------------------------------------------------------

import {
  loadAgentProfiles,
  buildMentionPattern,
  resolveAgentFromAlias,
  resolveDefaultAgent,
  _resetProfilesCacheForTesting,
  type AgentProfile,
} from "./shared-profiles.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROFILES_JSON = JSON.stringify({
  agents: {
    mal: {
      label: "Mal",
      mission: "Product owner",
      mentionAliases: ["mason", "mal"],
      appAliases: ["ctclaw"],
      isDefault: true,
      avatarUrl: "https://example.com/mal.png",
    },
    kaylee: {
      label: "Kaylee",
      mission: "Builder",
      mentionAliases: ["eureka", "kaylee"],
      avatarUrl: "https://example.com/kaylee.png",
    },
    inara: {
      label: "Inara",
      mission: "Content",
      mentionAliases: ["forge", "inara"],
    },
  },
});

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  _resetProfilesCacheForTesting();
  mockReadFileSync.mockReturnValue(PROFILES_JSON);
});

afterEach(() => {
  _resetProfilesCacheForTesting();
});

// ---------------------------------------------------------------------------
// loadAgentProfiles
// ---------------------------------------------------------------------------

describe("loadAgentProfiles", () => {
  it("loads and parses profiles from JSON file", () => {
    const profiles = loadAgentProfiles();

    expect(profiles).toHaveProperty("mal");
    expect(profiles).toHaveProperty("kaylee");
    expect(profiles).toHaveProperty("inara");
    expect(profiles.mal.label).toBe("Mal");
    expect(profiles.mal.isDefault).toBe(true);
  });

  it("caches profiles for 5 seconds", () => {
    loadAgentProfiles();
    loadAgentProfiles();
    loadAgentProfiles();

    // Should only read file once (subsequent calls hit cache)
    expect(mockReadFileSync).toHaveBeenCalledTimes(1);
  });

  it("reloads after cache expires", () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);

    loadAgentProfiles();
    expect(mockReadFileSync).toHaveBeenCalledTimes(1);

    // Advance past TTL (5s)
    vi.spyOn(Date, "now").mockReturnValue(now + 6_000);

    loadAgentProfiles();
    expect(mockReadFileSync).toHaveBeenCalledTimes(2);

    vi.restoreAllMocks();
  });

  it("returns empty object when file is missing", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const profiles = loadAgentProfiles();
    expect(profiles).toEqual({});
  });

  it("returns empty object when JSON is invalid", () => {
    mockReadFileSync.mockReturnValue("not valid json{{{");

    const profiles = loadAgentProfiles();
    expect(profiles).toEqual({});
  });

  it("returns empty object when agents key is missing", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ version: 1 }));

    const profiles = loadAgentProfiles();
    expect(profiles).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// buildMentionPattern
// ---------------------------------------------------------------------------

describe("buildMentionPattern", () => {
  it("builds regex matching all mention aliases", () => {
    const profiles = loadAgentProfiles();
    const pattern = buildMentionPattern(profiles);

    expect(pattern).not.toBeNull();
    // Use .match() instead of .test() to avoid global regex lastIndex statefulness
    expect("@mason".match(pattern!)).not.toBeNull();
    expect("@mal".match(pattern!)).not.toBeNull();
    expect("@eureka".match(pattern!)).not.toBeNull();
    expect("@kaylee".match(pattern!)).not.toBeNull();
    expect("@forge".match(pattern!)).not.toBeNull();
    expect("@inara".match(pattern!)).not.toBeNull();
  });

  it("does NOT match appAliases", () => {
    const profiles = loadAgentProfiles();
    const pattern = buildMentionPattern(profiles);

    // appAliases like "ctclaw" should not be in the mention pattern
    expect("@ctclaw".match(pattern!)).toBeNull();
  });

  it("is case-insensitive", () => {
    const profiles = loadAgentProfiles();
    const pattern = buildMentionPattern(profiles);

    expect("@Mason".match(pattern!)).not.toBeNull();
    expect("@KAYLEE".match(pattern!)).not.toBeNull();
  });

  it("returns null when no profiles have aliases", () => {
    const pattern = buildMentionPattern({});
    expect(pattern).toBeNull();
  });

  it("returns null when all aliases are empty arrays", () => {
    const pattern = buildMentionPattern({
      agent1: { label: "A", mission: "test", mentionAliases: [] },
    });
    expect(pattern).toBeNull();
  });

  it("escapes regex special chars in aliases", () => {
    const profiles: Record<string, AgentProfile> = {
      test: {
        label: "Test",
        mission: "test",
        mentionAliases: ["agent.name", "agent+plus"],
      },
    };
    const pattern = buildMentionPattern(profiles);
    expect(pattern).not.toBeNull();
    // Should match literal dot, not "any char"
    expect(pattern!.test("@agent.name")).toBe(true);
    expect(pattern!.test("@agentXname")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveAgentFromAlias
// ---------------------------------------------------------------------------

describe("resolveAgentFromAlias", () => {
  it("resolves known alias to agent", () => {
    const profiles = loadAgentProfiles();
    const result = resolveAgentFromAlias("mason", profiles);

    expect(result).toEqual({ agentId: "mal", label: "Mal" });
  });

  it("resolves case-insensitively", () => {
    const profiles = loadAgentProfiles();
    const result = resolveAgentFromAlias("EUREKA", profiles);

    expect(result).toEqual({ agentId: "kaylee", label: "Kaylee" });
  });

  it("returns null for unknown alias", () => {
    const profiles = loadAgentProfiles();
    const result = resolveAgentFromAlias("wash", profiles);

    expect(result).toBeNull();
  });

  it("returns null for empty profiles", () => {
    const result = resolveAgentFromAlias("anything", {});
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveDefaultAgent
// ---------------------------------------------------------------------------

describe("resolveDefaultAgent", () => {
  it("returns defaultAgentId from pluginConfig when set", () => {
    const api = { pluginConfig: { defaultAgentId: "kaylee" } } as any;
    const result = resolveDefaultAgent(api);
    expect(result).toBe("kaylee");
  });

  it("falls back to isDefault profile when no config", () => {
    const api = { pluginConfig: {} } as any;
    const result = resolveDefaultAgent(api);
    expect(result).toBe("mal");
  });

  it("returns 'default' when no config and no profiles", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const api = { pluginConfig: {} } as any;
    const result = resolveDefaultAgent(api);
    expect(result).toBe("default");
  });

  it("ignores empty string in pluginConfig", () => {
    const api = { pluginConfig: { defaultAgentId: "" } } as any;
    const result = resolveDefaultAgent(api);
    // Should fall through to profile default
    expect(result).toBe("mal");
  });
});
