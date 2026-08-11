# Grammar assets

Pre-built `web-tree-sitter` grammar `.wasm` files, fetched from the pinned
npm package versions listed in `scripts/fetch-grammars.ts` and verified
against `CHECKSUMS.sha256`. These are the ONLY artifact taken from
`tree-sitter-typescript`, `tree-sitter-javascript` and `tree-sitter-python` —
none of those three packages is a project dependency (each carries native
`.node` prebuilds and an `install` script that would violate this project's
zero-native/zero-install-script rule; see the M3 design doc §2.1 and this
plan's Global Constraints).

To bump a grammar version: edit the version + URL + expected sha256 in
`scripts/fetch-grammars.ts`, then run `bun run scripts/fetch-grammars.ts`
and commit the updated `.wasm` files together with the script change.
