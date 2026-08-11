import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { newId } from '../core/ids.js';
import { FileClaimRepo, type SymbolKind } from '../db/repositories/file-claim.js';
import { languageForPath, initGrammars } from './grammars.js';
import { extractSymbols } from './symbols.js';
import { normalizeAndHash } from './hash.js';

export interface IndexableSession {
  id: string;
  workspaceId: string;
  worktreePath: string;
  /** The commit this session's branch was created from — see WorktreeHandle.forkPoint. */
  forkPoint: string;
}

/** Files changed on disk (committed or not) relative to `forkPoint`, repo-relative paths. */
export async function diffChangedFiles(worktreePath: string, forkPoint: string): Promise<string[]> {
  const committed = execFileSync('git', ['diff', '--name-only', `${forkPoint}..HEAD`], {
    cwd: worktreePath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  const uncommitted = execFileSync('git', ['diff', '--name-only', 'HEAD'], {
    cwd: worktreePath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
    cwd: worktreePath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  const all = new Set(
    [committed, uncommitted, untracked]
      .flatMap((out) => out.split('\n'))
      .map((l) => l.trim())
      .filter(Boolean),
  );
  return [...all];
}

/** The file's content at `forkPoint`, or `undefined` if it did not exist there yet. */
function readAtForkPoint(worktreePath: string, forkPoint: string, path: string): string | undefined {
  try {
    return execFileSync('git', ['show', `${forkPoint}:${path}`], {
      cwd: worktreePath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined; // new file — not present at the fork point
  }
}

const CLAIM_KEY_SEPARATOR = String.fromCharCode(32); // a plain space

/** Composite key for the `stillDivergent` set — a space can't appear in a path or symbol name. */
function claimKey(path: string, symbol: string | null): string {
  return path + CLAIM_KEY_SEPARATOR + (symbol ?? '');
}

export class RadarIndexer {
  private readonly claims: FileClaimRepo;

  constructor(db: Database) {
    this.claims = new FileClaimRepo(db);
  }

  /**
   * Re-derives every `file_claim` row for `session` from its current diff
   * against `forkPoint`. Idempotent and safe to call repeatedly — each run
   * fully reconciles this session's claims (upsert what's still divergent,
   * delete what reverted to the fork-point content), never accumulates.
   */
  async reindexSession(session: IndexableSession): Promise<void> {
    await initGrammars();
    const changed = await diffChangedFiles(session.worktreePath, session.forkPoint);
    const now = new Date().toISOString();
    const stillDivergent = new Set<string>(); // claimKey(path, symbol) entries still valid after this run

    for (const path of changed) {
      let current: string;
      try {
        current = readFileSync(join(session.worktreePath, path), 'utf8');
      } catch {
        continue; // deleted in the working tree — nothing to claim
      }
      const language = languageForPath(path);
      const before = readAtForkPoint(session.worktreePath, session.forkPoint, path);

      const symbols = language ? extractSymbols(current, language) : undefined;
      if (!language || symbols === undefined) {
        // Unsupported language, or a syntax error — one file-level claim.
        if (before === undefined || normalizeAndHash(before) !== normalizeAndHash(current)) {
          this.upsertClaim(session, path, null, 'file', current, now);
          stillDivergent.add(claimKey(path, null));
        }
        continue;
      }

      const beforeSymbols = before !== undefined ? extractSymbols(before, language) : [];
      const beforeByName = new Map((beforeSymbols ?? []).map((s) => [s.name, s]));

      for (const sym of symbols) {
        const currentBody = current.slice(sym.startByte, sym.endByte);
        const priorRange = beforeByName.get(sym.name);
        const priorBody = priorRange !== undefined && before !== undefined
          ? before.slice(priorRange.startByte, priorRange.endByte)
          : undefined;

        if (priorBody !== undefined && normalizeAndHash(priorBody) === normalizeAndHash(currentBody)) {
          this.claims.deleteOne(session.id, path, sym.name);
          continue;
        }
        this.upsertClaim(session, path, sym.name, sym.kind, currentBody, now);
        stillDivergent.add(claimKey(path, sym.name));
      }
    }

    // Anything this session previously claimed but that isn't in
    // `stillDivergent` any more (file no longer changed, or that symbol
    // reverted) is stale — drop it rather than let history accumulate.
    for (const existing of this.claims.listBySession(session.id)) {
      const key = claimKey(existing.path, existing.symbol);
      if (!stillDivergent.has(key)) {
        this.claims.deleteOne(session.id, existing.path, existing.symbol);
      }
    }
  }

  private upsertClaim(
    session: IndexableSession,
    path: string,
    symbol: string | null,
    kind: SymbolKind,
    body: string,
    now: string,
  ): void {
    const existing = this.claims.findOne(session.id, path, symbol);
    this.claims.upsert({
      id: existing?.id ?? newId('fc'),
      sessionId: session.id,
      workspaceId: session.workspaceId,
      path,
      symbol,
      kind,
      headSha: session.forkPoint,
      bodyHash: normalizeAndHash(body),
      firstSeen: existing?.firstSeen ?? now,
      lastSeen: now,
    });
  }
}
