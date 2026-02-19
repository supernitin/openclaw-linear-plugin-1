import { describe, it, expect, afterEach } from "vitest";
import { acquireLock, releaseLock } from "./file-lock.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const tmpDir = os.tmpdir();
const testState = path.join(tmpDir, `file-lock-test-${process.pid}.json`);
const lockFile = testState + ".lock";

afterEach(async () => {
  try { await fs.unlink(lockFile); } catch {}
  try { await fs.unlink(testState); } catch {}
});

describe("acquireLock / releaseLock", () => {
  it("creates and removes a lock file", async () => {
    await acquireLock(testState);
    const stat = await fs.stat(lockFile);
    expect(stat.isFile()).toBe(true);

    await releaseLock(testState);
    await expect(fs.stat(lockFile)).rejects.toThrow();
  });

  it("blocks concurrent acquires until released", async () => {
    await acquireLock(testState);

    let secondAcquired = false;
    const secondLock = acquireLock(testState).then(() => {
      secondAcquired = true;
    });

    // Give the second acquire a moment to spin
    await new Promise((r) => setTimeout(r, 120));
    expect(secondAcquired).toBe(false);

    await releaseLock(testState);
    await secondLock;
    expect(secondAcquired).toBe(true);

    await releaseLock(testState);
  });

  it("releaseLock is safe to call when no lock exists", async () => {
    await expect(releaseLock(testState)).resolves.toBeUndefined();
  });

  it("recovers from stale lock", async () => {
    // Write a lock file with an old timestamp (> 30s ago)
    await fs.writeFile(lockFile, String(Date.now() - 60_000), { flag: "w" });

    // Should succeed by detecting stale lock
    await acquireLock(testState);
    const content = await fs.readFile(lockFile, "utf-8");
    const lockTime = Number(content);
    expect(Date.now() - lockTime).toBeLessThan(5000);

    await releaseLock(testState);
  });
});
