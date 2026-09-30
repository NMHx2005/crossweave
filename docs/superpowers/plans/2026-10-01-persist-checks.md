# Persist `cw check` verdicts — plan

Spec: `docs/superpowers/specs/2026-10-01-persist-checks-design.md`

- [ ] Migration v18 `session_check`; `SCHEMA_VERSION` 18; open.test still green.
- [ ] `SessionCheckRepo` (`all`, `save`, `remove`) + tests (round trip, cascade on session delete, replace).
- [ ] `CheckRunner` takes an optional store: loads on construction, removes on `start`, saves on finish, removes on `forget`; tests
      incl. "a second runner over the same store sees the verdict", "an interrupted run leaves no verdict", failing store never breaks a run.
- [ ] Wire the repo in `methods.ts`.
- [ ] Docs: known limitations (update the "lives in memory" bullet), digest line, AGENTS.md schema version, PROGRESS.
- [ ] Gate: typecheck, root tests, build; then a real restart check on a scratch daemon.
