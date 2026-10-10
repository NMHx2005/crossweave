import { describe, expect, it } from 'bun:test';
import { LAND_ASKS, SENSITIVE_LABEL, SENSITIVE_ORDER, SENSITIVE_REASON, sensitiveKind, summarizeSensitive, type SensitiveKind } from '../../src/core/sensitive-files.js';

const ROWS: Array<[string, SensitiveKind | null]> = [
  // secret: the env family, with the documented placeholders left alone
  ['.env', 'secret'],
  ['apps/web/.env.production', 'secret'],
  ['.ENV.PRODUCTION', 'secret'],
  ['.env.prod', 'secret'],
  ['.env.production.local', 'secret'],
  ['.env.example.local', 'secret'],
  ['.env.example', null],
  ['.env.sample', null],
  ['.env.template', null],
  ['.env.local.example', null],
  ['.envrc', null],
  ['.environment', null],
  ['env.example', null],
  ['my.env', null],
  // secret: keys, certificates, tool credentials
  ['deploy/server.PEM', 'secret'],
  ['certs/site.key', 'secret'],
  ['store.p12', 'secret'],
  ['android/app.keystore', 'secret'],
  ['id_rsa', 'secret'],
  ['home/.ssh/id_ed25519', 'secret'],
  ['id_rsa.pub', null],
  ['.npmrc', 'secret'],
  ['.netrc', 'secret'],
  ['.git-credentials', 'secret'],
  ['credentials', 'secret'],
  ['.aws/credentials', 'secret'],
  ['.ssh/config', 'secret'],
  ['.ssh/known_hosts', 'secret'],
  ['infra/terraform.tfstate', 'secret'],
  ['infra/terraform.tfstate.backup', 'secret'],
  ['kubeconfig', 'secret'],
  ['.kube/config', 'secret'],
  ['.docker/config.json', 'secret'],
  ['config/docker/config.json', null],
  // secret: a data file named for what it holds, but never source or docs that merely mention it
  ['credentials.json', 'secret'],
  ['config/secrets.yml', 'secret'],
  ['secret.toml', 'secret'],
  ['secrets/prod.json', 'secret'],
  ['credentials.example.json', null],
  ['secrets.example.yaml', null],
  ['secrets/prod.example.json', null],
  ['src/secrets.ts', null],
  ['src/secret.service.ts', null],
  ['src/app/secrets.controller.ts', null],
  ['lib/credentials.ts', null],
  ['src/lib/secret.test.ts', null],
  ['docs/credentials.md', null],
  ['docs/secrets.md', null],
  ['src/keyboard.ts', null],
  ['key.ts', null],
  ['config.pem.md', null],
  // automation
  ['.github/workflows/ci.yml', 'automation'],
  ['x/.github/actions/a/action.yml', 'automation'],
  ['.GitHub/Workflows/ci.yml', 'automation'],
  ['.github/CODEOWNERS', null],
  ['.github/dependabot.yml', null],
  ['.gitlab-ci.yml', 'automation'],
  ['Jenkinsfile', 'automation'],
  ['.circleci/config.yml', 'automation'],
  ['.travis.yml', 'automation'],
  ['bitbucket-pipelines.yml', 'automation'],
  ['azure-pipelines.yml', 'automation'],
  ['.buildkite/pipeline.yml', 'automation'],
  ['.husky/pre-commit', 'automation'],
  ['.githooks/pre-push', 'automation'],
  ['lefthook.yml', 'automation'],
  ['.pre-commit-config.yaml', 'automation'],
  ['Dockerfile', 'automation'],
  ['svc/Dockerfile.dev', 'automation'],
  ['Dockerfile.md', null],
  ['docs/Dockerfile.txt', null],
  ['docker-compose.yml', 'automation'],
  ['docker-compose.override.yaml', 'automation'],
  ['compose.yaml', 'automation'],
  ['crossweave.config.json', 'automation'],
  ['.mcp.json', 'automation'],
  ['.cursor/mcp.json', 'automation'],
  ['.vscode/mcp.json', 'automation'],
  ['.vscode/tasks.json', 'automation'],
  ['.vscode/settings.json', null],
  ['.devcontainer/devcontainer.json', 'automation'],
  ['.claude/settings.json', 'automation'],
  ['.claude/settings.local.json', 'automation'],
  ['.claude/hooks/pre.sh', 'automation'],
  ['.claude/agents/a.md', null],
  ['Makefile', null],
  // migration: a directory, not a file named for it
  ['db/migrate/20240101_x.rb', 'migration'],
  ['src/migrations/001.sql', 'migration'],
  ['prisma/migrations/20240101/migration.sql', 'migration'],
  ['alembic/versions/a.py', 'migration'],
  ['versions/a.py', null],
  ['migrate.ts', null],
  ['src/migrations.ts', null],
  ['docs/migrations', null],
  // dependency
  ['package.json', 'dependency'],
  ['apps/cockpit/package.json', 'dependency'],
  ['pyproject.toml', 'dependency'],
  ['requirements.txt', 'dependency'],
  ['requirements-dev.txt', 'dependency'],
  ['requirements.md', null],
  ['setup.py', 'dependency'],
  ['Cargo.toml', 'dependency'],
  ['go.mod', 'dependency'],
  ['go.sum', 'dependency'],
  ['bun.lock', 'dependency'],
  ['bun.lockb', 'dependency'],
  ['package-lock.json', 'dependency'],
  ['pnpm-lock.yaml', 'dependency'],
  ['yarn.lock', 'dependency'],
  ['Gemfile.lock', 'dependency'],
  ['gradle.lockfile', 'dependency'],
  ['pom.xml', 'dependency'],
  // ordinary files and degenerate input
  ['README.md', null],
  ['src/index.ts', null],
  ['', null],
  ['/', null],
  // collisions: one kind per path, in the priority order secret > automation > migration > dependency
  ['.github/workflows/package.json', 'automation'],
  ['migrations/.env', 'secret'],
  ['db/migrations/package.json', 'migration'],
  ['.claude/hooks/secrets.json', 'secret'],
  ['docker/Dockerfile', 'automation'],
  // a path as the diff parser hands it over: unquoted, spaces and non-ASCII kept
  ['my app/.env.production', 'secret'],
  ['café/migrations/001 é.sql', 'migration'],
];

describe('sensitiveKind', () => {
  for (const [path, kind] of ROWS) {
    it(`${JSON.stringify(path)} → ${kind ?? 'not flagged'}`, () => {
      expect(sensitiveKind(path)).toBe(kind);
    });
  }
});

describe('summarizeSensitive', () => {
  it('counts only flagged files, groups them in the priority order and keeps each group in input order', () => {
    const out = summarizeSensitive(['package.json', 'src/a.ts', '.github/workflows/ci.yml', '.env.production', 'bun.lock', 'db/migrate/1.rb']);
    expect(out.total).toBe(5);
    expect(out.byKind).toEqual([
      { kind: 'secret', paths: ['.env.production'] },
      { kind: 'automation', paths: ['.github/workflows/ci.yml'] },
      { kind: 'migration', paths: ['db/migrate/1.rb'] },
      { kind: 'dependency', paths: ['package.json', 'bun.lock'] },
    ]);
  });
  it('nothing flagged, or nothing at all, is an empty summary', () => {
    expect(summarizeSensitive([])).toEqual({ total: 0, byKind: [] });
    expect(summarizeSensitive(['src/a.ts', 'README.md'])).toEqual({ total: 0, byKind: [] });
  });
});

describe('the kinds', () => {
  it('Land asks about secrets and automation only: lockfiles change on almost every land', () => {
    expect([...LAND_ASKS].sort()).toEqual(['automation', 'secret']);
  });
  it('every kind has a word for it (colour alone is not enough) and a reason', () => {
    expect([...SENSITIVE_ORDER]).toEqual(['secret', 'automation', 'migration', 'dependency']);
    for (const kind of SENSITIVE_ORDER) {
      expect(SENSITIVE_LABEL[kind].length).toBeGreaterThan(0);
      expect(SENSITIVE_REASON[kind].length).toBeGreaterThan(10);
    }
    expect(SENSITIVE_REASON.dependency).toContain('postinstall');
  });
});
