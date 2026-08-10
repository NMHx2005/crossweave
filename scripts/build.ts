import { rm, mkdir } from 'node:fs/promises';

const targets = [
  { entry: './src/cli/index.ts', out: './dist/cw' },
  { entry: './src/daemon/main.ts', out: './dist/cwd' },
];

await rm('./dist', { recursive: true, force: true });
await mkdir('./dist', { recursive: true });

for (const t of targets) {
  const proc = Bun.spawn(
    ['bun', 'build', t.entry, '--compile', '--minify', '--outfile', t.out],
    { stdout: 'inherit', stderr: 'inherit' },
  );
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`build failed for ${t.entry}`);
    process.exit(code);
  }
}

console.log('built dist/cw and dist/cwd');
