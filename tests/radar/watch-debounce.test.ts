import { describe, expect, test } from 'bun:test';
import { createDebouncer } from '../../src/radar/watch-debounce.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('createDebouncer', () => {
  test('a single trigger fires once after the delay', async () => {
    let calls = 0;
    const debouncer = createDebouncer(() => { calls += 1; }, 20);
    debouncer.trigger();
    await sleep(10);
    expect(calls).toBe(0); // not yet — still inside the debounce window
    await sleep(20);
    expect(calls).toBe(1);
  });

  test('rapid triggers inside the window collapse to one call', async () => {
    let calls = 0;
    const debouncer = createDebouncer(() => { calls += 1; }, 20);
    debouncer.trigger();
    await sleep(5);
    debouncer.trigger();
    await sleep(5);
    debouncer.trigger();
    await sleep(30);
    expect(calls).toBe(1);
  });

  test('stop() cancels a pending call', async () => {
    let calls = 0;
    const debouncer = createDebouncer(() => { calls += 1; }, 20);
    debouncer.trigger();
    debouncer.stop();
    await sleep(30);
    expect(calls).toBe(0);
  });

  test('triggers after the window fire again independently', async () => {
    let calls = 0;
    const debouncer = createDebouncer(() => { calls += 1; }, 15);
    debouncer.trigger();
    await sleep(25);
    expect(calls).toBe(1);
    debouncer.trigger();
    await sleep(25);
    expect(calls).toBe(2);
  });
});
