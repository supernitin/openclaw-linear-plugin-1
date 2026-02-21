import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import {
  readPlanningState,
  writePlanningState,
  registerPlanningSession,
  updatePlanningSession,
  getPlanningSession,
  endPlanningSession,
  isInPlanningMode,
  setPlanningCache,
  clearPlanningCache,
  getActivePlanningByProjectId,
  type PlanningSession,
  type PlanningState,
} from "./planning-state.js";

function tmpStatePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "claw-ps-"));
  return join(dir, "state.json");
}

function makePlanningSession(overrides?: Partial<PlanningSession>): PlanningSession {
  return {
    projectId: "proj-1",
    projectName: "Test Project",
    rootIssueId: "issue-uuid-1",
    rootIdentifier: "PLAN-100",
    teamId: "team-uuid-1",
    status: "interviewing",
    startedAt: new Date().toISOString(),
    turnCount: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Read / Write
// ---------------------------------------------------------------------------

describe("readPlanningState", () => {
  it("returns empty state when file missing", async () => {
    const p = tmpStatePath();
    const state = await readPlanningState(p);
    expect(state.sessions).toEqual({});
    expect(state.processedEvents).toEqual([]);
  });

  it("reads back written state", async () => {
    const p = tmpStatePath();
    const session = makePlanningSession();
    const data: PlanningState = {
      sessions: { "proj-1": session },
      processedEvents: ["evt-1"],
    };
    await writePlanningState(data, p);
    const state = await readPlanningState(p);
    expect(state.sessions["proj-1"]).toBeDefined();
    expect(state.sessions["proj-1"].projectId).toBe("proj-1");
    expect(state.processedEvents).toEqual(["evt-1"]);
  });
});

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

describe("registerPlanningSession", () => {
  it("registers and reads back", async () => {
    const p = tmpStatePath();
    const session = makePlanningSession();
    await registerPlanningSession("proj-1", session, p);
    const state = await readPlanningState(p);
    const found = getPlanningSession(state, "proj-1");
    expect(found).not.toBeNull();
    expect(found!.projectId).toBe("proj-1");
    expect(found!.projectName).toBe("Test Project");
    expect(found!.status).toBe("interviewing");
  });

  it("overwrites existing session for same projectId", async () => {
    const p = tmpStatePath();
    const session1 = makePlanningSession({ projectName: "First" });
    const session2 = makePlanningSession({ projectName: "Second" });
    await registerPlanningSession("proj-1", session1, p);
    await registerPlanningSession("proj-1", session2, p);
    const state = await readPlanningState(p);
    const found = getPlanningSession(state, "proj-1");
    expect(found).not.toBeNull();
    expect(found!.projectName).toBe("Second");
  });
});

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

describe("updatePlanningSession", () => {
  it("increments turnCount", async () => {
    const p = tmpStatePath();
    await registerPlanningSession("proj-1", makePlanningSession({ turnCount: 2 }), p);
    const updated = await updatePlanningSession("proj-1", { turnCount: 3 }, p);
    expect(updated.turnCount).toBe(3);
    const state = await readPlanningState(p);
    expect(getPlanningSession(state, "proj-1")!.turnCount).toBe(3);
  });

  it("updates status", async () => {
    const p = tmpStatePath();
    await registerPlanningSession("proj-1", makePlanningSession(), p);
    const updated = await updatePlanningSession("proj-1", { status: "plan_review" }, p);
    expect(updated.status).toBe("plan_review");
    const state = await readPlanningState(p);
    expect(getPlanningSession(state, "proj-1")!.status).toBe("plan_review");
  });

  it("throws on missing session", async () => {
    const p = tmpStatePath();
    await expect(
      updatePlanningSession("no-such-project", { turnCount: 1 }, p),
    ).rejects.toThrow("No planning session for project no-such-project");
  });
});

// ---------------------------------------------------------------------------
// Get
// ---------------------------------------------------------------------------

describe("getPlanningSession", () => {
  it("returns session by projectId", async () => {
    const p = tmpStatePath();
    await registerPlanningSession("proj-1", makePlanningSession(), p);
    const state = await readPlanningState(p);
    const session = getPlanningSession(state, "proj-1");
    expect(session).not.toBeNull();
    expect(session!.projectId).toBe("proj-1");
  });

  it("returns null for unknown projectId", async () => {
    const p = tmpStatePath();
    const state = await readPlanningState(p);
    const session = getPlanningSession(state, "unknown-proj");
    expect(session).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// End
// ---------------------------------------------------------------------------

describe("endPlanningSession", () => {
  it("sets status to approved", async () => {
    const p = tmpStatePath();
    await registerPlanningSession("proj-1", makePlanningSession(), p);
    await endPlanningSession("proj-1", "approved", p);
    const state = await readPlanningState(p);
    const session = getPlanningSession(state, "proj-1");
    expect(session).not.toBeNull();
    expect(session!.status).toBe("approved");
  });

  it("sets status to abandoned", async () => {
    const p = tmpStatePath();
    await registerPlanningSession("proj-1", makePlanningSession(), p);
    await endPlanningSession("proj-1", "abandoned", p);
    const state = await readPlanningState(p);
    const session = getPlanningSession(state, "proj-1");
    expect(session).not.toBeNull();
    expect(session!.status).toBe("abandoned");
  });
});

// ---------------------------------------------------------------------------
// isInPlanningMode
// ---------------------------------------------------------------------------

describe("isInPlanningMode", () => {
  it("true for interviewing", async () => {
    const p = tmpStatePath();
    await registerPlanningSession("proj-1", makePlanningSession({ status: "interviewing" }), p);
    const state = await readPlanningState(p);
    expect(isInPlanningMode(state, "proj-1")).toBe(true);
  });

  it("true for plan_review", async () => {
    const p = tmpStatePath();
    await registerPlanningSession("proj-1", makePlanningSession({ status: "plan_review" }), p);
    const state = await readPlanningState(p);
    expect(isInPlanningMode(state, "proj-1")).toBe(true);
  });

  it("false for approved", async () => {
    const p = tmpStatePath();
    await registerPlanningSession("proj-1", makePlanningSession({ status: "approved" }), p);
    const state = await readPlanningState(p);
    expect(isInPlanningMode(state, "proj-1")).toBe(false);
  });

  it("false for abandoned", async () => {
    const p = tmpStatePath();
    await registerPlanningSession("proj-1", makePlanningSession({ status: "abandoned" }), p);
    const state = await readPlanningState(p);
    expect(isInPlanningMode(state, "proj-1")).toBe(false);
  });

  it("false for missing project", async () => {
    const p = tmpStatePath();
    const state = await readPlanningState(p);
    expect(isInPlanningMode(state, "no-such-project")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

describe("setPlanningCache / getActivePlanningByProjectId", () => {
  beforeEach(() => {
    clearPlanningCache("cache-proj-1");
  });

  it("round-trip in-memory + clearPlanningCache", () => {
    const session = makePlanningSession({ projectId: "cache-proj-1" });
    setPlanningCache(session);
    const cached = getActivePlanningByProjectId("cache-proj-1");
    expect(cached).not.toBeNull();
    expect(cached!.projectId).toBe("cache-proj-1");
    expect(cached!.projectName).toBe("Test Project");

    clearPlanningCache("cache-proj-1");
    const cleared = getActivePlanningByProjectId("cache-proj-1");
    expect(cleared).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// readPlanningState — additional branch coverage
// ---------------------------------------------------------------------------

describe("readPlanningState — corrupted file recovery", () => {
  it("recovers from corrupted JSON (SyntaxError)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claw-ps-corrupt-"));
    const p = join(dir, "state.json");
    // Write invalid JSON
    writeFileSync(p, "{ not valid json !!!", "utf-8");

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const state = await readPlanningState(p);

    expect(state.sessions).toEqual({});
    expect(state.processedEvents).toEqual([]);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("corrupted"));
    consoleSpy.mockRestore();
  });

  it("fills in missing sessions field from parsed data", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claw-ps-nosessions-"));
    const p = join(dir, "state.json");
    // Valid JSON but missing sessions
    writeFileSync(p, JSON.stringify({ processedEvents: ["e1"] }), "utf-8");

    const state = await readPlanningState(p);
    expect(state.sessions).toEqual({});
    expect(state.processedEvents).toEqual(["e1"]);
  });

  it("fills in missing processedEvents field from parsed data", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claw-ps-noevents-"));
    const p = join(dir, "state.json");
    // Valid JSON but missing processedEvents
    writeFileSync(p, JSON.stringify({ sessions: { "p1": { projectId: "p1" } } }), "utf-8");

    const state = await readPlanningState(p);
    expect(state.sessions).toBeDefined();
    expect(state.sessions["p1"]).toBeDefined();
    expect(state.processedEvents).toEqual([]);
  });

  it("re-throws non-ENOENT, non-SyntaxError errors", async () => {
    // Use a path where the parent is a file (causes ENOTDIR)
    const dir = mkdtempSync(join(tmpdir(), "claw-ps-errthrow-"));
    const filePath = join(dir, "afile");
    writeFileSync(filePath, "data", "utf-8");
    // Trying to read a path that treats a file as a directory
    const badPath = join(filePath, "subdir", "state.json");

    await expect(readPlanningState(badPath)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// writePlanningState — truncation
// ---------------------------------------------------------------------------

describe("writePlanningState — processedEvents truncation", () => {
  it("truncates processedEvents to last 200 when exceeding limit", async () => {
    const p = tmpStatePath();
    const events = Array.from({ length: 250 }, (_, i) => `evt-${i}`);
    const data: PlanningState = {
      sessions: {},
      processedEvents: events,
    };
    await writePlanningState(data, p);
    const state = await readPlanningState(p);
    expect(state.processedEvents).toHaveLength(200);
    // Should keep the last 200 (evt-50 through evt-249)
    expect(state.processedEvents[0]).toBe("evt-50");
    expect(state.processedEvents[199]).toBe("evt-249");
  });

  it("does not truncate when at or below 200", async () => {
    const p = tmpStatePath();
    const events = Array.from({ length: 200 }, (_, i) => `evt-${i}`);
    const data: PlanningState = {
      sessions: {},
      processedEvents: events,
    };
    await writePlanningState(data, p);
    const state = await readPlanningState(p);
    expect(state.processedEvents).toHaveLength(200);
  });
});

// ---------------------------------------------------------------------------
// endPlanningSession — missing session branch
// ---------------------------------------------------------------------------

describe("endPlanningSession — additional branches", () => {
  it("does nothing when session does not exist", async () => {
    const p = tmpStatePath();
    // End a session that was never registered — should not throw
    await endPlanningSession("nonexistent-proj", "abandoned", p);

    const state = await readPlanningState(p);
    expect(state.sessions).toEqual({});
  });

  it("clears planning cache even when session is missing", async () => {
    const p = tmpStatePath();
    const session = makePlanningSession({ projectId: "cache-test" });
    setPlanningCache(session);

    // End session that exists in cache but not in file
    await endPlanningSession("cache-test", "abandoned", p);

    // Cache should be cleared
    expect(getActivePlanningByProjectId("cache-test")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getActivePlanningByProjectId — cache miss
// ---------------------------------------------------------------------------

describe("getActivePlanningByProjectId — additional branches", () => {
  it("returns null for project not in cache", () => {
    const result = getActivePlanningByProjectId("never-cached-project");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// writePlanningState — directory creation
// ---------------------------------------------------------------------------

describe("writePlanningState — directory creation", () => {
  it("creates parent directory if it does not exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claw-ps-newdir-"));
    const p = join(dir, "subdir", "deep", "state.json");
    const data: PlanningState = {
      sessions: {},
      processedEvents: ["e1"],
    };
    await writePlanningState(data, p);
    const state = await readPlanningState(p);
    expect(state.processedEvents).toEqual(["e1"]);
  });
});

// ---------------------------------------------------------------------------
// resolveStatePath — tilde expansion
// ---------------------------------------------------------------------------

describe("resolveStatePath (via readPlanningState)", () => {
  it("expands ~/... path to homedir", async () => {
    // This exercises the `configPath.startsWith("~/")` branch.
    // We can't easily test the exact path but we can verify it doesn't crash
    // and resolves to a real path by using a non-existent file under ~.
    const tildeFile = "~/nonexistent-claw-test-dir-12345/state.json";
    // readPlanningState with ENOENT should return empty state
    const state = await readPlanningState(tildeFile);
    expect(state.sessions).toEqual({});
    expect(state.processedEvents).toEqual([]);
  });
});
