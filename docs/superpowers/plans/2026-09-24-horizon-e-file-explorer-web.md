# Horizon E — File Explorer + Browser Tabs Implementation Plan

**Goal:** File tree + open file in gateway web (READ RPCs).

**Spec:** `docs/superpowers/specs/2026-09-24-horizon-e-file-explorer-web-design.md`

**Tasks:**
1. Add `workspace.openFile` READ RPC + gateway allowlist + cockpit channel.
2. Wire `src/gateway/web/client.ts` openFile/fileTree.
3. Add `tests/daemon/methods-openfile.test.ts`.

**Gate:** typecheck · bun test --concurrency 1 · build.
