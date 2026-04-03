import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter } from "./rate-limiter.js";

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("RateLimiter", () => {
  it("sends items in FIFO order", async () => {
    const calls: [string, string][] = [];
    const rl = new RateLimiter<string>(
      (id, data) => { calls.push([id, data]); return Promise.resolve(); },
      { minIntervalMs: 10 },
    );
    rl.add("A", "a1");
    rl.add("B", "b1");
    rl.add("C", "c1");
    await delay(100);
    assert.deepEqual(calls, [["A", "a1"], ["B", "b1"], ["C", "c1"]]);
  });

  it("dedupes same stream: updates data but keeps position", async () => {
    const calls: [string, string][] = [];
    const rl = new RateLimiter<string>(
      (id, data) => { calls.push([id, data]); return Promise.resolve(); },
      { minIntervalMs: 10 },
    );
    rl.add("A", "a1");
    rl.add("B", "b1");
    rl.add("A", "a2"); // update A's data, keep its position before B
    await delay(100);
    assert.deepEqual(calls, [["A", "a2"], ["B", "b1"]]);
    assert.equal(rl.pendingCount, 0);
  });

  it("retries on failure, stays at front of queue", async () => {
    const calls: [string, string][] = [];
    let failCount = 0;
    const rl = new RateLimiter<string>(
      (id, data) => {
        calls.push([id, data]);
        if (failCount++ < 2) return Promise.reject(new Error("fail"));
        return Promise.resolve();
      },
      { minIntervalMs: 20 },
    );
    rl.add("A", "a1");
    rl.add("B", "b1");
    await delay(200);
    assert.deepEqual(calls, [
      ["A", "a1"], // fail
      ["A", "a1"], // fail
      ["A", "a1"], // success
      ["B", "b1"], // now B
    ]);
    assert.equal(rl.pendingCount, 0);
  });

  it("data updated during retry is used on next attempt", async () => {
    const calls: [string, string][] = [];
    let failCount = 0;
    let resolveAdd: () => void;
    const addReady = new Promise<void>((r) => { resolveAdd = r; });
    const rl = new RateLimiter<string>(
      (id, data) => {
        calls.push([id, data]);
        if (failCount++ < 1) {
          resolveAdd(); // signal test to add updated data now
          return Promise.reject(new Error("fail"));
        }
        return Promise.resolve();
      },
      { minIntervalMs: 100 },
    );
    rl.add("A", "a1");
    await addReady; // wait for first attempt to fail
    rl.add("A", "a2"); // update data during backoff
    await delay(200);
    assert.ok(calls.length >= 2);
    assert.equal(calls[0][1], "a1"); // first attempt used a1
    assert.equal(calls[1][1], "a2"); // retry used updated data
    assert.equal(rl.pendingCount, 0);
  });

  it("head-of-line blocking: B waits while A fails", async () => {
    const calls: string[] = [];
    let failA = true;
    const rl = new RateLimiter<string>(
      (id) => {
        calls.push(id);
        if (id === "A" && failA) return Promise.reject(new Error("A fail"));
        return Promise.resolve();
      },
      { minIntervalMs: 10 },
    );
    rl.add("A", "a");
    rl.add("B", "b");
    await delay(60);
    assert.deepEqual(calls, ["A", "A", "A", "A", "A", "A"]); // A retried, B never sent
    failA = false;
    await delay(30);
    assert.ok(calls.includes("B"), "B should eventually be sent after A succeeds");
  });

  it("forceFlush stops on first failure", async () => {
    let failB = true;
    const rl = new RateLimiter<string>(
      (id) => {
        if (id === "B" && failB) return Promise.reject(new Error("B fail"));
        return Promise.resolve();
      },
      { minIntervalMs: 10000 },
    );
    rl.add("A", "a");
    rl.add("B", "b");
    rl.add("C", "c");
    await rl.forceFlush();
    assert.equal(rl.pendingCount, 2); // B and C still pending
  });

  it("clear empties queue and cancels timer", async () => {
    const calls: string[] = [];
    const rl = new RateLimiter<string>(
      (id) => { calls.push(id); return Promise.resolve(); },
      { minIntervalMs: 1000 },
    );
    rl.add("A", "a");
    rl.add("B", "b");
    rl.clear();
    await delay(50);
    assert.deepEqual(calls, []);
    assert.equal(rl.pendingCount, 0);
  });

  it("add after clear works normally", async () => {
    const calls: string[] = [];
    const rl = new RateLimiter<string>(
      (id) => { calls.push(id); return Promise.resolve(); },
      { minIntervalMs: 10 },
    );
    rl.add("A", "a");
    rl.clear();
    rl.add("B", "b");
    await delay(50);
    assert.deepEqual(calls, ["B"]);
  });

  it("dedup: new stream added during retry preserves queue position", async () => {
    const calls: string[] = [];
    let failA = true;
    const rl = new RateLimiter<string>(
      (id) => {
        calls.push(id);
        if (id === "A" && failA) return Promise.reject(new Error("fail"));
        return Promise.resolve();
      },
      { minIntervalMs: 20 },
    );
    rl.add("A", "a");
    await delay(30); // A fails at least once
    rl.add("C", "c"); // C added behind A (which is retrying)
    failA = false;
    await delay(200);
    assert.ok(calls.includes("A"), "A should be sent");
    assert.ok(calls.includes("C"), "C should be sent after A succeeds");
    // C must appear after the last A (no C before A succeeds)
    const lastA = calls.lastIndexOf("A");
    const firstC = calls.indexOf("C");
    assert.ok(firstC > lastA, "C should come after A succeeds");
    assert.equal(rl.pendingCount, 0);
  });

  it("multiple interleaved adds dedup correctly", async () => {
    const calls: [string, string][] = [];
    const rl = new RateLimiter<string>(
      (id, data) => { calls.push([id, data]); return Promise.resolve(); },
      { minIntervalMs: 10 },
    );
    rl.add("A", "1");
    rl.add("B", "1");
    rl.add("A", "2");
    rl.add("C", "1");
    rl.add("B", "2");
    await delay(100);
    // First flush dedupes A("1","2")→A("2"), then B("1","2")→B("2"), then C("1")
    assert.deepEqual(calls, [["A", "2"], ["B", "2"], ["C", "1"]]);
  });

  it("dedup keeps latest data for multiple duplicates of same stream", async () => {
    const calls: [string, string][] = [];
    const rl = new RateLimiter<string>(
      (id, data) => { calls.push([id, data]); return Promise.resolve(); },
      { minIntervalMs: 10 },
    );
    rl.add("X", "a");
    rl.add("X", "b");
    rl.add("X", "c");
    rl.add("X", "d");
    await delay(50);
    // Must use "d" (latest), not "b" (would happen with reverse iteration)
    assert.deepEqual(calls, [["X", "d"]]);
    assert.equal(rl.pendingCount, 0);
  });

  it("minIntervalMs is respected between flushes", async () => {
    const timestamps: number[] = [];
    const rl = new RateLimiter<string>(
      () => { timestamps.push(Date.now()); return Promise.resolve(); },
      { minIntervalMs: 50 },
    );
    rl.add("A", "a");
    rl.add("B", "b");
    rl.add("C", "c");
    await delay(200);
    for (let i = 1; i < timestamps.length; i++) {
      const gap = timestamps[i] - timestamps[i - 1];
      assert.ok(gap >= 45, `gap ${gap}ms between flush ${i - 1} and ${i} is less than minIntervalMs`);
    }
  });
});
