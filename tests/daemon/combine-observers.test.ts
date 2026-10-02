import { describe, expect, test } from 'bun:test';
import { combineObservers } from '../../src/daemon/runtime.js';
import type { RuntimeObserver } from '../../src/daemon/runtime.js';

function recording(): { observer: RuntimeObserver; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    observer: {
      started: (id, cols, rows) => calls.push(`started:${id}:${cols}:${rows}`),
      resized: (id, cols, rows) => calls.push(`resized:${id}:${cols}:${rows}`),
      output: (id, chunk) => calls.push(`output:${id}:${chunk}`),
      input: (id) => calls.push(`input:${id}`),
      exited: (id, code, requested) => calls.push(`exited:${id}:${code}:${requested}`),
    },
  };
}

describe('combineObservers', () => {
  test('fans every call out to all observers, in order', () => {
    const a = recording();
    const b = recording();
    const combined = combineObservers(a.observer, b.observer);

    combined.started('s_1', 80, 24);
    combined.output('s_1', 'hi');
    combined.input('s_1');
    combined.resized?.('s_1', 100, 30);
    combined.exited('s_1', 0, false);

    const expected = ['started:s_1:80:24', 'output:s_1:hi', 'input:s_1', 'resized:s_1:100:30', 'exited:s_1:0:false'];
    expect(a.calls).toEqual(expected);
    expect(b.calls).toEqual(expected);
  });

  test('an observer without resized is skipped for that call, not thrown on', () => {
    const a = recording();
    const withoutResize: RuntimeObserver = {
      started: () => undefined, output: () => undefined, input: () => undefined, exited: () => undefined,
    };
    const combined = combineObservers(a.observer, withoutResize);
    expect(() => combined.resized?.('s_1', 1, 1)).not.toThrow();
    expect(a.calls).toEqual(['resized:s_1:1:1']);
  });

  test('one observer throwing does not stop the others from being called', () => {
    const a = recording();
    const b = recording();
    const throwing: RuntimeObserver = {
      started: () => { throw new Error('boom'); },
      output: () => undefined, input: () => undefined, exited: () => undefined,
    };
    const combined = combineObservers(a.observer, throwing, b.observer);
    expect(() => combined.started?.('s_1')).not.toThrow();
    expect(a.calls).toEqual(['started:s_1:undefined:undefined']);
    expect(b.calls).toEqual(['started:s_1:undefined:undefined']);
  });
});
