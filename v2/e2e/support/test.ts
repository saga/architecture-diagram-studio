import { test as base, expect } from "@playwright/test";
import { removeTempDirs } from "./temp-dirs";

/**
 * Every spec drives the real app through a real workspace directory, so the suite
 * needs a guaranteed cleanup step. A worker-scoped auto fixture runs once per worker
 * and removes every scratch directory the tests created, even after failures.
 */
export const test = base.extend<Record<never, never>, { cleanupTempDirs: void }>({
  cleanupTempDirs: [
    async ({}, use) => {
      await use();
      await removeTempDirs();
    },
    { scope: "worker", auto: true }
  ]
});

export { expect };
