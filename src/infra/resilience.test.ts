import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createRetryPolicy,
  createCircuitBreaker,
  withResilience,
  resetDefaultPolicy,
} from "./resilience.js";
import { BrokenCircuitError } from "cockatiel";

beforeEach(() => {
  resetDefaultPolicy();
});

describe("createRetryPolicy", () => {
  it("retries on transient failure then succeeds", async () => {
    let calls = 0;
    const policy = createRetryPolicy({ attempts: 3, initialDelay: 10, maxDelay: 20 });
    const result = await policy.execute(async () => {
      calls++;
      if (calls < 3) throw new Error("transient");
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("throws after exhausting retries", async () => {
    const policy = createRetryPolicy({ attempts: 2, initialDelay: 10, maxDelay: 20 });
    await expect(
      policy.execute(async () => {
        throw new Error("permanent");
      }),
    ).rejects.toThrow("permanent");
  });
});

describe("createCircuitBreaker", () => {
  it("opens after consecutive failures", async () => {
    const breaker = createCircuitBreaker({ threshold: 3, halfOpenAfter: 60_000 });

    // Fail 3 times to trip the breaker
    for (let i = 0; i < 3; i++) {
      try {
        await breaker.execute(async () => {
          throw new Error("fail");
        });
      } catch {}
    }

    // Next call should fail fast with BrokenCircuitError
    await expect(
      breaker.execute(async () => "should not run"),
    ).rejects.toThrow(BrokenCircuitError);
  });

  it("allows calls when under threshold", async () => {
    const breaker = createCircuitBreaker({ threshold: 5, halfOpenAfter: 60_000 });

    // Fail twice then succeed — should not trip
    let calls = 0;
    for (let i = 0; i < 2; i++) {
      try {
        await breaker.execute(async () => {
          throw new Error("fail");
        });
      } catch {}
    }

    const result = await breaker.execute(async () => {
      calls++;
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });
});

describe("withResilience", () => {
  it("returns result on success", async () => {
    const result = await withResilience(async () => 42);
    expect(result).toBe(42);
  });

  it("retries transient failures", async () => {
    let calls = 0;
    const result = await withResilience(async () => {
      calls++;
      if (calls < 2) throw new Error("transient");
      return "recovered";
    });
    expect(result).toBe("recovered");
    expect(calls).toBe(2);
  });
});
