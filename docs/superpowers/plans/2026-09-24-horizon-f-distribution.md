# Horizon F — Distribution Implementation Plan

**Goal:** Unified install.sh.

**Spec:** `docs/superpowers/specs/2026-09-24-horizon-f-distribution-design.md`

**Tasks:**
1. Extend `install.sh` to detect arch + install Deck when present.
2. Add `cw update` Deck check (optional).

**Gate:** manual install.sh --dry-run.
