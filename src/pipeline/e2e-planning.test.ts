/**
 * E2E planning pipeline tests.
 *
 * Exercises the real planning lifecycle: initiatePlanningSession → handlePlannerTurn
 * → runPlanAudit → onApproved → DAG dispatch cascade.
 *
 * Mocked: runAgent, LinearAgentApi. Real: planning-state.ts, planner.ts,
 * planner-tools.ts (auditPlan, buildPlanSnapshot), dag-dispatch.ts.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — external boundaries only
// ---------------------------------------------------------------------------

const { runAgentMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn().mockResolvedValue({ success: true, output: "Mock planner response" }),
}));

vi.mock("../agent/agent.js", () => ({
  runAgent: runAgentMock,
}));

vi.mock("../api/linear-api.js", () => ({}));
vi.mock("openclaw/plugin-sdk", () => ({}));
vi.mock("../infra/observability.js", () => ({
  emitDiagnostic: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (AFTER mocks)
// ---------------------------------------------------------------------------

import { initiatePlanningSession, handlePlannerTurn, runPlanAudit } from "./planner.js";
import { readPlanningState, type PlanningSession } from "./planning-state.js";
import { writeProjectDispatch, readProjectDispatch, onProjectIssueCompleted, onProjectIssueStuck, type ProjectDispatchState } from "./dag-dispatch.js";
import { createMockLinearApi, tmpStatePath } from "../__test__/helpers.js";
import { makeProjectIssue } from "../__test__/fixtures/linear-responses.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createCtx(configPath: string, overrides?: Record<string, unknown>) {
  const linearApi = createMockLinearApi();
  return {
    ctx: {
      api: {
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        pluginConfig: { planningStatePath: configPath, ...overrides },
      } as any,
      linearApi: linearApi as any,
      pluginConfig: { planningStatePath: configPath, ...overrides },
    },
    linearApi,
  };
}

function createSession(configPath: string, overrides?: Partial<PlanningSession>): PlanningSession {
  return {
    projectId: "proj-1",
    projectName: "Test Project",
    rootIssueId: "issue-1",
    rootIdentifier: "PROJ-1",
    teamId: "team-1",
    status: "interviewing",
    startedAt: new Date().toISOString(),
    turnCount: 0,
    ...overrides,
  };
}

/** Build a set of project issues that will pass auditPlan (description ≥ 50 chars, estimate, priority). */
function makePassingIssues() {
  return [
    makeProjectIssue("PROJ-2", {
      title: "Implement search API",
      description: "Build the search API endpoint with filtering and pagination support for the frontend.",
      estimate: 3,
      priority: 2,
      labels: ["Epic"],
    }),
    makeProjectIssue("PROJ-3", {
      title: "Build search results page",
      description: "Create a search results page component that displays results from the search API endpoint.",
      estimate: 2,
      priority: 2,
      parentIdentifier: "PROJ-2",
    }),
    makeProjectIssue("PROJ-4", {
      title: "Add search autocomplete",
      description: "Implement autocomplete suggestions in the search input using the search API typeahead endpoint.",
      estimate: 1,
      priority: 3,
      parentIdentifier: "PROJ-2",
    }),
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("E2E planning pipeline", () => {
  let configPath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    configPath = tmpStatePath("claw-e2e-plan-");
    runAgentMock.mockResolvedValue({ success: true, output: "Mock planner response" });
  });

  // =========================================================================
  // Test 1: Full lifecycle — initiate → interview → approve
  // =========================================================================
  it("full lifecycle: initiate → interview turns → finalize → approved", async () => {
    const { ctx, linearApi } = createCtx(configPath);

    const rootIssue = { id: "issue-1", identifier: "PROJ-1", title: "Root Issue", team: { id: "team-1" } };

    // Mock getProject and getTeamStates for initiation
    linearApi.getProject.mockResolvedValue({
      id: "proj-1",
      name: "Test Project",
      teams: { nodes: [{ id: "team-1", name: "Team" }] },
    });
    linearApi.getTeamStates.mockResolvedValue([
      { id: "st-1", name: "Backlog", type: "backlog" },
    ]);

    // Step 1: Initiate planning session
    await initiatePlanningSession(ctx, "proj-1", rootIssue);

    // Verify welcome comment posted
    expect(linearApi.createComment).toHaveBeenCalledWith(
      "issue-1",
      expect.stringContaining("planning mode"),
    );

    // Verify session registered
    let state = await readPlanningState(configPath);
    expect(state.sessions["proj-1"]).toBeDefined();
    expect(state.sessions["proj-1"].status).toBe("interviewing");
    expect(state.sessions["proj-1"].turnCount).toBe(0);

    // Step 2: Interview turn 1
    const session = createSession(configPath);

    // Mock getProjectIssues and getIssueDetails for interview
    linearApi.getProjectIssues.mockResolvedValue([]);
    linearApi.getIssueDetails.mockResolvedValue({
      id: "issue-1",
      identifier: "PROJ-1",
      title: "Root Issue",
      comments: { nodes: [] },
      project: { id: "proj-1" },
      team: { id: "team-1" },
    });

    await handlePlannerTurn(ctx, session, {
      issueId: "issue-1",
      commentBody: "Build a search API and results page",
      commentorName: "User",
    });

    // Verify runAgent called for interview
    expect(runAgentMock).toHaveBeenCalledTimes(1);

    // Verify agent response posted as comment
    expect(linearApi.createComment).toHaveBeenCalledWith("issue-1", "Mock planner response");

    // Verify turnCount incremented
    state = await readPlanningState(configPath);
    expect(state.sessions["proj-1"].turnCount).toBe(1);

    // Step 3: Interview turn 2
    vi.clearAllMocks();
    runAgentMock.mockResolvedValue({ success: true, output: "Great, plan updated." });

    const session2 = { ...session, turnCount: 1 };
    await handlePlannerTurn(ctx, session2, {
      issueId: "issue-1",
      commentBody: "Add autocomplete too",
      commentorName: "User",
    });

    expect(runAgentMock).toHaveBeenCalledTimes(1);
    state = await readPlanningState(configPath);
    expect(state.sessions["proj-1"].turnCount).toBe(2);

    // Step 4: Finalize — with passing issues in the project
    vi.clearAllMocks();
    linearApi.getProjectIssues.mockResolvedValue(makePassingIssues());

    const session3 = { ...session, turnCount: 2 };
    const onApproved = vi.fn();

    await handlePlannerTurn(ctx, session3, {
      issueId: "issue-1",
      commentBody: "finalize plan",
      commentorName: "User",
    }, { onApproved });

    // Verify "Plan Approved" comment
    expect(linearApi.createComment).toHaveBeenCalledWith(
      "issue-1",
      expect.stringContaining("Plan Approved"),
    );

    // Verify session ended as approved
    state = await readPlanningState(configPath);
    expect(state.sessions["proj-1"].status).toBe("approved");

    // Verify onApproved callback fired
    expect(onApproved).toHaveBeenCalledWith("proj-1");
  });

  // =========================================================================
  // Test 2: Audit fail → re-plan → pass
  // =========================================================================
  it("audit fail → fix issues → re-finalize → approved", async () => {
    const { ctx, linearApi } = createCtx(configPath);
    const session = createSession(configPath);

    // Register session so updatePlanningSession/endPlanningSession can find it
    const { registerPlanningSession } = await import("./planning-state.js");
    await registerPlanningSession("proj-1", session, configPath);

    linearApi.getIssueDetails.mockResolvedValue({
      id: "issue-1",
      identifier: "PROJ-1",
      title: "Root Issue",
      comments: { nodes: [] },
    });

    // First finalize — with issues that fail audit (missing descriptions/estimates)
    linearApi.getProjectIssues.mockResolvedValue([
      makeProjectIssue("PROJ-2", {
        title: "Bad issue",
        description: "short", // <50 chars → audit fails
      }),
    ]);

    await runPlanAudit(ctx, session);

    // Verify "Plan Audit Failed" comment
    expect(linearApi.createComment).toHaveBeenCalledWith(
      "issue-1",
      expect.stringContaining("Plan Audit Failed"),
    );

    // Session should still be interviewing (NOT approved)
    let state = await readPlanningState(configPath);
    expect(state.sessions["proj-1"].status).toBe("interviewing");

    // Second finalize — with proper issues
    vi.clearAllMocks();
    linearApi.getProjectIssues.mockResolvedValue(makePassingIssues());

    const onApproved = vi.fn();
    await runPlanAudit(ctx, session, { onApproved });

    // Now should be approved
    expect(linearApi.createComment).toHaveBeenCalledWith(
      "issue-1",
      expect.stringContaining("Plan Approved"),
    );

    state = await readPlanningState(configPath);
    expect(state.sessions["proj-1"].status).toBe("approved");
    expect(onApproved).toHaveBeenCalledWith("proj-1");
  });

  // =========================================================================
  // Test 3: Abandon
  // =========================================================================
  it("abandon: cancel planning ends session", async () => {
    const { ctx, linearApi } = createCtx(configPath);
    const session = createSession(configPath);

    // Register session so endPlanningSession can find it
    const { registerPlanningSession } = await import("./planning-state.js");
    await registerPlanningSession("proj-1", session, configPath);

    await handlePlannerTurn(ctx, session, {
      issueId: "issue-1",
      commentBody: "cancel planning",
      commentorName: "User",
    });

    // Verify abandonment comment
    expect(linearApi.createComment).toHaveBeenCalledWith(
      "issue-1",
      expect.stringContaining("Planning mode ended"),
    );

    // Session ended as abandoned
    const state = await readPlanningState(configPath);
    expect(state.sessions["proj-1"].status).toBe("abandoned");
  });

  // =========================================================================
  // Test 4: onApproved fires
  // =========================================================================
  it("onApproved callback fires with projectId on approval", async () => {
    const { ctx, linearApi } = createCtx(configPath);
    const session = createSession(configPath);

    // Register session so endPlanningSession can update it
    const { registerPlanningSession } = await import("./planning-state.js");
    await registerPlanningSession("proj-1", session, configPath);

    linearApi.getProjectIssues.mockResolvedValue(makePassingIssues());

    const onApproved = vi.fn();
    await runPlanAudit(ctx, session, { onApproved });

    expect(onApproved).toHaveBeenCalledTimes(1);
    expect(onApproved).toHaveBeenCalledWith("proj-1");
  });

  // =========================================================================
  // Test 5: DAG cascade — full chain
  // =========================================================================
  it("DAG cascade: complete issues in sequence, project completes", async () => {
    const dagConfigPath = tmpStatePath("claw-e2e-dag-");
    const notifyCalls: Array<[string, unknown]> = [];
    const hookCtx = {
      api: {
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      } as any,
      linearApi: {} as any,
      notify: vi.fn(async (kind: string, payload: unknown) => {
        notifyCalls.push([kind, payload]);
      }),
      pluginConfig: {},
      configPath: dagConfigPath,
    };

    // Set up 3-issue project: A → B → C
    const projectDispatch: ProjectDispatchState = {
      projectId: "proj-1",
      projectName: "Test Project",
      rootIdentifier: "PROJ-1",
      status: "dispatching",
      startedAt: new Date().toISOString(),
      maxConcurrent: 3,
      issues: {
        "PROJ-A": {
          identifier: "PROJ-A",
          issueId: "id-a",
          dependsOn: [],
          unblocks: ["PROJ-B"],
          dispatchStatus: "dispatched",
        },
        "PROJ-B": {
          identifier: "PROJ-B",
          issueId: "id-b",
          dependsOn: ["PROJ-A"],
          unblocks: ["PROJ-C"],
          dispatchStatus: "pending",
        },
        "PROJ-C": {
          identifier: "PROJ-C",
          issueId: "id-c",
          dependsOn: ["PROJ-B"],
          unblocks: [],
          dispatchStatus: "pending",
        },
      },
    };
    await writeProjectDispatch(projectDispatch, dagConfigPath);

    // Complete A → B becomes ready
    await onProjectIssueCompleted(hookCtx, "proj-1", "PROJ-A");

    let state = await readProjectDispatch("proj-1", dagConfigPath);
    expect(state!.issues["PROJ-A"].dispatchStatus).toBe("done");
    expect(state!.issues["PROJ-B"].dispatchStatus).toBe("dispatched");
    expect(state!.issues["PROJ-C"].dispatchStatus).toBe("pending");
    expect(state!.status).toBe("dispatching");

    // Complete B → C becomes ready
    await onProjectIssueCompleted(hookCtx, "proj-1", "PROJ-B");

    state = await readProjectDispatch("proj-1", dagConfigPath);
    expect(state!.issues["PROJ-B"].dispatchStatus).toBe("done");
    expect(state!.issues["PROJ-C"].dispatchStatus).toBe("dispatched");
    expect(state!.status).toBe("dispatching");

    // Complete C → project complete
    await onProjectIssueCompleted(hookCtx, "proj-1", "PROJ-C");

    state = await readProjectDispatch("proj-1", dagConfigPath);
    expect(state!.issues["PROJ-C"].dispatchStatus).toBe("done");
    expect(state!.status).toBe("completed");

    // Verify notifications
    const progressNotifications = notifyCalls.filter(([k]) => k === "project_progress");
    const completeNotifications = notifyCalls.filter(([k]) => k === "project_complete");
    expect(progressNotifications.length).toBe(2); // after A, after B
    expect(completeNotifications.length).toBe(1); // after C
  });

  // =========================================================================
  // Test 6: DAG stuck
  // =========================================================================
  it("DAG stuck: stuck issue blocks dependent, project stuck", async () => {
    const dagConfigPath = tmpStatePath("claw-e2e-dag-stuck-");
    const hookCtx = {
      api: {
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      } as any,
      linearApi: {} as any,
      notify: vi.fn().mockResolvedValue(undefined),
      pluginConfig: {},
      configPath: dagConfigPath,
    };

    // 2-issue project: A → B
    const projectDispatch: ProjectDispatchState = {
      projectId: "proj-1",
      projectName: "Test Project",
      rootIdentifier: "PROJ-1",
      status: "dispatching",
      startedAt: new Date().toISOString(),
      maxConcurrent: 3,
      issues: {
        "PROJ-A": {
          identifier: "PROJ-A",
          issueId: "id-a",
          dependsOn: [],
          unblocks: ["PROJ-B"],
          dispatchStatus: "dispatched",
        },
        "PROJ-B": {
          identifier: "PROJ-B",
          issueId: "id-b",
          dependsOn: ["PROJ-A"],
          unblocks: [],
          dispatchStatus: "pending",
        },
      },
    };
    await writeProjectDispatch(projectDispatch, dagConfigPath);

    // A gets stuck
    await onProjectIssueStuck(hookCtx, "proj-1", "PROJ-A");

    const state = await readProjectDispatch("proj-1", dagConfigPath);
    expect(state!.issues["PROJ-A"].dispatchStatus).toBe("stuck");
    expect(state!.issues["PROJ-B"].dispatchStatus).toBe("pending"); // still blocked
    expect(state!.status).toBe("stuck"); // project stuck — no progress possible
  });
});
