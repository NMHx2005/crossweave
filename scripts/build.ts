import { rm, mkdir } from 'node:fs/promises';

const targetArg = process.argv.find((a) => a.startsWith('--target='))?.split('=')[1];
const suffix = targetArg ? `-${targetArg}` : '';

const targets = [
  { entry: './src/cli/index.ts', out: `./dist/cw${suffix}` },
  { entry: './src/daemon/main.ts', out: `./dist/cwd${suffix}` },
];

await rm('./dist', { recursive: true, force: true });
await mkdir('./dist', { recursive: true });

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
