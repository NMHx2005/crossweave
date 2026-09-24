# Web Monaco Bundle Note

Monaco is loaded from `webRoot/monaco` when vendored (optional static). Fallback is `<pre>` fileview via `openMonaco`. No native module, no bundle in repo. Future: `bun run build` copies monaco ESM to `src/gateway/web/monaco` when present.
