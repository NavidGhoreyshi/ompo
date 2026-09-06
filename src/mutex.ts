/**
 * FIFO async mutex — serializes the commit phase (verify + merge) across
 * parallel slice pipelines. In-process only; cross-process exclusion is the
 * run lock's job (store.ts acquireLock, one orchestrator per run).
 */

export interface Mutex {
  /** Resolves with a release fn when the lock is held. */
  acquire(): Promise<() => void>;
}

export function createMutex(): Mutex {
  let tail: Promise<void> = Promise.resolve();
  return {
    acquire(): Promise<() => void> {
      let release!: () => void;
      const prev = tail;
      tail = new Promise<void>((res) => {
        release = res;
      });
      return prev.then(() => release);
    },
  };
}
