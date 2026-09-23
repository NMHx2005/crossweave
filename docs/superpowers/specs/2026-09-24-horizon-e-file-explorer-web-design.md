# Horizon E — File Explorer + Browser Tabs in Gateway Web — Design

**Date:** 2026-09-24
**Horizon:** E of `docs/superpowers/plans/2026-09-21-long-roadmap-spacevibe-crossweave.md`
**Tier:** Small — file tree RPC + web pane file open, no DB migration, no native modules.
**Status:** design

## Goal

Gateway web không chỉ terminal: file explorer panel (tree RPC) + one file-open path (Monaco-ready) + browser pages as tabs — như Deck One project stage.

## Non-goals

- Không Monaco bundle trong repo — chỉ RPC + web client openFile wiring, UI renders via static `webRoot`.
- Không Windows.

## Design

- RPC `workspace.listFiles` already exists via Radar indexer — expose as READ for web pane.
- New RPC `workspace.openFile` READ: params `{ workspaceId, path }` → `{ content: string }` (assertContained + readFileSync, capped size).
- `src/gateway/web/client.ts` `openFile(path)` calls `workspace.openFile`, `fileTree()` calls `workspace.listFiles`.
- `webRoot` static serves Monaco when present (optional).

## Gate

bun run typecheck · bun test --concurrency 1 · bun run build + manual web pane open file.
