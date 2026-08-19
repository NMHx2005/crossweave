// Mirrors `cursor-agent --print --output-format stream-json --stream-partial-output`
// line shapes as observed for real in Task 3 Step 1 (cursor-agent 2026.08.11-e8db854,
// run 2026-08-19). The brief's placeholder shape was a flat `{type:'text', text}` —
// the real binary nests rendered text at `message.content[].text` under
// `type: 'assistant'`, always opens with a `system`/`init` line, and (per
// `--stream-partial-output`) sends each streamed word as its own `assistant` line
// carrying `timestamp_ms`, followed once the turn settles by ONE more `assistant`
// line repeating the full concatenated text WITHOUT `timestamp_ms`. See
// `src/adapters/cursor-print.ts`'s header comment for the full observed transcript.
//
// Also mirrors the real binary's EOF-gated behavior, captured during the M9
// Task 3 real-binary spike: `--print` produces NO output at all until stdin
// closes. This fake buffers everything written and only responds on `end`,
// not on `data` — so a `PrintProcess.write()` that failed to close stdin would
// make this fake hang forever too, exactly like the real binary does.
process.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake-session' })}\n`);

let buffered = '';
process.stdin.resume();
process.stdin.on('data', (chunk: Buffer) => {
  buffered += chunk.toString('utf8');
});
process.stdin.on('end', () => {
  // Trim the trailing `\r`/`\n` terminator (`write()`'s finalize condition,
  // cursor-print.ts) before matching test sentinels — the sentinel itself is
  // never part of what a real prompt would contain.
  const trimmed = buffered.replace(/[\r\n]+$/, '');
  if (trimmed === 'RAWLINE') {
    process.stdout.write('not json at all\n');
    process.exit(0);
  }
  if (trimmed === 'ERROR_RESULT') {
    // Error-shaped `result` line, per the real captured shape (cursor-print.ts's
    // header comment): is_error true, subtype not "success", message in `result`.
    process.stdout.write(`${JSON.stringify({
      type: 'result',
      subtype: 'error',
      is_error: true,
      result: 'cursor-agent failed: rate limited',
    })}\n`);
    process.exit(0);
  }
  const content = [{ type: 'text', text: buffered }];
  process.stdout.write(`${JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content },
    timestamp_ms: Date.now(),
  })}\n`);
  // Settled recap of the same turn, as observed for real — no timestamp_ms.
  process.stdout.write(`${JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content },
  })}\n`);
  process.exit(0);
});
