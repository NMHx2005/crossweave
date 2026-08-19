import { describe, it, expect } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { CursorPrintAdapter } from '../../src/adapters/cursor-print.js';

const FAKE_AGENT = fileURLToPath(new URL('../helpers/fake-stream-json-agent.ts', import.meta.url));

function collect(proc: { onData(cb: (c: string) => void): void }): () => string {
  let buf = '';
  proc.onData((c) => { buf += c; });
  return () => buf;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('CursorPrintAdapter', () => {
  it('reports kind cursor-print and enforcement tier T3', () => {
    const adapter = new CursorPrintAdapter(process.execPath, [FAKE_AGENT]);
    expect(adapter.kind).toBe('cursor-print');
    expect(adapter.enforcementTier).toBe('T3');
  });

  it('round-trips a prompt to a rendered text line via onData', async () => {
    const adapter = new CursorPrintAdapter(process.execPath, [FAKE_AGENT]);
    const proc = adapter.spawn({ cwd: process.cwd(), env: {}, cols: 80, rows: 24 });
    const read = collect(proc);
    proc.write('hello');
    await waitFor(() => read().includes('hello'));
    proc.kill();
  });

  it('default args trust the workspace, print mode, stream-json output', () => {
    expect(CursorPrintAdapter.DEFAULT_ARGS).toEqual([
      '--trust', '--print', '--output-format', 'stream-json', '--stream-partial-output',
    ]);
  });

  it('renders the leading system/init line as a bracketed cursor line', async () => {
    const adapter = new CursorPrintAdapter(process.execPath, [FAKE_AGENT]);
    const proc = adapter.spawn({ cwd: process.cwd(), env: {}, cols: 80, rows: 24 });
    const read = collect(proc);
    await waitFor(() => read().includes('[cursor: system]'));
    proc.kill();
  });

  it('does not duplicate text from the settled recap line (no timestamp_ms)', async () => {
    const adapter = new CursorPrintAdapter(process.execPath, [FAKE_AGENT]);
    const proc = adapter.spawn({ cwd: process.cwd(), env: {}, cols: 80, rows: 24 });
    const read = collect(proc);
    proc.write('hello');
    await waitFor(() => read().includes('hello'));
    // Give the recap line (written synchronously right after the delta) time to arrive.
    await new Promise((r) => setTimeout(r, 100));
    const occurrences = read().split('hello').length - 1;
    expect(occurrences).toBe(1);
    proc.kill();
  });

  it('passes through a non-JSON line raw', async () => {
    const adapter = new CursorPrintAdapter(process.execPath, [FAKE_AGENT]);
    const proc = adapter.spawn({ cwd: process.cwd(), env: {}, cols: 80, rows: 24 });
    const read = collect(proc);
    proc.write('RAWLINE');
    await waitFor(() => read().includes('not json at all'));
    proc.kill();
  });
});
