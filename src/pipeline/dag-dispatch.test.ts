import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildDispatchQueue,
  getReadyIssues,
  getActiveCount,
  isProjectDispatchComplete,
  isProjectStuck,
  readProjectDispatch,
  writeProjectDispatch,
  startProjectDispatch,
  dispatchReadyIssues,
  onProjectIssueCompleted,
  onProjectIssueStuck,
  type ProjectIssueStatus,
  type ProjectDispatchState,
} from "./dag-dispatch.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpStatePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "claw-dag-"));
  return join(dir, "state.json");
}

/** Create a minimal issue shape for buildDispatchQueue */
function makeIssue(
  identifier: string,
  opts?: {
    labels?: string[];
    relations?: Array<{ type: string; relatedIssue: { identifier: string } }>;
  },
) {
  return {
    id: `id-${identifier}`,
    identifier,
    labels: {
      nodes: (opts?.labels ?? []).map((name) => ({ name })),
    },
    relations: {
      nodes: (opts?.relations ?? []).map((r) => ({
        type: r.type,
        relatedIssue: r.relatedIssue,
      })),
    },
  };
}

function makeIssueStatus(
  identifier: string,
  overrides?: Partial<ProjectIssueStatus>,
): ProjectIssueStatus {
  return {
    identifier,
    issueId: `id-${identifier}`,
    dependsOn: [],
    unblocks: [],
    dispatchStatus: "pending",
    ...overrides,
  };
}

function makeProjectDispatch(
  overrides?: Partial<ProjectDispatchState>,
): ProjectDispatchState {
  return {
    projectId: "proj-1",
    projectName: "Test Project",
    rootIdentifier: "PROJ-1",
    status: "dispatching",
    startedAt: new Date().toISOString(),
    maxConcurrent: 3,
    issues: {},
    ...overrides,
  };
}

function makeHookCtx(configPath: string) {
  return {
    api: {
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    } as any,
    linearApi: {} as any,
    notify: vi.fn().mockResolvedValue(undefined),
    pluginConfig: { planningStatePath: configPath },
    configPath,
  };
}

// ---------------------------------------------------------------------------
// buildDispatchQueue
// ---------------------------------------------------------------------------

describe("buildDispatchQueue", () => {
  it("creates entries for all issues", () => {
    const issues = [makeIssue("PROJ-1"), makeIssue("PROJ-2"), makeIssue("PROJ-3")];
    const queue = buildDispatchQueue(issues);
    expect(Object.keys(queue)).toHaveLength(3);
    expect(queue["PROJ-1"].dispatchStatus).toBe("pending");
    expect(queue["PROJ-2"].dispatchStatus).toBe("pending");
  });

  it("marks epic-labeled issues as skipped", () => {
    const issues = [
      makeIssue("PROJ-1", { labels: ["Epic"] }),
      makeIssue("PROJ-2"),
    ];
    const queue = buildDispatchQueue(issues);
    expect(queue["PROJ-1"].dispatchStatus).toBe("skipped");
    expect(queue["PROJ-2"].dispatchStatus).toBe("pending");
  });

  it("case-insensitive epic detection", () => {
    const issues = [makeIssue("PROJ-1", { labels: ["epic-feature"] })];
    const queue = buildDispatchQueue(issues);
    expect(queue["PROJ-1"].dispatchStatus).toBe("skipped");
  });

  it("parses blocks relations correctly", () => {
    const issues = [
      makeIssue("PROJ-1", {
        relations: [{ type: "blocks", relatedIssue: { identifier: "PROJ-2" } }],
      }),
      makeIssue("PROJ-2"),
    ];
    const queue = buildDispatchQueue(issues);
    expect(queue["PROJ-1"].unblocks).toContain("PROJ-2");
    expect(queue["PROJ-2"].dependsOn).toContain("PROJ-1");
  });

  it("parses blocked_by relations correctly", () => {
    const issues = [
      makeIssue("PROJ-1"),
      makeIssue("PROJ-2", {
        relations: [{ type: "blocked_by", relatedIssue: { identifier: "PROJ-1" } }],
      }),
    ];
    const queue = buildDispatchQueue(issues);
    expect(queue["PROJ-2"].dependsOn).toContain("PROJ-1");
    expect(queue["PROJ-1"].unblocks).toContain("PROJ-2");
  });

  it("ignores relations to issues outside the project", () => {
    const issues = [
      makeIssue("PROJ-1", {
        relations: [{ type: "blocks", relatedIssue: { identifier: "OTHER-1" } }],
      }),
    ];
    const queue = buildDispatchQueue(issues);
    expect(queue["PROJ-1"].unblocks).toHaveLength(0);
  });

  it("filters skipped issues from dependency lists", () => {
    const issues = [
      makeIssue("PROJ-1", { labels: ["Epic"] }),
      makeIssue("PROJ-2", {
        relations: [{ type: "blocked_by", relatedIssue: { identifier: "PROJ-1" } }],
      }),
    ];
    const queue = buildDispatchQueue(issues);
    // PROJ-2 should not depend on the epic
    expect(queue["PROJ-2"].dependsOn).toHaveLength(0);
  });

  it("handles empty issue list", () => {
    const queue = buildDispatchQueue([]);
    expect(Object.keys(queue)).toHaveLength(0);
  });

  it("handles diamond dependency graph", () => {
    //   A
    //  / \
    // B   C
    //  \ /
    //   D
    const issues = [
      makeIssue("A", {
        relations: [
          { type: "blocks", relatedIssue: { identifier: "B" } },
          { type: "blocks", relatedIssue: { identifier: "C" } },
        ],
      }),
      makeIssue("B", {
        relations: [{ type: "blocks", relatedIssue: { identifier: "D" } }],
      }),
      makeIssue("C", {
        relations: [{ type: "blocks", relatedIssue: { identifier: "D" } }],
      }),
      makeIssue("D"),
    ];
    const queue = buildDispatchQueue(issues);
    expect(queue["A"].dependsOn).toHaveLength(0);
    expect(queue["B"].dependsOn).toEqual(["A"]);
    expect(queue["C"].dependsOn).toEqual(["A"]);
    expect(queue["D"].dependsOn).toEqual(expect.arrayContaining(["B", "C"]));
    expect(queue["D"].dependsOn).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// getReadyIssues
// ---------------------------------------------------------------------------

describe("getReadyIssues", () => {
  it("returns pending issues with no dependencies", () => {
    const issues: Record<string, ProjectIssueStatus> = {
      A: makeIssueStatus("A"),
      B: makeIssueStatus("B", { dependsOn: ["A"] }),
    };
    const ready = getReadyIssues(issues);
    expect(ready).toHaveLength(1);
    expect(ready[0].identifier).toBe("A");
  });

  it("returns pending issues whose deps are all done", () => {
    const issues: Record<string, ProjectIssueStatus> = {
      A: makeIssueStatus("A", { dispatchStatus: "done" }),
      B: makeIssueStatus("B", { dependsOn: ["A"] }),
    };
    const ready = getReadyIssues(issues);
    expect(ready).toHaveLength(1);
    expect(ready[0].identifier).toBe("B");
  });

  it("excludes dispatched issues", () => {
    const issues: Record<string, ProjectIssueStatus> = {
      A: makeIssueStatus("A", { dispatchStatus: "dispatched" }),
    };
    expect(getReadyIssues(issues)).toHaveLength(0);
  });

  it("excludes issues with incomplete deps", () => {
    const issues: Record<string, ProjectIssueStatus> = {
      A: makeIssueStatus("A", { dispatchStatus: "dispatched" }),
      B: makeIssueStatus("B", { dependsOn: ["A"] }),
    };
    expect(getReadyIssues(issues)).toHaveLength(0);
  });

  it("returns multiple ready issues", () => {
    const issues: Record<string, ProjectIssueStatus> = {
      A: makeIssueStatus("A"),
      B: makeIssueStatus("B"),
      C: makeIssueStatus("C", { dependsOn: ["A"] }),
    };
    const ready = getReadyIssues(issues);
    expect(ready).toHaveLength(2);
    expect(ready.map((r) => r.identifier).sort()).toEqual(["A", "B"]);
  });
});

// ---------------------------------------------------------------------------
// getActiveCount
// ---------------------------------------------------------------------------

describe("getActiveCount", () => {
  it("counts dispatched issues", () => {
    const issues: Record<string, ProjectIssueStatus> = {
      A: makeIssueStatus("A", { dispatchStatus: "dispatched" }),
      B: makeIssueStatus("B", { dispatchStatus: "dispatched" }),
      C: makeIssueStatus("C", { dispatchStatus: "done" }),
      D: makeIssueStatus("D"),
    };
    expect(getActiveCount(issues)).toBe(2);
  });

  it("returns 0 when none dispatched", () => {
    const issues: Record<string, ProjectIssueStatus> = {
      A: makeIssueStatus("A"),
      B: makeIssueStatus("B", { dispatchStatus: "done" }),
    };
    expect(getActiveCount(issues)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// isProjectDispatchComplete
// ---------------------------------------------------------------------------

describe("isProjectDispatchComplete", () => {
  it("true when all done/skipped/stuck", () => {
    const issues: Record<string, ProjectIssueStatus> = {
      A: makeIssueStatus("A", { dispatchStatus: "done" }),
      B: makeIssueStatus("B", { dispatchStatus: "stuck" }),
      C: makeIssueStatus("C", { dispatchStatus: "skipped" }),
    };
    expect(isProjectDispatchComplete(issues)).toBe(true);
  });

  it("false when pending issues remain", () => {
    const issues: Record<string, ProjectIssueStatus> = {
      A: makeIssueStatus("A", { dispatchStatus: "done" }),
      B: makeIssueStatus("B"),
    };
    expect(isProjectDispatchComplete(issues)).toBe(false);
  });

  it("false when dispatched issues remain", () => {
    const issues: Record<string, ProjectIssueStatus> = {
      A: makeIssueStatus("A", { dispatchStatus: "dispatched" }),
    };
    expect(isProjectDispatchComplete(issues)).toBe(false);
  });

  it("true for empty issues", () => {
    expect(isProjectDispatchComplete({})).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isProjectStuck
// ---------------------------------------------------------------------------

describe("isProjectStuck", () => {
  it("true when stuck issues block all pending", () => {
    const issues: Record<string, ProjectIssueStatus> = {
      A: makeIssueStatus("A", { dispatchStatus: "stuck" }),
      B: makeIssueStatus("B", { dependsOn: ["A"] }),
    };
    expect(isProjectStuck(issues)).toBe(true);
  });

  it("false when no issues are stuck", () => {
    const issues: Record<string, ProjectIssueStatus> = {
      A: makeIssueStatus("A", { dispatchStatus: "done" }),
      B: makeIssueStatus("B"),
    };
    expect(isProjectStuck(issues)).toBe(false);
  });

  it("false when active issues still in flight", () => {
    const issues: Record<string, ProjectIssueStatus> = {
      A: makeIssueStatus("A", { dispatchStatus: "stuck" }),
      B: makeIssueStatus("B", { dispatchStatus: "dispatched" }),
    };
    expect(isProjectStuck(issues)).toBe(false);
  });

  it("false when some pending issues can still be dispatched", () => {
    const issues: Record<string, ProjectIssueStatus> = {
      A: makeIssueStatus("A", { dispatchStatus: "stuck" }),
      B: makeIssueStatus("B"), // no deps — still ready
    };
    expect(isProjectStuck(issues)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

describe("readProjectDispatch / writeProjectDispatch", () => {
  it("returns null for non-existent project", async () => {
    const p = tmpStatePath();
    const result = await readProjectDispatch("proj-1", p);
    expect(result).toBeNull();
  });

  it("round-trips project dispatch state", async () => {
    const p = tmpStatePath();
    const pd = makeProjectDispatch({
      issues: {
        "PROJ-1": makeIssueStatus("PROJ-1", { dispatchStatus: "done" }),
        "PROJ-2": makeIssueStatus("PROJ-2"),
      },
    });
    await writeProjectDispatch(pd, p);
    const result = await readProjectDispatch("proj-1", p);
    expect(result).not.toBeNull();
    expect(result!.projectName).toBe("Test Project");
    expect(Object.keys(result!.issues)).toHaveLength(2);
    expect(result!.issues["PROJ-1"].dispatchStatus).toBe("done");
  });

  it("can store multiple project dispatches", async () => {
    const p = tmpStatePath();
    const pd1 = makeProjectDispatch({ projectId: "proj-1", projectName: "P1" });
    const pd2 = makeProjectDispatch({ projectId: "proj-2", projectName: "P2" });
    await writeProjectDispatch(pd1, p);
    await writeProjectDispatch(pd2, p);

    const r1 = await readProjectDispatch("proj-1", p);
    const r2 = await readProjectDispatch("proj-2", p);
    expect(r1!.projectName).toBe("P1");
    expect(r2!.projectName).toBe("P2");
  });
});

// ---------------------------------------------------------------------------
// onProjectIssueCompleted
// ---------------------------------------------------------------------------

describe("onProjectIssueCompleted", () => {
  it("marks issue as done and saves state", async () => {
    const p = tmpStatePath();
    const pd = makeProjectDispatch({
      issues: {
        "PROJ-1": makeIssueStatus("PROJ-1", { dispatchStatus: "dispatched" }),
        "PROJ-2": makeIssueStatus("PROJ-2", { dependsOn: ["PROJ-1"] }),
      },
    });
    await writeProjectDispatch(pd, p);

    const hookCtx = makeHookCtx(p);
    await onProjectIssueCompleted(hookCtx, "proj-1", "PROJ-1");

    const result = await readProjectDispatch("proj-1", p);
    expect(result!.issues["PROJ-1"].dispatchStatus).toBe("done");
    expect(result!.issues["PROJ-1"].completedAt).toBeDefined();
    expect(hookCtx.notify).toHaveBeenCalledWith("project_progress", expect.any(Object));
  });

  it("marks project as completed when all issues done", async () => {
    const p = tmpStatePath();
    const pd = makeProjectDispatch({
      issues: {
        "PROJ-1": makeIssueStatus("PROJ-1", { dispatchStatus: "done" }),
        "PROJ-2": makeIssueStatus("PROJ-2", { dispatchStatus: "dispatched" }),
      },
    });
    await writeProjectDispatch(pd, p);

    const hookCtx = makeHookCtx(p);
    await onProjectIssueCompleted(hookCtx, "proj-1", "PROJ-2");

    const result = await readProjectDispatch("proj-1", p);
    expect(result!.status).toBe("completed");
    expect(hookCtx.notify).toHaveBeenCalledWith("project_complete", expect.any(Object));
  });

  it("does nothing if project is not dispatching", async () => {
    const p = tmpStatePath();
    const pd = makeProjectDispatch({ status: "completed" });
    await writeProjectDispatch(pd, p);

    const hookCtx = makeHookCtx(p);
    await onProjectIssueCompleted(hookCtx, "proj-1", "PROJ-1");

    expect(hookCtx.notify).not.toHaveBeenCalled();
  });

  it("does nothing if issue not found in dispatch", async () => {
    const p = tmpStatePath();
    const pd = makeProjectDispatch({
      issues: { "PROJ-1": makeIssueStatus("PROJ-1") },
    });
    await writeProjectDispatch(pd, p);

    const hookCtx = makeHookCtx(p);
    await onProjectIssueCompleted(hookCtx, "proj-1", "PROJ-999");

    expect(hookCtx.api.logger.warn).toHaveBeenCalled();
  });

  it("detects stuck project after completion", async () => {
    const p = tmpStatePath();
    // PROJ-1 is stuck, PROJ-2 is dispatched (about to complete),
    // PROJ-3 depends on PROJ-1 (stuck) — no more progress possible after PROJ-2 done
    const pd = makeProjectDispatch({
      issues: {
        "PROJ-1": makeIssueStatus("PROJ-1", { dispatchStatus: "stuck" }),
        "PROJ-2": makeIssueStatus("PROJ-2", { dispatchStatus: "dispatched" }),
        "PROJ-3": makeIssueStatus("PROJ-3", { dependsOn: ["PROJ-1"] }),
      },
    });
    await writeProjectDispatch(pd, p);

    const hookCtx = makeHookCtx(p);
    // PROJ-2 completes, but PROJ-3 still depends on stuck PROJ-1
    await onProjectIssueCompleted(hookCtx, "proj-1", "PROJ-2");

    const result = await readProjectDispatch("proj-1", p);
    expect(result!.status).toBe("stuck");
  });
});

// ---------------------------------------------------------------------------
// onProjectIssueStuck
// ---------------------------------------------------------------------------

describe("onProjectIssueStuck", () => {
  it("marks issue as stuck", async () => {
    const p = tmpStatePath();
    const pd = makeProjectDispatch({
      issues: {
        "PROJ-1": makeIssueStatus("PROJ-1", { dispatchStatus: "dispatched" }),
        "PROJ-2": makeIssueStatus("PROJ-2", { dependsOn: ["PROJ-1"] }),
      },
    });
    await writeProjectDispatch(pd, p);

    const hookCtx = makeHookCtx(p);
    await onProjectIssueStuck(hookCtx, "proj-1", "PROJ-1");

    const result = await readProjectDispatch("proj-1", p);
    expect(result!.issues["PROJ-1"].dispatchStatus).toBe("stuck");
  });

  it("marks project as stuck when all pending depend on stuck", async () => {
    const p = tmpStatePath();
    const pd = makeProjectDispatch({
      issues: {
        "PROJ-1": makeIssueStatus("PROJ-1", { dispatchStatus: "dispatched" }),
        "PROJ-2": makeIssueStatus("PROJ-2", { dependsOn: ["PROJ-1"] }),
      },
    });
    await writeProjectDispatch(pd, p);

    const hookCtx = makeHookCtx(p);
    await onProjectIssueStuck(hookCtx, "proj-1", "PROJ-1");

    const result = await readProjectDispatch("proj-1", p);
    expect(result!.status).toBe("stuck");
  });

  it("does not mark project stuck if other issues can still progress", async () => {
    const p = tmpStatePath();
    const pd = makeProjectDispatch({
      issues: {
        "PROJ-1": makeIssueStatus("PROJ-1", { dispatchStatus: "dispatched" }),
        "PROJ-2": makeIssueStatus("PROJ-2"), // no deps, can still dispatch
        "PROJ-3": makeIssueStatus("PROJ-3", { dependsOn: ["PROJ-1"] }),
      },
    });
    await writeProjectDispatch(pd, p);

    const hookCtx = makeHookCtx(p);
    await onProjectIssueStuck(hookCtx, "proj-1", "PROJ-1");

    const result = await readProjectDispatch("proj-1", p);
    expect(result!.issues["PROJ-1"].dispatchStatus).toBe("stuck");
    expect(result!.status).toBe("dispatching"); // not stuck overall
  });

  it("does nothing if project is not dispatching", async () => {
    const p = tmpStatePath();
    const pd = makeProjectDispatch({ status: "completed" });
    await writeProjectDispatch(pd, p);

    const hookCtx = makeHookCtx(p);
    await onProjectIssueStuck(hookCtx, "proj-1", "PROJ-1");

    // No crash, no state change
    const result = await readProjectDispatch("proj-1", p);
    expect(result!.status).toBe("completed");
  });

  it("does nothing if issue not found in dispatch", async () => {
    const p = tmpStatePath();
    const pd = makeProjectDispatch({
      issues: { "PROJ-1": makeIssueStatus("PROJ-1", { dispatchStatus: "dispatched" }) },
    });
    await writeProjectDispatch(pd, p);

    const hookCtx = makeHookCtx(p);
    await onProjectIssueStuck(hookCtx, "proj-1", "PROJ-999");

    // Should not crash, PROJ-1 remains dispatched
    const result = await readProjectDispatch("proj-1", p);
    expect(result!.issues["PROJ-1"].dispatchStatus).toBe("dispatched");
  });

  it("does nothing if projectDispatch is null (non-existent project)", async () => {
    const p = tmpStatePath();

    const hookCtx = makeHookCtx(p);
    // Should not crash on non-existent project
    await onProjectIssueStuck(hookCtx, "no-such-proj", "PROJ-1");
  });
});

// ---------------------------------------------------------------------------
// buildDispatchQueue — additional branch coverage
// ---------------------------------------------------------------------------

describe("buildDispatchQueue — additional branches", () => {
  it("ignores relations with null relatedIssue", () => {
    const issues = [
      makeIssue("PROJ-1", {
        relations: [{ type: "blocks", relatedIssue: null as any }],
      }),
    ];
    const queue = buildDispatchQueue(issues);
    expect(queue["PROJ-1"].unblocks).toHaveLength(0);
  });

  it("ignores relations with undefined identifier", () => {
    const issues = [
      makeIssue("PROJ-1", {
        relations: [{ type: "blocks", relatedIssue: { identifier: undefined as any } }],
      }),
    ];
    const queue = buildDispatchQueue(issues);
    expect(queue["PROJ-1"].unblocks).toHaveLength(0);
  });

  it("ignores non-blocks/non-blocked_by relation types", () => {
    const issues = [
      makeIssue("PROJ-1", {
        relations: [{ type: "related", relatedIssue: { identifier: "PROJ-2" } }],
      }),
      makeIssue("PROJ-2"),
    ];
    const queue = buildDispatchQueue(issues);
    expect(queue["PROJ-1"].unblocks).toHaveLength(0);
    expect(queue["PROJ-1"].dependsOn).toHaveLength(0);
    expect(queue["PROJ-2"].dependsOn).toHaveLength(0);
    expect(queue["PROJ-2"].unblocks).toHaveLength(0);
  });

  it("filters skipped (epic) dependencies from unblocks lists", () => {
    const issues = [
      makeIssue("PROJ-1", {
        relations: [{ type: "blocks", relatedIssue: { identifier: "PROJ-2" } }],
      }),
      makeIssue("PROJ-2", { labels: ["Epic"] }),
    ];
    const queue = buildDispatchQueue(issues);
    // PROJ-1 unblocks PROJ-2 but PROJ-2 is skipped — should be filtered
    expect(queue["PROJ-1"].unblocks).toHaveLength(0);
  });

  it("handles issues with null labels gracefully", () => {
    const issue = {
      id: "id-PROJ-1",
      identifier: "PROJ-1",
      labels: null as any,
      relations: { nodes: [] },
    };
    const queue = buildDispatchQueue([issue as any]);
    // Should not crash; labels?.nodes?.some returns falsy
    expect(queue["PROJ-1"].dispatchStatus).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// getReadyIssues — additional branch coverage
// ---------------------------------------------------------------------------

describe("getReadyIssues — additional branches", () => {
  it("excludes stuck issues", () => {
    const issues: Record<string, ProjectIssueStatus> = {
      A: makeIssueStatus("A", { dispatchStatus: "stuck" }),
    };
    expect(getReadyIssues(issues)).toHaveLength(0);
  });

  it("excludes skipped issues", () => {
    const issues: Record<string, ProjectIssueStatus> = {
      A: makeIssueStatus("A", { dispatchStatus: "skipped" }),
    };
    expect(getReadyIssues(issues)).toHaveLength(0);
  });

  it("excludes pending issues where a dep is stuck", () => {
    const issues: Record<string, ProjectIssueStatus> = {
      A: makeIssueStatus("A", { dispatchStatus: "stuck" }),
      B: makeIssueStatus("B", { dependsOn: ["A"] }),
    };
    expect(getReadyIssues(issues)).toHaveLength(0);
  });

  it("returns empty for empty issues", () => {
    expect(getReadyIssues({})).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// isProjectStuck — additional branch coverage
// ---------------------------------------------------------------------------

describe("isProjectStuck — additional branches", () => {
  it("false when no issues at all", () => {
    expect(isProjectStuck({})).toBe(false);
  });

  it("false when all issues are done (no stuck)", () => {
    const issues: Record<string, ProjectIssueStatus> = {
      A: makeIssueStatus("A", { dispatchStatus: "done" }),
      B: makeIssueStatus("B", { dispatchStatus: "done" }),
    };
    expect(isProjectStuck(issues)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// dispatchReadyIssues
// ---------------------------------------------------------------------------

describe("dispatchReadyIssues", () => {
  it("returns early when no ready issues", async () => {
    const p = tmpStatePath();
    const hookCtx = makeHookCtx(p);
    const pd = makeProjectDispatch({
      issues: {
        "PROJ-1": makeIssueStatus("PROJ-1", { dispatchStatus: "dispatched" }),
        "PROJ-2": makeIssueStatus("PROJ-2", { dependsOn: ["PROJ-1"] }),
      },
    });

    await dispatchReadyIssues(hookCtx, pd);

    // No issues dispatched — logger.info not called for dispatching
    expect(hookCtx.api.logger.info).not.toHaveBeenCalledWith(
      expect.stringContaining("dispatching PROJ"),
    );
  });

  it("returns early when all slots are filled", async () => {
    const p = tmpStatePath();
    const hookCtx = makeHookCtx(p);
    const pd = makeProjectDispatch({
      maxConcurrent: 1,
      issues: {
        "PROJ-1": makeIssueStatus("PROJ-1", { dispatchStatus: "dispatched" }),
        "PROJ-2": makeIssueStatus("PROJ-2"),
      },
    });

    await dispatchReadyIssues(hookCtx, pd);

    // PROJ-2 is ready but no slots — should not be dispatched
    expect(pd.issues["PROJ-2"].dispatchStatus).toBe("pending");
  });

  it("dispatches ready issues up to max concurrent", async () => {
    const p = tmpStatePath();
    const hookCtx = makeHookCtx(p);
    const pd = makeProjectDispatch({
      maxConcurrent: 2,
      issues: {
        "PROJ-1": makeIssueStatus("PROJ-1"),
        "PROJ-2": makeIssueStatus("PROJ-2"),
        "PROJ-3": makeIssueStatus("PROJ-3"),
      },
    });

    await dispatchReadyIssues(hookCtx, pd);

    const dispatched = Object.values(pd.issues).filter((i) => i.dispatchStatus === "dispatched");
    expect(dispatched).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// startProjectDispatch
// ---------------------------------------------------------------------------

describe("startProjectDispatch", () => {
  it("creates dispatch state and dispatches leaf issues", async () => {
    const p = tmpStatePath();
    const mockIssues = [
      makeIssue("PROJ-1", {
        relations: [{ type: "blocks", relatedIssue: { identifier: "PROJ-2" } }],
      }),
      makeIssue("PROJ-2"),
    ];

    const hookCtx = {
      api: {
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
      } as any,
      linearApi: {
        getProject: vi.fn().mockResolvedValue({ id: "proj-1", name: "Test Project" }),
        getProjectIssues: vi.fn().mockResolvedValue(mockIssues),
      } as any,
      notify: vi.fn().mockResolvedValue(undefined),
      pluginConfig: { planningStatePath: p },
      configPath: p,
    };

    await startProjectDispatch(hookCtx, "proj-1");

    const result = await readProjectDispatch("proj-1", p);
    expect(result).not.toBeNull();
    expect(result!.status).toBe("dispatching");
    expect(result!.projectName).toBe("Test Project");
    expect(Object.keys(result!.issues)).toHaveLength(2);
    expect(hookCtx.notify).toHaveBeenCalledWith("project_progress", expect.any(Object));
  });

  it("returns early when project has no issues", async () => {
    const p = tmpStatePath();
    const hookCtx = {
      api: {
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
      } as any,
      linearApi: {
        getProject: vi.fn().mockResolvedValue({ id: "proj-1", name: "Empty Project" }),
        getProjectIssues: vi.fn().mockResolvedValue([]),
      } as any,
      notify: vi.fn().mockResolvedValue(undefined),
      pluginConfig: { planningStatePath: p },
      configPath: p,
    };

    await startProjectDispatch(hookCtx, "proj-1");

    expect(hookCtx.api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("no issues found"),
    );
    const result = await readProjectDispatch("proj-1", p);
    expect(result).toBeNull();
  });

  it("uses maxConcurrent from opts when provided", async () => {
    const p = tmpStatePath();
    const hookCtx = {
      api: {
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      } as any,
      linearApi: {
        getProject: vi.fn().mockResolvedValue({ id: "proj-1", name: "Test" }),
        getProjectIssues: vi.fn().mockResolvedValue([makeIssue("PROJ-1")]),
      } as any,
      notify: vi.fn().mockResolvedValue(undefined),
      pluginConfig: { planningStatePath: p },
      configPath: p,
    };

    await startProjectDispatch(hookCtx, "proj-1", { maxConcurrent: 5 });

    const result = await readProjectDispatch("proj-1", p);
    expect(result!.maxConcurrent).toBe(5);
  });

  it("uses maxConcurrent from pluginConfig when opts not provided", async () => {
    const p = tmpStatePath();
    const hookCtx = {
      api: {
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      } as any,
      linearApi: {
        getProject: vi.fn().mockResolvedValue({ id: "proj-1", name: "Test" }),
        getProjectIssues: vi.fn().mockResolvedValue([makeIssue("PROJ-1")]),
      } as any,
      notify: vi.fn().mockResolvedValue(undefined),
      pluginConfig: { planningStatePath: p, maxConcurrentDispatches: 7 },
      configPath: p,
    };

    await startProjectDispatch(hookCtx, "proj-1");

    const result = await readProjectDispatch("proj-1", p);
    expect(result!.maxConcurrent).toBe(7);
  });

  it("defaults maxConcurrent to 3 when no config", async () => {
    const p = tmpStatePath();
    const hookCtx = {
      api: {
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      } as any,
      linearApi: {
        getProject: vi.fn().mockResolvedValue({ id: "proj-1", name: "Test" }),
        getProjectIssues: vi.fn().mockResolvedValue([makeIssue("PROJ-1")]),
      } as any,
      notify: vi.fn().mockResolvedValue(undefined),
      pluginConfig: { planningStatePath: p },
      configPath: p,
    };

    await startProjectDispatch(hookCtx, "proj-1");

    const result = await readProjectDispatch("proj-1", p);
    expect(result!.maxConcurrent).toBe(3);
  });

  it("uses rootIdentifier from planning session when available", async () => {
    const p = tmpStatePath();

    // Pre-register a planning session
    const { registerPlanningSession } = await import("./planning-state.js");
    await registerPlanningSession("proj-1", {
      projectId: "proj-1",
      projectName: "Test",
      rootIssueId: "issue-1",
      rootIdentifier: "PLAN-100",
      teamId: "team-1",
      status: "approved",
      startedAt: new Date().toISOString(),
      turnCount: 5,
    }, p);

    const hookCtx = {
      api: {
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      } as any,
      linearApi: {
        getProject: vi.fn().mockResolvedValue({ id: "proj-1", name: "Test Project" }),
        getProjectIssues: vi.fn().mockResolvedValue([makeIssue("PROJ-1")]),
      } as any,
      notify: vi.fn().mockResolvedValue(undefined),
      pluginConfig: { planningStatePath: p },
      configPath: p,
    };

    await startProjectDispatch(hookCtx, "proj-1");

    const result = await readProjectDispatch("proj-1", p);
    expect(result!.rootIdentifier).toBe("PLAN-100");
  });
});

// ---------------------------------------------------------------------------
// onProjectIssueCompleted — additional branches
// ---------------------------------------------------------------------------

describe("onProjectIssueCompleted — additional branches", () => {
  it("does nothing when projectDispatch is null (non-existent project)", async () => {
    const p = tmpStatePath();
    const hookCtx = makeHookCtx(p);

    // Should not crash
    await onProjectIssueCompleted(hookCtx, "nonexistent", "PROJ-1");
    expect(hookCtx.notify).not.toHaveBeenCalled();
  });

  it("dispatches newly ready issues after completion", async () => {
    const p = tmpStatePath();
    const pd = makeProjectDispatch({
      issues: {
        "PROJ-1": makeIssueStatus("PROJ-1", { dispatchStatus: "dispatched", unblocks: ["PROJ-2"] }),
        "PROJ-2": makeIssueStatus("PROJ-2", { dependsOn: ["PROJ-1"] }),
      },
    });
    await writeProjectDispatch(pd, p);

    const hookCtx = makeHookCtx(p);
    await onProjectIssueCompleted(hookCtx, "proj-1", "PROJ-1");

    // PROJ-2 should now be dispatchable (its dep PROJ-1 is done)
    const result = await readProjectDispatch("proj-1", p);
    expect(result!.issues["PROJ-1"].dispatchStatus).toBe("done");
    // Progress notification should be sent
    expect(hookCtx.notify).toHaveBeenCalledWith("project_progress", expect.objectContaining({
      status: expect.stringContaining("1/2"),
    }));
  });

  it("counts only non-skipped issues in progress totals", async () => {
    const p = tmpStatePath();
    const pd = makeProjectDispatch({
      issues: {
        "PROJ-1": makeIssueStatus("PROJ-1", { dispatchStatus: "dispatched" }),
        "PROJ-2": makeIssueStatus("PROJ-2", { dispatchStatus: "skipped" }),
      },
    });
    await writeProjectDispatch(pd, p);

    const hookCtx = makeHookCtx(p);
    await onProjectIssueCompleted(hookCtx, "proj-1", "PROJ-1");

    // Should count 1/1 (PROJ-2 is skipped)
    const result = await readProjectDispatch("proj-1", p);
    expect(result!.status).toBe("completed");
    expect(hookCtx.notify).toHaveBeenCalledWith("project_complete", expect.objectContaining({
      status: expect.stringContaining("1/1"),
    }));
  });
});

// ---------------------------------------------------------------------------
// writeProjectDispatch — additional branches
// ---------------------------------------------------------------------------

describe("writeProjectDispatch — additional branches", () => {
  it("initializes projectDispatches when not present in state", async () => {
    const p = tmpStatePath();
    // Write some base planning state first (no projectDispatches key)
    const { writePlanningState } = await import("./planning-state.js");
    await writePlanningState({ sessions: {}, processedEvents: [] }, p);

    const pd = makeProjectDispatch();
    await writeProjectDispatch(pd, p);

    const result = await readProjectDispatch("proj-1", p);
    expect(result).not.toBeNull();
    expect(result!.projectId).toBe("proj-1");
  });
});
