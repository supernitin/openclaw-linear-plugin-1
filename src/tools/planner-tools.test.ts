import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock openclaw/plugin-sdk
vi.mock("openclaw/plugin-sdk", () => ({
  jsonResult: (data: any) => ({ type: "json", data }),
}));

// Mock LinearAgentApi
vi.mock("../api/linear-api.js", () => ({
  LinearAgentApi: vi.fn(),
}));

import {
  createPlannerTools,
  setActivePlannerContext,
  clearActivePlannerContext,
  detectCycles,
  auditPlan,
  buildPlanSnapshot,
} from "./planner-tools.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ProjectIssue = Parameters<typeof detectCycles>[0][number];

function makeIssue(overrides: Partial<ProjectIssue> & { identifier: string; title: string }): ProjectIssue {
  return {
    id: overrides.id ?? overrides.identifier.toLowerCase().replace("-", "_"),
    identifier: overrides.identifier,
    title: overrides.title,
    description: "description" in overrides ? overrides.description : "As a user, I want this feature so that I can be productive. Given I am logged in, When I click the button, Then the action completes.",
    estimate: "estimate" in overrides ? overrides.estimate : 3,
    priority: "priority" in overrides ? overrides.priority : 2,
    labels: overrides.labels ?? { nodes: [] },
    parent: overrides.parent ?? null,
    relations: overrides.relations ?? { nodes: [] },
  } as ProjectIssue;
}

function makeEpicIssue(overrides: Partial<ProjectIssue> & { identifier: string; title: string }): ProjectIssue {
  return makeIssue({
    ...overrides,
    labels: { nodes: [{ id: "lbl-epic", name: "Epic" }] } as any,
    estimate: overrides.estimate as any,
    priority: overrides.priority as any,
  });
}

// ---------------------------------------------------------------------------
// Mock Linear API
// ---------------------------------------------------------------------------

const mockLinearApi = {
  createIssue: vi.fn().mockResolvedValue({ id: "new-id", identifier: "PROJ-5" }),
  createIssueRelation: vi.fn().mockResolvedValue({ id: "rel-id" }),
  getProjectIssues: vi.fn().mockResolvedValue([]),
  getTeamLabels: vi.fn().mockResolvedValue([]),
  updateIssueExtended: vi.fn().mockResolvedValue(true),
};

// ---------------------------------------------------------------------------
// detectCycles (pure function — no mocks needed)
// ---------------------------------------------------------------------------

describe("detectCycles", () => {
  it("returns empty array for valid linear chain (A→B→C)", () => {
    const issues: ProjectIssue[] = [
      makeIssue({
        identifier: "PROJ-1",
        title: "A",
        relations: {
          nodes: [{ type: "blocks", relatedIssue: { identifier: "PROJ-2" } }],
        } as any,
      }),
      makeIssue({
        identifier: "PROJ-2",
        title: "B",
        relations: {
          nodes: [{ type: "blocks", relatedIssue: { identifier: "PROJ-3" } }],
        } as any,
      }),
      makeIssue({ identifier: "PROJ-3", title: "C" }),
    ];

    expect(detectCycles(issues)).toEqual([]);
  });

  it("detects simple 2-node cycle (A→B→A)", () => {
    const issues: ProjectIssue[] = [
      makeIssue({
        identifier: "PROJ-1",
        title: "A",
        relations: {
          nodes: [{ type: "blocks", relatedIssue: { identifier: "PROJ-2" } }],
        } as any,
      }),
      makeIssue({
        identifier: "PROJ-2",
        title: "B",
        relations: {
          nodes: [{ type: "blocks", relatedIssue: { identifier: "PROJ-1" } }],
        } as any,
      }),
    ];

    const cycleNodes = detectCycles(issues);
    expect(cycleNodes).toContain("PROJ-1");
    expect(cycleNodes).toContain("PROJ-2");
  });

  it("detects 3-node cycle (A→B→C→A)", () => {
    const issues: ProjectIssue[] = [
      makeIssue({
        identifier: "PROJ-1",
        title: "A",
        relations: {
          nodes: [{ type: "blocks", relatedIssue: { identifier: "PROJ-2" } }],
        } as any,
      }),
      makeIssue({
        identifier: "PROJ-2",
        title: "B",
        relations: {
          nodes: [{ type: "blocks", relatedIssue: { identifier: "PROJ-3" } }],
        } as any,
      }),
      makeIssue({
        identifier: "PROJ-3",
        title: "C",
        relations: {
          nodes: [{ type: "blocks", relatedIssue: { identifier: "PROJ-1" } }],
        } as any,
      }),
    ];

    const cycleNodes = detectCycles(issues);
    expect(cycleNodes).toHaveLength(3);
    expect(cycleNodes).toContain("PROJ-1");
    expect(cycleNodes).toContain("PROJ-2");
    expect(cycleNodes).toContain("PROJ-3");
  });

  it("passes valid diamond DAG (A→B, A→C, B→D, C→D)", () => {
    const issues: ProjectIssue[] = [
      makeIssue({
        identifier: "PROJ-1",
        title: "A",
        relations: {
          nodes: [
            { type: "blocks", relatedIssue: { identifier: "PROJ-2" } },
            { type: "blocks", relatedIssue: { identifier: "PROJ-3" } },
          ],
        } as any,
      }),
      makeIssue({
        identifier: "PROJ-2",
        title: "B",
        relations: {
          nodes: [{ type: "blocks", relatedIssue: { identifier: "PROJ-4" } }],
        } as any,
      }),
      makeIssue({
        identifier: "PROJ-3",
        title: "C",
        relations: {
          nodes: [{ type: "blocks", relatedIssue: { identifier: "PROJ-4" } }],
        } as any,
      }),
      makeIssue({ identifier: "PROJ-4", title: "D" }),
    ];

    expect(detectCycles(issues)).toEqual([]);
  });

  it("returns empty for issues with no relations", () => {
    const issues: ProjectIssue[] = [
      makeIssue({ identifier: "PROJ-1", title: "A" }),
      makeIssue({ identifier: "PROJ-2", title: "B" }),
      makeIssue({ identifier: "PROJ-3", title: "C" }),
    ];

    expect(detectCycles(issues)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// auditPlan (pure function)
// ---------------------------------------------------------------------------

describe("auditPlan", () => {
  it("passes valid plan with descriptions, estimates, priorities", () => {
    const issues: ProjectIssue[] = [
      makeIssue({
        identifier: "PROJ-1",
        title: "Task A",
        relations: {
          nodes: [{ type: "blocks", relatedIssue: { identifier: "PROJ-2" } }],
        } as any,
      }),
      makeIssue({ identifier: "PROJ-2", title: "Task B", parent: { identifier: "PROJ-1" } as any }),
    ];

    const result = auditPlan(issues);
    expect(result.pass).toBe(true);
    expect(result.problems).toHaveLength(0);
  });

  it("fails: issue missing description", () => {
    const issues: ProjectIssue[] = [
      makeIssue({
        identifier: "PROJ-1",
        title: "No desc",
        description: "" as any,
      }),
    ];

    const result = auditPlan(issues);
    expect(result.pass).toBe(false);
    expect(result.problems.some((p) => p.includes("PROJ-1") && p.includes("description"))).toBe(true);
  });

  it("fails: description too short (<50 chars)", () => {
    const issues: ProjectIssue[] = [
      makeIssue({
        identifier: "PROJ-1",
        title: "Short desc",
        description: "Too short",
      }),
    ];

    const result = auditPlan(issues);
    expect(result.pass).toBe(false);
    expect(result.problems.some((p) => p.includes("PROJ-1") && p.includes("description"))).toBe(true);
  });

  it("fails: non-epic missing estimate", () => {
    const issues: ProjectIssue[] = [
      makeIssue({
        identifier: "PROJ-1",
        title: "No estimate",
        estimate: null as any,
      }),
    ];

    const result = auditPlan(issues);
    expect(result.pass).toBe(false);
    expect(result.problems.some((p) => p.includes("PROJ-1") && p.includes("estimate"))).toBe(true);
  });

  it("fails: non-epic missing priority (priority=0)", () => {
    const issues: ProjectIssue[] = [
      makeIssue({
        identifier: "PROJ-1",
        title: "No priority",
        priority: 0,
      }),
    ];

    const result = auditPlan(issues);
    expect(result.pass).toBe(false);
    expect(result.problems.some((p) => p.includes("PROJ-1") && p.includes("priority"))).toBe(true);
  });

  it("fails: cycle detected", () => {
    const issues: ProjectIssue[] = [
      makeIssue({
        identifier: "PROJ-1",
        title: "A",
        relations: {
          nodes: [{ type: "blocks", relatedIssue: { identifier: "PROJ-2" } }],
        } as any,
      }),
      makeIssue({
        identifier: "PROJ-2",
        title: "B",
        relations: {
          nodes: [{ type: "blocks", relatedIssue: { identifier: "PROJ-1" } }],
        } as any,
      }),
    ];

    const result = auditPlan(issues);
    expect(result.pass).toBe(false);
    expect(result.problems.some((p) => p.includes("cycle") || p.includes("Cycle"))).toBe(true);
  });

  it("warns: orphan issue (no parent or relations)", () => {
    const issues: ProjectIssue[] = [
      makeIssue({ identifier: "PROJ-1", title: "Lonely issue" }),
    ];

    const result = auditPlan(issues);
    expect(result.warnings.some((w) => w.includes("PROJ-1") && w.includes("orphan"))).toBe(true);
  });

  it("skips estimate/priority checks for epic issues", () => {
    const issues: ProjectIssue[] = [
      makeEpicIssue({
        identifier: "PROJ-1",
        title: "Epic without estimate/priority",
        estimate: null as any,
        priority: 0 as any,
      }),
    ];

    const result = auditPlan(issues);
    const estimateProblems = result.problems.filter((p) => p.includes("estimate") || p.includes("priority"));
    expect(estimateProblems).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildPlanSnapshot
// ---------------------------------------------------------------------------

describe("buildPlanSnapshot", () => {
  it("formats empty project", () => {
    const result = buildPlanSnapshot([]);
    expect(result).toBe("_No issues created yet._");
  });

  it("formats tree with epics + sub-issues + relations", () => {
    const epic = makeEpicIssue({
      identifier: "PROJ-1",
      title: "Auth Epic",
      estimate: null as any,
      priority: 2,
    });

    const child = makeIssue({
      identifier: "PROJ-2",
      title: "Login page",
      parent: { identifier: "PROJ-1" } as any,
      estimate: 3,
      priority: 3,
      relations: {
        nodes: [{ type: "blocks", relatedIssue: { identifier: "PROJ-3" } }],
      } as any,
    });

    const standalone = makeIssue({
      identifier: "PROJ-3",
      title: "Dashboard",
      estimate: 5,
      priority: 1,
    });

    const result = buildPlanSnapshot([epic, child, standalone]);

    // Should contain epic section
    expect(result).toContain("### Epics (1)");
    expect(result).toContain("PROJ-1");
    expect(result).toContain("Auth Epic");

    // Child should appear indented under epic
    expect(result).toContain("PROJ-2");
    expect(result).toContain("Login page");

    // Standalone section
    expect(result).toContain("### Standalone issues (1)");
    expect(result).toContain("PROJ-3");
    expect(result).toContain("Dashboard");

    // Relations formatting
    expect(result).toContain("blocks PROJ-3");

    // Priority labels
    expect(result).toContain("pri: Urgent");
    expect(result).toContain("pri: Medium");
  });
});

// ---------------------------------------------------------------------------
// Tool execution tests
// ---------------------------------------------------------------------------

describe("createPlannerTools", () => {
  const PROJECT_ID = "proj-123";
  const TEAM_ID = "team-456";

  let tools: ReturnType<typeof createPlannerTools>;

  beforeEach(() => {
    vi.clearAllMocks();
    setActivePlannerContext({
      linearApi: mockLinearApi as any,
      projectId: PROJECT_ID,
      teamId: TEAM_ID,
    });
    tools = createPlannerTools();
  });

  afterEach(() => {
    clearActivePlannerContext();
  });

  function findTool(name: string) {
    const tool = tools.find((t: any) => t.name === name) as any;
    if (!tool) throw new Error(`Tool '${name}' not found`);
    return tool;
  }

  // ---- plan_create_issue ----

  it("plan_create_issue: creates issue with teamId and projectId", async () => {
    const tool = findTool("plan_create_issue");

    const result = await tool.execute("call-1", {
      title: "New feature",
      description: "Implement the new feature with all necessary components",
    });

    expect(mockLinearApi.createIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: TEAM_ID,
        projectId: PROJECT_ID,
        title: "New feature",
        description: "Implement the new feature with all necessary components",
      }),
    );

    expect(result).toEqual({
      type: "json",
      data: {
        id: "new-id",
        identifier: "PROJ-5",
        title: "New feature",
        isEpic: false,
      },
    });
  });

  // ---- plan_link_issues ----

  it("plan_link_issues: creates blocks relation", async () => {
    mockLinearApi.getProjectIssues.mockResolvedValueOnce([
      makeIssue({ identifier: "PROJ-1", title: "A", id: "id-1" }),
      makeIssue({ identifier: "PROJ-2", title: "B", id: "id-2" }),
    ]);

    const tool = findTool("plan_link_issues");

    const result = await tool.execute("call-2", {
      fromIdentifier: "PROJ-1",
      toIdentifier: "PROJ-2",
      type: "blocks",
    });

    expect(mockLinearApi.createIssueRelation).toHaveBeenCalledWith({
      issueId: "id-1",
      relatedIssueId: "id-2",
      type: "blocks",
    });

    expect(result).toEqual({
      type: "json",
      data: {
        id: "rel-id",
        from: "PROJ-1",
        to: "PROJ-2",
        type: "blocks",
      },
    });
  });

  it("plan_link_issues: throws on unknown identifier", async () => {
    mockLinearApi.getProjectIssues.mockResolvedValueOnce([
      makeIssue({ identifier: "PROJ-1", title: "A", id: "id-1" }),
    ]);

    const tool = findTool("plan_link_issues");

    await expect(
      tool.execute("call-3", {
        fromIdentifier: "PROJ-1",
        toIdentifier: "PROJ-999",
        type: "blocks",
      }),
    ).rejects.toThrow("Unknown issue identifier: PROJ-999");
  });

  // ---- plan_get_project ----

  it("plan_get_project: returns formatted snapshot", async () => {
    mockLinearApi.getProjectIssues.mockResolvedValueOnce([
      makeIssue({ identifier: "PROJ-1", title: "Task A" }),
    ]);

    const tool = findTool("plan_get_project");
    const result = await tool.execute("call-4", {});

    expect(mockLinearApi.getProjectIssues).toHaveBeenCalledWith(PROJECT_ID);
    expect(result).toEqual({
      type: "json",
      data: {
        issueCount: 1,
        plan: expect.stringContaining("PROJ-1"),
      },
    });
  });

  // ---- plan_audit ----

  it("plan_audit: returns audit result", async () => {
    mockLinearApi.getProjectIssues.mockResolvedValueOnce([
      makeIssue({
        identifier: "PROJ-1",
        title: "Good issue",
        relations: {
          nodes: [{ type: "blocks", relatedIssue: { identifier: "PROJ-2" } }],
        } as any,
      }),
      makeIssue({
        identifier: "PROJ-2",
        title: "Another good issue",
        parent: { identifier: "PROJ-1" } as any,
      }),
    ]);

    const tool = findTool("plan_audit");
    const result = await tool.execute("call-5", {});

    expect(mockLinearApi.getProjectIssues).toHaveBeenCalledWith(PROJECT_ID);
    expect(result).toEqual({
      type: "json",
      data: {
        pass: true,
        problems: [],
        warnings: [],
      },
    });
  });
});
