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

/** The commands running under a session shell, captured only when a PTY integration times out. */
export function processTreeFor(rootPid: number): string[] {
  const output = Bun.spawnSync(['ps', '-A', '-o', 'pid=,ppid=,args='], { stdout: 'pipe', stderr: 'ignore' }).stdout.toString();
  const children = new Map<number, Array<{ pid: number; args: string }>>();
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    const pid = Number(match[1]);
    const parent = Number(match[2]);
    const rows = children.get(parent) ?? [];
    rows.push({ pid, args: match[3] ?? '' });
    children.set(parent, rows);
  }

  const tree: string[] = [];
  const queue = [{ pid: rootPid, depth: 0 }];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || seen.has(current.pid)) continue;
    seen.add(current.pid);
    for (const child of children.get(current.pid) ?? []) {
      tree.push(`${'  '.repeat(current.depth)}${child.pid} ${child.args}`);
      queue.push({ pid: child.pid, depth: current.depth + 1 });
    }
  }
  return tree;
}
