# Horizon E Remaining — Browser Tabs on Stage Strip — Design

**Date:** 2026-09-24
**Horizon:** E remaining (browser tabs)
**Tier:** Small — web stage tab strip, no DB migration, no native modules.

## Goal

Browser pages as tabs on the same web stage (Deck One project stage style) — tab strip with pin/close/reorder on `src/gateway/web/index.html`, alongside file explorer `openFile`.

## Non-goals

- No Monaco bundle in repo — file open renders via `webRoot` static + RPC `workspace.openFile`.
- No Windows.

## Design

- `index.html` adds tab strip `<div id="tabs">` + JS: `tabs = [{id, title, url, pinned}]`, `renderTabs()`, `openBrowserTab(url)`, `closeTab(id)`, `reorderTab(from,to)`.
- State in-memory + `localStorage` for pins; no new RPC (browser pages are client-side `window.open`/`iframe` placeholders — real browser CDP is future).
- File explorer tree calls `wc.openFile(path)` and shows content in tab.

## Gate

bun run typecheck · bun test --concurrency 1 · bun run build + manual open tabs in browser.
