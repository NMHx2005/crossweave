/**
 * Which files of a diff deserve a closer look, judged by NAME and path only: the content is never read. It is a
 * heuristic that can both miss (a key pasted into `config.txt`) and over-flag, so every label says "sensitive", never "safe".
 *
 * A path has at most one kind. When several rules match, the first in `SENSITIVE_ORDER` wins — the kinds that make
 * Land ask come first, and the summary line reads in the same order.
 */
export type SensitiveKind = 'secret' | 'automation' | 'migration' | 'dependency';

export const SENSITIVE_ORDER: readonly SensitiveKind[] = ['secret', 'automation', 'migration', 'dependency'];

export const SENSITIVE_LABEL: Record<SensitiveKind, string> = {
  secret: 'secret',
  automation: 'automation',
  migration: 'migration',
  dependency: 'dependency',
};

export const SENSITIVE_REASON: Record<SensitiveKind, string> = {
  secret: 'Looks like a secret or credential file (a name check, not a content scan).',
  automation: 'Runs commands or changes how the project builds, tests or deploys: CI, hooks, containers, editor tasks, the repository config.',
  migration: 'A database migration: it changes stored data and is hard to take back.',
  dependency: 'A manifest or lockfile: it changes which libraries are installed and can change install or test scripts (postinstall).',
};

/**
 * What makes Land ask first. Lockfiles and migrations only get a badge: they change on almost every land, and a question
 * that is always asked teaches people to click through the one that matters.
 */
export const LAND_ASKS: ReadonlySet<SensitiveKind> = new Set<SensitiveKind>(['secret', 'automation']);

const PLACEHOLDER = new Set(['example', 'sample', 'template']);
/** The kinds of file that hold a secret as data. `secrets.ts` or `credentials.md` are source and docs that merely talk about one. */
const DATA_EXT = /\.(json|ya?ml|toml|env|ini|conf|cfg|properties|txt|xml)$/;
const SECRET_STEMS = new Set(['secret', 'secrets', 'credentials']);
const SECRET_BASENAMES = new Set(['.npmrc', '.netrc', '.pypirc', '.git-credentials', 'credentials', 'kubeconfig']);

function isSecret(base: string, dirs: readonly string[]): boolean {
  if (base === '.env') return true;
  // The final suffix decides: `.env.local.example` is a placeholder, `.env.example.local` is not.
  if (base.startsWith('.env.')) return !PLACEHOLDER.has(base.slice(base.lastIndexOf('.') + 1));
  if (/\.(pem|key|p12|pfx|jks|keystore)$/.test(base)) return true;
  if (/\.tfstate(\.backup)?$/.test(base)) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)$/.test(base)) return true;
  if (SECRET_BASENAMES.has(base)) return true;
  const parent = dirs.at(-1);
  if (dirs.includes('.ssh')) return true;
  if (parent === '.kube' && base === 'config') return true;
  if (parent === '.docker' && base === 'config.json') return true;
  const parts = base.split('.');
  const placeholder = parts.some((p) => PLACEHOLDER.has(p));
  if (placeholder || !DATA_EXT.test(base)) return false;
  if (parts.length > 1 && SECRET_STEMS.has(parts[0] ?? '')) return true;
  return dirs.includes('secrets');
}

const AUTOMATION_BASENAMES = new Set([
  '.gitlab-ci.yml', 'jenkinsfile', 'azure-pipelines.yml', '.pre-commit-config.yaml', 'crossweave.config.json', '.mcp.json',
  '.travis.yml', 'bitbucket-pipelines.yml', 'lefthook.yml', 'lefthook.yaml', 'compose.yml', 'compose.yaml',
]);
const AUTOMATION_DIRS = new Set(['.circleci', '.buildkite', '.husky', '.githooks', '.devcontainer']);

function isAutomation(base: string, dirs: readonly string[]): boolean {
  if (AUTOMATION_BASENAMES.has(base)) return true;
  if (/^docker-compose.*\.ya?ml$/.test(base)) return true;
  if (base === 'dockerfile' || (base.startsWith('dockerfile.') && !/\.(md|txt)$/.test(base))) return true;
  if (dirs.some((d) => AUTOMATION_DIRS.has(d))) return true;
  const parent = dirs.at(-1);
  if (dirs.some((d, i) => (d === '.github' && (dirs[i + 1] === 'workflows' || dirs[i + 1] === 'actions')) || (d === '.claude' && dirs[i + 1] === 'hooks'))) return true;
  if (parent === '.claude' && (base === 'settings.json' || base === 'settings.local.json')) return true;
  if (parent === '.vscode' && base === 'tasks.json') return true;
  return (parent === '.cursor' || parent === '.vscode') && base === 'mcp.json';
}

/** A directory, not a file named for it: `migrate.ts` is not a migration. */
function isMigration(dirs: readonly string[]): boolean {
  return dirs.includes('migrations') || dirs.includes('migrate') || dirs.some((d, i) => d === 'alembic' && dirs[i + 1] === 'versions');
}

const DEPENDENCY_BASENAMES = new Set([
  'package.json', 'pyproject.toml', 'requirements.txt', 'pipfile', 'cargo.toml', 'go.mod', 'gemfile', 'composer.json', 'pom.xml',
  'build.gradle', 'build.gradle.kts', 'setup.py',
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'cargo.lock', 'gemfile.lock',
  'poetry.lock', 'uv.lock', 'pipfile.lock', 'go.sum', 'composer.lock', 'packages.lock.json', 'gradle.lockfile',
]);

function isDependency(base: string): boolean {
  return DEPENDENCY_BASENAMES.has(base) || /^requirements-.+\.txt$/.test(base);
}

/** `path` as git prints it: forward slashes, any depth, case ignored. */
export function sensitiveKind(path: string): SensitiveKind | null {
  const parts = path.toLowerCase().split('/').filter((p) => p !== '');
  const base = parts.at(-1);
  if (base === undefined) return null;
  const dirs = parts.slice(0, -1);
  if (isSecret(base, dirs)) return 'secret';
  if (isAutomation(base, dirs)) return 'automation';
  if (isMigration(dirs)) return 'migration';
  if (isDependency(base)) return 'dependency';
  return null;
}

/** The flagged files grouped by kind in `SENSITIVE_ORDER` (kinds with none omitted), each group in input order. */
export function summarizeSensitive(paths: readonly string[]): { total: number; byKind: Array<{ kind: SensitiveKind; paths: string[] }> } {
  const groups = new Map<SensitiveKind, string[]>();
  let total = 0;
  for (const path of paths) {
    const kind = sensitiveKind(path);
    if (kind === null) continue;
    total++;
    groups.set(kind, [...(groups.get(kind) ?? []), path]);
  }
  return { total, byKind: SENSITIVE_ORDER.flatMap((kind) => (groups.has(kind) ? [{ kind, paths: groups.get(kind) as string[] }] : [])) };
}
