import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
