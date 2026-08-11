import type { FileClaimRepo } from '../db/repositories/file-claim.js';
import type { SymbolKind } from '../db/repositories/file-claim.js';

export interface Collision {
  sessionId: string;
  path: string;
  symbol: string | null;
  kind: SymbolKind;
}

export interface CheckOpts {
  workspaceId: string;
  sessionId: string;
  path: string;
  symbol?: string;
}

/**
 * Every OTHER session's claim on `path` that genuinely diverges from the
 * caller's own view of it. A file-level query (`symbol` omitted) matches any
 * claim on that path regardless of the other session's granularity — an
 * agent about to touch a whole file deserves to know about a symbol-scoped
 * claim inside it, not just an exact file-level match.
 */
export function checkCollisions(claims: FileClaimRepo, opts: CheckOpts): Collision[] {
  const own = claims.findOne(opts.sessionId, opts.path, opts.symbol ?? null);
  const others = claims
    .listByWorkspacePath(opts.workspaceId, opts.path)
    .filter((c) => c.sessionId !== opts.sessionId)
    .filter((c) => opts.symbol === undefined || c.symbol === null || c.symbol === opts.symbol);

  return others
    .filter((c) => own === undefined || c.bodyHash !== own.bodyHash)
    .map((c) => ({ sessionId: c.sessionId, path: c.path, symbol: c.symbol, kind: c.kind }));
}
