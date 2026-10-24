import { describe, expect, it } from "vitest";
import { createRuntimeScopeLeaseManager, RuntimeScopeLeaseCancelledError } from "./runtime-scope-lease";

describe("runtime scope leases", () => {
  it("allows concurrent holders in one scope and waits to switch scopes until all release", async () => {
    const manager = createRuntimeScopeLeaseManager();
    const releaseOne = await manager.acquire("workspace:a");
    const releaseTwo = await manager.acquire("workspace:a");
    let otherAcquired = false;
    const otherScope = manager.acquire("single-file").then((release) => {
      otherAcquired = true;
      return release;
    });
    releaseOne();
    await Promise.resolve();
    expect(otherAcquired).toBe(false);
    releaseTwo();
    const releaseOther = await otherScope;
    expect(otherAcquired).toBe(true);
    releaseOther();
  });

  it("preserves FIFO across different scopes while grouping only adjacent requests of the same scope", async () => {
    const manager = createRuntimeScopeLeaseManager();
    const releaseA = await manager.acquire("a");
    const order: string[] = [];
    const b = manager.acquire("b").then((release) => { order.push("b"); return release; });
    const a2 = manager.acquire("a").then((release) => { order.push("a2"); return release; });
    releaseA();
    const releaseB = await b;
    expect(order).toEqual(["b"]);
    releaseB();
    const releaseA2 = await a2;
    expect(order).toEqual(["b", "a2"]);
    releaseA2();
  });

  it("removes cancelled waiters so they do not block later scopes", async () => {
    const manager = createRuntimeScopeLeaseManager();
    const releaseA = await manager.acquire("a");
    const controller = new AbortController();
    const cancelled = manager.acquire("b", controller.signal);
    const c = manager.acquire("c");
    controller.abort();
    await expect(cancelled).rejects.toBeInstanceOf(RuntimeScopeLeaseCancelledError);
    releaseA();
    const releaseC = await c;
    releaseC();
  });
});
