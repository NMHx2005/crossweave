# Horizon F — Distribution Unified — Design

**Date:** 2026-09-24
**Horizon:** F of `docs/superpowers/plans/2026-09-21-long-roadmap-spacevibe-crossweave.md`
**Tier:** Small — install.sh unification, no code change initially.
**Status:** design

## Goal

One installer `curl spacevibe.dev/install.sh` installs `cw`/`cwd` + Deck `.app` + gateway, checksum-gated.

## Design

- `install.sh` detects darwin-arm64/linux-x64, installs `cw`/`cwd` (existing) + Deck `.app` (when present) + checks `bwrap` on Linux.
- Updater: `cw update` checks GitHub latest, Deck `latest` moving release — one check.
- No Windows until cwd POSIX→Windows.

## Gate

Manual `install.sh` dry-run.
