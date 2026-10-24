export class RuntimeScopeLeaseCancelledError extends Error {
  constructor() {
    super("Runtime scope lease acquisition was cancelled.");
    this.name = "RuntimeScopeLeaseCancelledError";
  }
}

type Waiter = {
  key: string;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

/** Serializes different mutable runtime scopes while allowing concurrent requests in the same scope. */
export function createRuntimeScopeLeaseManager() {
  let activeKey: string | null = null;
  let activeCount = 0;
  const waiters: Waiter[] = [];

  function detach(waiter: Waiter): void {
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
  }

  function acquire(key: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new RuntimeScopeLeaseCancelledError());
    const hasDifferentScopeQueued = waiters.some((waiter) => waiter.key !== key);
    if (activeKey === null && waiters.length === 0) {
      activeKey = key;
      activeCount = 1;
      return Promise.resolve(createRelease(key));
    }
    if (activeKey === key && !hasDifferentScopeQueued) {
      activeCount += 1;
      return Promise.resolve(createRelease(key));
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { key, resolve, reject, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          detach(waiter);
          reject(new RuntimeScopeLeaseCancelledError());
          grantNext();
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      waiters.push(waiter);
      if (signal?.aborted) waiter.onAbort?.();
    });
  }

  function createRelease(key: string): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (activeKey !== key) return;
      activeCount = Math.max(0, activeCount - 1);
      if (activeCount === 0) {
        activeKey = null;
        grantNext();
      }
    };
  }

  function grantNext(): void {
    while (activeKey === null && waiters.length) {
      const first = waiters.shift()!;
      detach(first);
      if (first.signal?.aborted) {
        first.reject(new RuntimeScopeLeaseCancelledError());
        continue;
      }
      activeKey = first.key;
      activeCount = 1;
      first.resolve(createRelease(first.key));
      while (waiters[0]?.key === activeKey) {
        const sameScope = waiters.shift()!;
        detach(sameScope);
        if (sameScope.signal?.aborted) {
          sameScope.reject(new RuntimeScopeLeaseCancelledError());
          continue;
        }
        activeCount += 1;
        sameScope.resolve(createRelease(sameScope.key));
      }
    }
  }

  return { acquire };
}
