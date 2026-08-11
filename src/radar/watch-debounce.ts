export interface Debouncer {
  trigger(): void;
  stop(): void;
}

/** Collapses a burst of `trigger()` calls into one `onFire()`, `delayMs` after the last one. */
export function createDebouncer(onFire: () => void, delayMs: number): Debouncer {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    trigger(): void {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        onFire();
      }, delayMs);
    },
    stop(): void {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
