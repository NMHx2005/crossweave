import { describe, it, expect } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { CursorPrintAdapter } from '../../src/adapters/cursor-print.js';
import { CrossweaveError } from '../../src/core/errors.js';

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
    proc.write('hello\n');
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
    proc.write('hello\n');
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
    proc.write('RAWLINE\n');
    await waitFor(() => read().includes('not json at all'));
    proc.kill();
  });

  // Real-binary spike (2026-08-19, `cursor-agent` --print, this dev environment's
  // own command-execution sandbox disabled — not a `cursor-agent` flag):
  // writing to stdin and leaving it open produced NO output at all for 8+
  // seconds, while the identical write followed by `stdin.end()` produced the
  // full transcript within ~200ms. `--print` mode is EOF-gated. The fake agent
  // mirrors this exactly (responds on stdin 'end', not 'data'), so this test
  // proves `write()` actually closes stdin: if it didn't, the fake would hang
  // forever and `waitFor` would time out, just like the real binary. `\n`
  // finalizes the prompt (see the buffering tests below for the `write()`
  // contract itself).
  it('closes stdin after write, so the EOF-gated fake agent responds at all', async () => {
    const adapter = new CursorPrintAdapter(process.execPath, [FAKE_AGENT]);
    const proc = adapter.spawn({ cwd: process.cwd(), env: {}, cols: 80, rows: 24 });
    const read = collect(proc);
    proc.write('eof-check\n');
    await waitFor(() => read().includes('eof-check'));
    proc.kill();
  });

  it('throws a CrossweaveError on a second write() instead of writing to an already-closed stdin', async () => {
    const adapter = new CursorPrintAdapter(process.execPath, [FAKE_AGENT]);
    const proc = adapter.spawn({ cwd: process.cwd(), env: {}, cols: 80, rows: 24 });
    const read = collect(proc);
    proc.write('first\n');
    await waitFor(() => read().includes('first'));
    expect(() => proc.write('second')).toThrow(/single-prompt-per-process/);
    try {
      proc.write('second');
      throw new Error('expected write() to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CrossweaveError);
      expect((err as CrossweaveError).code).toBe('AGENT_INPUT_CLOSED');
    }
    proc.kill();
  });

  // Fix 1 (M9 fix-wave): `cw session attach` ships every keystroke as its own
  // write() call — see attach.ts's `onInput` and cursor-print.ts's `write()`
  // doc comment. These tests prove write() buffers fragments internally and
  // never touches the child until a line terminator arrives.
  it('multiple write() calls with no line terminator only accumulate — the child never sees them', async () => {
    const adapter = new CursorPrintAdapter(process.execPath, [FAKE_AGENT]);
    const proc = adapter.spawn({ cwd: process.cwd(), env: {}, cols: 80, rows: 24 });
    const read = collect(proc);
    // Only the leading system/init line should ever show up — no assistant
    // reply, because stdin is never closed while these fragments lack a
    // terminator.
    await waitFor(() => read().includes('[cursor: system]'));
    proc.write('h');
    proc.write('e');
    proc.write('l');
    proc.write('l');
    proc.write('o');
    await new Promise((r) => setTimeout(r, 150));
    expect(read()).not.toContain('hello');
    proc.kill();
  });

  it('a write() whose data ends in \\r finalizes the prompt with the full accumulated text', async () => {
    const adapter = new CursorPrintAdapter(process.execPath, [FAKE_AGENT]);
    const proc = adapter.spawn({ cwd: process.cwd(), env: {}, cols: 80, rows: 24 });
    const read = collect(proc);
    proc.write('h');
    proc.write('i');
    proc.write('\r');
    await waitFor(() => read().includes('hi'));
    // A second write() now throws — stdin was closed, proving finalize() ran.
    expect(() => proc.write('x')).toThrow(/single-prompt-per-process/);
    proc.kill();
  });

  it('a write() whose data ends in \\n finalizes the prompt the same way', async () => {
    const adapter = new CursorPrintAdapter(process.execPath, [FAKE_AGENT]);
    const proc = adapter.spawn({ cwd: process.cwd(), env: {}, cols: 80, rows: 24 });
    const read = collect(proc);
    proc.write('yo\n');
    await waitFor(() => read().includes('yo'));
    expect(() => proc.write('x')).toThrow(/single-prompt-per-process/);
    proc.kill();
  });

  // Fix 3 (M9 fix-wave): an error-shaped `result` line must render its actual
  // message, not collapse to the opaque `[cursor: result]` bracket.
  it('renders the actual error text from an error-shaped result line, not the generic bracket', async () => {
    const adapter = new CursorPrintAdapter(process.execPath, [FAKE_AGENT]);
    const proc = adapter.spawn({ cwd: process.cwd(), env: {}, cols: 80, rows: 24 });
    const read = collect(proc);
    proc.write('ERROR_RESULT\n');
    await waitFor(() => read().includes('rate limited'));
    expect(read()).toContain('cursor-agent failed: rate limited');
    expect(read()).not.toContain('[cursor: result]');
    proc.kill();
  });
});
