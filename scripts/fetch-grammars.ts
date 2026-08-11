// scripts/fetch-grammars.ts
//
// Maintainer tool: (re)downloads the pinned grammar .wasm files into
// assets/grammars/ and verifies each against its known sha256. Run by hand
// when bumping a grammar version — never part of `bun install` or any
// runtime code path. Network access is to cdn.jsdelivr.net only, which
// serves files straight out of the published npm tarball unmodified.
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

interface GrammarAsset {
  file: string;
  url: string;
  sha256: string;
}

const OUT_DIR = join(import.meta.dir, '..', 'assets', 'grammars');

const ASSETS: GrammarAsset[] = [
  {
    file: 'tree-sitter-typescript.wasm',
    url: 'https://cdn.jsdelivr.net/npm/tree-sitter-typescript@0.23.2/tree-sitter-typescript.wasm',
    sha256: '778025db5a8be0e70f8ccc3671e486dfeddd048c25d9e8a70c26de2e1bf6f97d',
  },
  {
    file: 'tree-sitter-tsx.wasm',
    url: 'https://cdn.jsdelivr.net/npm/tree-sitter-typescript@0.23.2/tree-sitter-tsx.wasm',
    sha256: '79e5da75ea62855a0cd67177685f0164eac87d5f630b3cbe1e0a099751ad30f8',
  },
  {
    file: 'tree-sitter-javascript.wasm',
    url: 'https://cdn.jsdelivr.net/npm/tree-sitter-javascript@0.25.0/tree-sitter-javascript.wasm',
    sha256: '5fb488d0cabb4775a594bab85682de5ad6ce83c0d6ac997a9f82dd084d571240',
  },
  {
    file: 'tree-sitter-python.wasm',
    url: 'https://cdn.jsdelivr.net/npm/tree-sitter-python@0.25.0/tree-sitter-python.wasm',
    sha256: '16108b50df4ee9a30168794252ab55e7c93bfc5765d7fa0aa3e335752c515f47',
  },
];

async function fetchOne(asset: GrammarAsset): Promise<void> {
  const res = await fetch(asset.url);
  if (!res.ok) throw new Error(`fetch failed for ${asset.url}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== asset.sha256) {
    throw new Error(
      `checksum mismatch for ${asset.file}: expected ${asset.sha256}, got ${actual}. ` +
        'The CDN may be serving a different build than the one this script was pinned against — do not overwrite the committed asset without investigating.',
    );
  }
  await writeFile(join(OUT_DIR, asset.file), bytes);
  console.log(`ok: ${asset.file} (${bytes.length} bytes, sha256 verified)`);
}

for (const asset of ASSETS) {
  await fetchOne(asset);
}
console.log('all grammar assets fetched and verified');
