/** The process and its parents, captured only when a live-PTY integration times out. */
export function processAncestryFor(commandFragment: string): string[] {
  const output = Bun.spawnSync(['ps', '-A', '-o', 'pid=,ppid=,args='], { stdout: 'pipe', stderr: 'ignore' }).stdout.toString();
  const rows = new Map<number, { parent: number; args: string }>();
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    rows.set(Number(match[1]), { parent: Number(match[2]), args: match[3] ?? '' });
  }
  const ancestry: string[] = [];
  for (const [pid, row] of rows) {
    if (!row.args.includes(commandFragment)) continue;
    const chain: string[] = [];
    const seen = new Set<number>();
    let current: number | undefined = pid;
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      const entry = rows.get(current);
      if (entry === undefined) break;
      chain.push(`${current} <- ${entry.parent} ${entry.args}`);
      current = entry.parent;
    }
    ancestry.push(...chain.reverse());
  }
  return ancestry;
}
