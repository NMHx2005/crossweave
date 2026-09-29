import { rm, mkdir } from 'node:fs/promises';

const targetArg = process.argv.find((a) => a.startsWith('--target='))?.split('=')[1];
const suffix = targetArg ? `-${targetArg}` : '';
// `--outdir` lets a test build into a directory of its own: the default ./dist is deleted
// and rebuilt, so two builds (or a build and a running binary) sharing it break each other.
const outdir = (process.argv.find((a) => a.startsWith('--outdir='))?.split('=')[1] ?? './dist').replace(/\/$/, '');

const targets = [
  { entry: './src/cli/index.ts', out: `${outdir}/cw${suffix}` },
  { entry: './src/daemon/main.ts', out: `${outdir}/cwd${suffix}` },
];

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

for (const t of targets) {
  const args = ['bun', 'build', t.entry, '--compile', '--minify', '--outfile', t.out];
  if (targetArg) args.splice(3, 0, `--target=bun-${targetArg}`);
  const proc = Bun.spawn(args, { stdout: 'inherit', stderr: 'inherit' });
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`build failed for ${t.entry}`);
    process.exit(code);
  }
}

console.log(`built ${targets.map((t) => t.out).join(' and ')}`);
