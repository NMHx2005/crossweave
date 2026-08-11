// Bun resolves `import x from './foo.wasm' with { type: 'file' }` to the
// asset's on-disk (or `/$bunfs/...` compiled) path string at runtime.
// TypeScript has no built-in declaration for this import form, so it's
// declared here for `grammars.ts` to typecheck.
declare module '*.wasm' {
  const path: string;
  export default path;
}
