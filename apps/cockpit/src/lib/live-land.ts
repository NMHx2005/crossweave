export type LiveLandAuthorization = 'needs_commit' | 'status_unknown' | 'cancelled' | 'confirmed' | 'idle'

/** Gate the destructive stop-and-land path on a known-clean worktree and explicit consent. */
export async function authorizeLiveLand(opts: {
  uncommitted: number | null
  running: boolean
  confirm: () => Promise<boolean>
}): Promise<LiveLandAuthorization> {
  if (opts.uncommitted === null) return 'status_unknown'
  if (opts.uncommitted > 0) return 'needs_commit'
  if (!opts.running) return 'idle'
  return await opts.confirm() ? 'confirmed' : 'cancelled'
}
