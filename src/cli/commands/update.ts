import { defineCommand } from 'citty';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGlobalConfig } from '../../update/global-config.js';
import { DEFAULT_REPO, resolveLatestTag } from '../../update/checker.js';
import { CrossweaveError } from '../../core/errors.js';
import { fail } from '../context.js';

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export const updateCommand = defineCommand({
  meta: { name: 'update', description: "Download and install the latest crossweave release" },
  async run() {
    try {
      if (process.env.CW_UPDATE_BASE_URL !== undefined) {
        process.stderr.write('crossweave: CW_UPDATE_BASE_URL override is set — downloading from a non-default location (dev/test only, not the real release host)\n');
      }
      const repo = DEFAULT_REPO;
      const cfg = loadGlobalConfig();
      let version = process.env.CW_INSTALL_VERSION ?? cfg.lastKnownLatest;
      if (version === null) {
        version = await resolveLatestTag() ?? null;
        if (version === null) {
          process.stdout.write('could not resolve the latest release — check your network connection, or set CW_INSTALL_VERSION\n');
          return;
        }
      }
      const base = process.env.CW_UPDATE_BASE_URL ?? `https://github.com/${repo}/releases/download/${version}/`;

      const tmp = mkdtempSync(join(tmpdir(), 'cw-update-'));
      try {
        const [scriptRes, checksumsRes] = await Promise.all([
          fetch(`${base}install.sh`),
          fetch(`${base}checksums.txt`),
        ]);
        if (!scriptRes.ok || !checksumsRes.ok) {
          throw new CrossweaveError('UPDATE_FETCH_FAILED', `could not download release ${version}`);
        }
        const scriptBuf = Buffer.from(await scriptRes.arrayBuffer());
        const checksums = await checksumsRes.text();
        const line = checksums.split('\n').find((l) => l.trim().endsWith('install.sh'));
        const expected = line?.split(/\s+/)[0];
        const actual = sha256(scriptBuf);
        if (expected === undefined || expected !== actual) {
          throw new CrossweaveError('UPDATE_CHECKSUM_MISMATCH', `install.sh checksum mismatch for ${version} — aborting, nothing changed`);
        }

        const scriptPath = join(tmp, 'install.sh');
        writeFileSync(scriptPath, scriptBuf);
        chmodSync(scriptPath, 0o755);

        const proc = Bun.spawn(['sh', scriptPath], {
          env: { ...process.env, CW_INSTALL_VERSION: version },
          stdout: 'inherit', stderr: 'inherit',
        });
        const code = await proc.exited;
        if (code !== 0) throw new CrossweaveError('UPDATE_INSTALL_FAILED', `install.sh exited with code ${code}`);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    } catch (err) { fail(err); }
  },
});
