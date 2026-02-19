/**
 * planning-state.ts — File-backed persistent planning session state.
 *
 * Tracks active planning sessions across gateway restarts.
 * Uses file-level locking to prevent concurrent read-modify-write races.
 * Mirrors the dispatch-state.ts pattern.
 */
import fs from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PlanningStatus = "interviewing" | "plan_review" | "approved" | "abandoned";

export interface PlanningSession {
  projectId: string;
  projectName: string;
  rootIssueId: string;
  rootIdentifier: string;
  teamId: string;
  agentSessionId?: string;
  status: PlanningStatus;
  startedAt: string;
  turnCount: number;
  planningLabelId?: string;
}

export interface PlanningState {
  sessions: Record<string, PlanningSession>; // keyed by projectId
  processedEvents: string[];
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_STATE_PATH = path.join(homedir(), ".openclaw", "linear-planning-state.json");
const MAX_PROCESSED_EVENTS = 200;

function resolveStatePath(configPath?: string): string {
  if (!configPath) return DEFAULT_STATE_PATH;
  if (configPath.startsWith("~/")) return configPath.replace("~", homedir());
  return configPath;
}

// ---------------------------------------------------------------------------
// File locking (shared utility)
// ---------------------------------------------------------------------------

import { acquireLock, releaseLock } from "../infra/file-lock.js";

// ---------------------------------------------------------------------------
// Read / Write
// ---------------------------------------------------------------------------

function emptyState(): PlanningState {
  return { sessions: {}, processedEvents: [] };
}

export async function readPlanningState(configPath?: string): Promise<PlanningState> {
  const filePath = resolveStatePath(configPath);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as PlanningState;
    if (!parsed.sessions) parsed.sessions = {};
    if (!parsed.processedEvents) parsed.processedEvents = [];
    return parsed;
  } catch (err: any) {
    if (err.code === "ENOENT") return emptyState();
    throw err;
  }
}

export async function writePlanningState(data: PlanningState, configPath?: string): Promise<void> {
  const filePath = resolveStatePath(configPath);
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (data.processedEvents.length > MAX_PROCESSED_EVENTS) {
    data.processedEvents = data.processedEvents.slice(-MAX_PROCESSED_EVENTS);
  }
  const tmpPath = filePath + ".tmp";
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  await fs.rename(tmpPath, filePath);
}

// ---------------------------------------------------------------------------
// Session operations
// ---------------------------------------------------------------------------

export async function registerPlanningSession(
  projectId: string,
  session: PlanningSession,
  configPath?: string,
): Promise<void> {
  const filePath = resolveStatePath(configPath);
  await acquireLock(filePath);
  try {
    const data = await readPlanningState(configPath);
    data.sessions[projectId] = session;
    await writePlanningState(data, configPath);
  } finally {
    await releaseLock(filePath);
  }
}

export async function updatePlanningSession(
  projectId: string,
  updates: Partial<PlanningSession>,
  configPath?: string,
): Promise<PlanningSession> {
  const filePath = resolveStatePath(configPath);
  await acquireLock(filePath);
  try {
    const data = await readPlanningState(configPath);
    const session = data.sessions[projectId];
    if (!session) throw new Error(`No planning session for project ${projectId}`);
    Object.assign(session, updates);
    await writePlanningState(data, configPath);
    return session;
  } finally {
    await releaseLock(filePath);
  }
}

export function getPlanningSession(
  state: PlanningState,
  projectId: string,
): PlanningSession | null {
  return state.sessions[projectId] ?? null;
}

export async function endPlanningSession(
  projectId: string,
  status: "approved" | "abandoned",
  configPath?: string,
): Promise<void> {
  const filePath = resolveStatePath(configPath);
  await acquireLock(filePath);
  try {
    const data = await readPlanningState(configPath);
    const session = data.sessions[projectId];
    if (session) {
      session.status = status;
      await writePlanningState(data, configPath);
    }
    clearPlanningCache(projectId);
  } finally {
    await releaseLock(filePath);
  }
}

export function isInPlanningMode(state: PlanningState, projectId: string): boolean {
  const session = state.sessions[projectId];
  if (!session) return false;
  return session.status === "interviewing" || session.status === "plan_review";
}

// ---------------------------------------------------------------------------
// In-memory cache for fast webhook routing
// ---------------------------------------------------------------------------

const planningCache = new Map<string, PlanningSession>();

export function setPlanningCache(session: PlanningSession): void {
  planningCache.set(session.projectId, session);
}

export function clearPlanningCache(projectId: string): void {
  planningCache.delete(projectId);
}

export function getActivePlanningByProjectId(projectId: string): PlanningSession | null {
  return planningCache.get(projectId) ?? null;
}
