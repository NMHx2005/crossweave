import { realpathSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { defineCommand } from 'citty';
import { withClient, fail, currentWorkspaceId } from '../context.js';
import { CrossweaveError } from '../../core/errors.js';
import { assertContained } from '../../core/paths.js';

interface BlameResult {
  sessionId: string;
  sessionName: string;
  commitHash: string;
}

export const blameCommand = defineCommand({
  meta: { name: 'blame', description: 'Show which session committed a line' },
  args: {
    target: { type: 'positional', description: '<file>:<line>', required: false },
  },
  async run({ args }) {
    try {
      if (args.target === undefined) {
        throw new CrossweaveError('INVALID_ARGUMENTS', 'Missing required argument: TARGET');
      }
      const separatorIndex = args.target.lastIndexOf(':');
      if (separatorIndex === -1) {
        throw new CrossweaveError('INVALID_ARGUMENTS', 'Expected <file>:<line>, e.g. src/auth.ts:42');
      }
      const file = args.target.slice(0, separatorIndex);
      const lineText = args.target.slice(separatorIndex + 1);
      const line = Number(lineText);
      if (!Number.isInteger(line) || line < 1) {
        throw new CrossweaveError('INVALID_ARGUMENTS', `Expected a positive line number, got: ${lineText}`);
      }

      await withClient(async (client, projectRoot) => {
        const workspaceId = await currentWorkspaceId(client);
        // The daemon runs `git blame` from the project root, so the path it is sent
        // must be repo-relative. Resolving the user's argument against THEIR cwd
        // first is what makes `cw blame foo.ts:1` work from a subdirectory instead
        // of silently reporting "no attribution found" for a path that was never
        // theirs; a target outside the repo fails with PATH_ESCAPE rather than
        // quietly finding nothing.
        const root = realpathSync(projectRoot);
        const repoRelative = relative(root, assertContained(root, resolve(process.cwd(), file)));
        const result = await client.call<BlameResult | null>('blame', {
          workspaceId, file: repoRelative, line,
        });
        if (result === null) {
          process.stdout.write(`no attribution found for ${file}:${line}\n`);
          return;
        }
        process.stdout.write(`${file}:${line} — ${result.sessionName} (commit ${result.commitHash.slice(0, 8)})\n`);
      });
    } catch (err) { fail(err); }
  },
});
