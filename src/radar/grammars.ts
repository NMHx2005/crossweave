import { readFileSync } from 'node:fs';
import { Language, Parser } from 'web-tree-sitter';
import tsWasm from '../../assets/grammars/tree-sitter-typescript.wasm' with { type: 'file' };
import tsxWasm from '../../assets/grammars/tree-sitter-tsx.wasm' with { type: 'file' };
import jsWasm from '../../assets/grammars/tree-sitter-javascript.wasm' with { type: 'file' };
import pyWasm from '../../assets/grammars/tree-sitter-python.wasm' with { type: 'file' };

export type SupportedLanguage = 'typescript' | 'tsx' | 'javascript' | 'python';

const ASSET_PATHS: Record<SupportedLanguage, string> = {
  typescript: tsWasm,
  tsx: tsxWasm,
  javascript: jsWasm,
  python: pyWasm,
};

const EXTENSION_TO_LANGUAGE: Record<string, SupportedLanguage> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
};

export function languageForPath(path: string): SupportedLanguage | undefined {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return undefined;
  return EXTENSION_TO_LANGUAGE[path.slice(dot).toLowerCase()];
}

let initPromise: Promise<void> | undefined;
const loaded = new Map<SupportedLanguage, Language>();

/**
 * Loads `Parser.init()` and every grammar exactly once, however many
 * sessions/files call this concurrently. `readFileSync` on the asset's
 * `with { type: 'file' }` path — rather than handing `Language.load` the
 * path string directly — is deliberate: under `bun build --compile` that
 * path is a virtual `/$bunfs/...` location, and `readFileSync` is verified
 * (via Bun's own patched `node:fs`) to resolve it; relying on
 * `Language.load`'s internal path handling to do the same is untested
 * surface this project does not control.
 */
export function initGrammars(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    await Parser.init();
    for (const lang of Object.keys(ASSET_PATHS) as SupportedLanguage[]) {
      const bytes = readFileSync(ASSET_PATHS[lang]);
      loaded.set(lang, await Language.load(bytes));
    }
  })();
  return initPromise;
}

/** Must be called after `initGrammars()` has resolved. */
export function languageFor(lang: SupportedLanguage): Language {
  const found = loaded.get(lang);
  if (!found) throw new Error(`Grammar not loaded: ${lang}. Call initGrammars() first.`);
  return found;
}
