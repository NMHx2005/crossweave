export interface ConvergeStatus {
  ready: string[];
  unknown: { name: string; reason: string }[];
  blocked: { name: string; reason: string }[];
}

export interface LandResult {
  status: 'landed';
  tested: 'clean' | 'unverified';
  baseBranch: string;
  warnings: string[];
}

export function chooseNextLand(
  status: ConvergeStatus,
  force: boolean,
): { name: string; warning?: string } | undefined {
  const ready = status.ready[0];
  if (ready !== undefined) return { name: ready };
  if (!force) return undefined;
  const unknown = status.unknown[0];
  return unknown === undefined
    ? undefined
    : { name: unknown.name, warning: unknown.reason };
}

/**
 * Re-fetch after every successful land so the next pick is against the new base.
 * `force` matches `cw land all --force` (unknown only after ready is empty).
 */
export async function landAllLoop(opts: {
  getStatus: () => Promise<ConvergeStatus>;
  land: (name: string) => Promise<LandResult>;
  onProgress?: (name: string, result: LandResult) => void;
  force?: boolean;
}): Promise<{ landed: string[]; failedAt?: string; error?: string }> {
  const landed: string[] = [];
  while (true) {
    const status = await opts.getStatus();
    const candidate = chooseNextLand(status, opts.force === true);
    if (candidate === undefined) return { landed };
    try {
      const result = await opts.land(candidate.name);
      landed.push(candidate.name);
      opts.onProgress?.(candidate.name, result);
    } catch (err) {
      return {
        landed,
        failedAt: candidate.name,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
