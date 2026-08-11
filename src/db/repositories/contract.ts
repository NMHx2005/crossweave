import type { Database } from 'bun:sqlite';

export interface ContractRow {
  id: string;
  workspaceId: string;
  ownerSession: string;
  symbolFqn: string;
  sigHash: string;
  declaredAt: string;
  stableBy: string | null;
}

interface ContractRecord {
  id: string;
  workspace_id: string;
  owner_session: string;
  symbol_fqn: string;
  sig_hash: string;
  declared_at: string;
  stable_by: string | null;
}

const COLS = 'id,workspace_id,owner_session,symbol_fqn,sig_hash,declared_at,stable_by';

function toRow(r: ContractRecord): ContractRow {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    ownerSession: r.owner_session,
    symbolFqn: r.symbol_fqn,
    sigHash: r.sig_hash,
    declaredAt: r.declared_at,
    stableBy: r.stable_by,
  };
}

export class ContractRepo {
  constructor(private readonly db: Database) {}

  insert(row: ContractRow): void {
    this.db
      .prepare(`INSERT INTO contract (${COLS}) VALUES (?,?,?,?,?,?,?)`)
      .run(row.id, row.workspaceId, row.ownerSession, row.symbolFqn, row.sigHash, row.declaredAt, row.stableBy);
  }

  findByFqn(workspaceId: string, symbolFqn: string): ContractRow | undefined {
    const r = this.db
      .prepare(`SELECT ${COLS} FROM contract WHERE workspace_id=? AND symbol_fqn=?`)
      .get(workspaceId, symbolFqn) as ContractRecord | null;
    return r ? toRow(r) : undefined;
  }

  listByWorkspace(workspaceId: string): ContractRow[] {
    return (
      this.db.prepare(`SELECT ${COLS} FROM contract WHERE workspace_id=?`).all(workspaceId) as ContractRecord[]
    ).map(toRow);
  }

  updateSigHash(id: string, sigHash: string): void {
    this.db.prepare('UPDATE contract SET sig_hash=? WHERE id=?').run(sigHash, id);
  }

  addSubscriber(contractId: string, sessionId: string, subscribedAt: string): void {
    this.db
      .prepare(
        'INSERT INTO contract_sub (contract_id, session_id, subscribed_at) VALUES (?,?,?) ' +
          'ON CONFLICT (contract_id, session_id) DO NOTHING',
      )
      .run(contractId, sessionId, subscribedAt);
  }

  listSubscribers(contractId: string): string[] {
    return (
      this.db
        .prepare('SELECT session_id FROM contract_sub WHERE contract_id=?')
        .all(contractId) as { session_id: string }[]
    ).map((r) => r.session_id);
  }
}
