import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const CLI = fileURLToPath(new URL('../../src/cli/index.ts', import.meta.url));
let home: string;

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cw-update-cmd-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('cw update', () => {
  test('aborts with a clear error when checksum verification fails, installing nothing', async () => {
    // A fake server serving a script and a checksums.txt that does NOT match it —
    // this is the one behavior this task must prove without a real GitHub release:
    // a tampered/corrupted download is refused, never executed.
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname.endsWith('install.sh')) return new Response('#!/bin/sh\necho SHOULD_NOT_RUN\n');
        if (url.pathname.endsWith('checksums.txt')) return new Response('0000000000000000000000000000000000000000000000000000000000000000  install.sh\n');
        return new Response('not found', { status: 404 });
      },
    });
    try {
      const proc = Bun.spawn(
        [process.execPath, CLI, 'update'],
        {
          env: { ...process.env, HOME: home, CW_UPDATE_BASE_URL: `http://127.0.0.1:${server.port}/`, CW_INSTALL_VERSION: 'v0.0.0-test' },
          stdout: 'pipe', stderr: 'pipe',
        },
      );
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const code = await proc.exited;
      expect(code).not.toBe(0);
      expect(stdout + stderr).not.toContain('SHOULD_NOT_RUN');
      expect((stdout + stderr).toLowerCase()).toContain('checksum');
    } finally {
      server.stop(true);
    }
  });

  test('a checksum-verified install.sh is actually executed, with CW_INSTALL_VERSION reaching it', async () => {
    const script = '#!/bin/sh\necho "RAN with version=$CW_INSTALL_VERSION"\n';
    const hash = createHash('sha256').update(script).digest('hex');
    const checksums = `${hash}  install.sh\n`;
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname.endsWith('install.sh')) return new Response(script);
        if (url.pathname.endsWith('checksums.txt')) return new Response(checksums);
        return new Response('not found', { status: 404 });
      },
    });
    try {
      const proc = Bun.spawn(
        [process.execPath, CLI, 'update'],
        {
          env: { ...process.env, HOME: home, CW_UPDATE_BASE_URL: `http://127.0.0.1:${server.port}/`, CW_INSTALL_VERSION: 'v9.9.9' },
          stdout: 'pipe', stderr: 'pipe',
        },
      );
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const code = await proc.exited;
      expect(code).toBe(0);
      expect(stdout).toContain('RAN with version=v9.9.9');
    } finally {
      server.stop(true);
    }
  });
});
