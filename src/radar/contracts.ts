import { createHash } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { newId } from '../core/ids.js';
import { ContractRepo, type ContractRow } from '../db/repositories/contract.js';
import { extractSymbols, type SymbolRange } from './symbols.js';
import { languageForPath } from './grammars.js';
import type { MessageBus } from '../domain/bus.js';
import { CrossweaveError } from '../core/errors.js';

export interface DeclareOpts {
  workspaceId: string;
  ownerSession: string;
  symbolFqn: string; // "<path>#<name>"
  stableBy?: string;
}

function parseFqn(fqn: string): { path: string; name: string } {
  const hashIndex = fqn.lastIndexOf('#');
  if (hashIndex === -1) {
    throw new CrossweaveError('INVALID_SYMBOL_FQN', `Expected <file>#<Name>, got: ${fqn}`);
  }
  return { path: fqn.slice(0, hashIndex), name: fqn.slice(hashIndex + 1) };
}

/** `parseFqn`, but a malformed row is skipped rather than aborting a whole-workspace sweep. */
function safeParseFqn(fqn: string): { path: string; name: string } | undefined {
  try {
    return parseFqn(fqn);
  } catch {
    return undefined;
  }
}

function findSymbol(source: string, path: string, name: string): SymbolRange {
  const language = languageForPath(path);
  const symbols = language ? extractSymbols(source, language) : undefined;
  const found = symbols?.find((s) => s.name === name);
  if (!found) {
    throw new CrossweaveError('CONTRACT_TARGET_NOT_FOUND', `No top-level symbol named "${name}" in ${path}`);
  }
  return found;
}

/**
 * A hash of the symbol's PUBLIC SHAPE only. For a `function`/`method` with a
 * known `bodyStartByte` (Task 3's `extractSymbols` populates this from the
 * node's own `body` field), the signature is everything from the symbol's
 * start up to where its body block begins — this is a grammar-verified
 * boundary, not a `{`-search, so it survives a destructured/object-typed
 * parameter (whose OWN `{` would otherwise be mistaken for the body's) and
 * works for Python too (no `{` exists there at all; the body field starts
 * right after the `:`).
 *
 * For anything else — `class`/`interface`/`type`/`const`, or a
 * function/method whose `bodyStartByte` wasn't available — the ENTIRE
 * symbol text is hashed. This means a class/interface contract fires on
 * ANY change to the class, including an internal method body: an accepted
 * M3 scope limitation (over-notify rather than the alternative of never
 * firing at all), matching this project's established posture — see Task
 * 7's `references()` for the same "tuned to over-notify rather than
 * silently miss" call. Narrowing class/interface extraction to
 * member-declarations-only is left to a future task.
 */
function signatureHash(source: string, symbol: SymbolRange): string {
  const useHeaderOnly =
    (symbol.kind === 'function' || symbol.kind === 'method') && symbol.bodyStartByte !== undefined;
  const endByte = useHeaderOnly ? (symbol.bodyStartByte as number) : symbol.endByte;
  const signature = source.slice(symbol.startByte, endByte).replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(signature).digest('hex');
}

export class ContractService {
  private readonly repo: ContractRepo;

  constructor(db: Database) {
    this.repo = new ContractRepo(db);
  }

  declareFromSource(opts: DeclareOpts, currentSource: string): ContractRow {
    const { path, name } = parseFqn(opts.symbolFqn);
    const symbol = findSymbol(currentSource, path, name);
    const sigHash = signatureHash(currentSource, symbol);

    const existing = this.repo.findByFqn(opts.workspaceId, opts.symbolFqn);
    if (existing) {
      this.repo.updateSigHash(existing.id, sigHash);
      return { ...existing, sigHash };
    }
    const row: ContractRow = {
      id: newId('ct'),
      workspaceId: opts.workspaceId,
      ownerSession: opts.ownerSession,
      symbolFqn: opts.symbolFqn,
      sigHash,
      declaredAt: new Date().toISOString(),
      stableBy: opts.stableBy ?? null,
    };
    this.repo.insert(row);
    return row;
  }

  /** Auto-subscribes `sessionId` if it isn't already, so the next sig_hash change reaches it. */
  subscribe(contractId: string, sessionId: string): void {
    this.repo.addSubscriber(contractId, sessionId, new Date().toISOString());
  }

  /**
   * A narrower heuristic than the full design's "any session whose files
   * reference the symbol" (still deferred — see `references()` in
   * noise.ts): a session that has a claim on the SAME FILE a contract lives
   * in gets auto-subscribed, so `checkAndNotify`'s notification loop has a
   * real, reachable path to a subscriber instead of an always-empty one.
   */
  autoSubscribeForPath(workspaceId: string, sessionId: string, path: string): void {
    for (const contract of this.repo.listByWorkspace(workspaceId)) {
      const parsed = safeParseFqn(contract.symbolFqn);
      if (parsed?.path === path) this.subscribe(contract.id, sessionId);
    }
  }

  /** Cheap early-exit for a caller (the watcher) that wants to skip a per-path contract sweep entirely when the workspace has none declared. */
  hasContracts(workspaceId: string): boolean {
    return this.repo.listByWorkspace(workspaceId).length > 0;
  }

  /**
   * Re-derives every declared contract whose `symbolFqn` starts with
   * `path#`, and — if the re-derived `sig_hash` differs from what's
   * stored — updates it and messages every subscriber with the diff.
   * Called by the indexer after a real reindex (Task 4/5's wiring), never
   * directly by a CLI command.
   */
  checkAndNotify(workspaceId: string, path: string, currentSource: string, bus: MessageBus): void {
    const matching: { contract: ContractRow; name: string }[] = [];
    for (const contract of this.repo.listByWorkspace(workspaceId)) {
      const parsed = safeParseFqn(contract.symbolFqn);
      if (parsed?.path !== path) continue; // skip malformed rows and contracts on other files
      matching.push({ contract, name: parsed.name });
    }
    if (matching.length === 0) return;

    // Parsed once for every contract on this path, not once PER contract.
    const language = languageForPath(path);
    const symbols = language ? extractSymbols(currentSource, language) : undefined;

    const changes: { contract: ContractRow; oldHash: string; newSigHash: string }[] = [];
    for (const { contract, name } of matching) {
      const symbol = symbols?.find((s) => s.name === name);
      if (!symbol) continue; // symbol removed or file unparseable this pass — leave the contract as-is
      const newSigHash = signatureHash(currentSource, symbol);
      if (newSigHash === contract.sigHash) continue;
      changes.push({ contract, oldHash: contract.sigHash, newSigHash });
    }

    // Notify every subscriber BEFORE persisting the new hash: if `bus.send`
    // throws partway through, the stored hash must not already reflect a
    // change some subscribers were never actually told about.
    for (const { contract, oldHash, newSigHash } of changes) {
      for (const subscriberId of this.repo.listSubscribers(contract.id)) {
        bus.send({
          workspaceId,
          fromSession: contract.ownerSession,
          toSession: subscriberId,
          trust: 'system',
          body: `Contract changed: ${contract.symbolFqn} — signature hash ${oldHash.slice(0, 8)} -> ${newSigHash.slice(0, 8)}`,
        });
      }
    }
    for (const { contract, newSigHash } of changes) {
      this.repo.updateSigHash(contract.id, newSigHash);
    }
  }
}
