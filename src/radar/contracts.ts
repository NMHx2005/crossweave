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
 * A hash of the symbol's PUBLIC SHAPE only — for a function/method, its
 * signature line (everything up to the first `{`); a body-only edit must
 * never change this, or a contract would fire on every unrelated
 * implementation tweak, defeating the point of scoping it to the interface.
 */
function signatureHash(body: string): string {
  const braceIndex = body.indexOf('{');
  const signature = (braceIndex === -1 ? body : body.slice(0, braceIndex)).replace(/\s+/g, ' ').trim();
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
    const sigHash = signatureHash(currentSource.slice(symbol.startByte, symbol.endByte));

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
   * Re-derives every declared contract whose `symbolFqn` starts with
   * `path#`, and — if the re-derived `sig_hash` differs from what's
   * stored — updates it and messages every subscriber with the diff.
   * Called by the indexer after a real reindex (Task 4/5's wiring), never
   * directly by a CLI command.
   */
  checkAndNotify(workspaceId: string, path: string, currentSource: string, bus: MessageBus): void {
    for (const contract of this.repo.listByWorkspace(workspaceId)) {
      const { path: cPath, name } = parseFqn(contract.symbolFqn);
      if (cPath !== path) continue;
      const language = languageForPath(path);
      const symbols = language ? extractSymbols(currentSource, language) : undefined;
      const symbol = symbols?.find((s) => s.name === name);
      if (!symbol) continue; // symbol removed or file unparseable this pass — leave the contract as-is

      const newSigHash = signatureHash(currentSource.slice(symbol.startByte, symbol.endByte));
      if (newSigHash === contract.sigHash) continue;

      const oldHash = contract.sigHash;
      this.repo.updateSigHash(contract.id, newSigHash);
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
  }
}
