# Website script cache invalidation plan

- [x] Add regression coverage proving generated script URLs fingerprint the exact emitted JavaScript in base-path and custom-domain builds.
- [x] Pass the JavaScript fingerprint through document rendering and update layout contracts.
- [x] Run required repository and website gates sequentially; inspect generated output.
- [x] Record the remaining static-asset cache limitation and validation scope in known limitations and the digest.
- [ ] Fast-forward the fix to `main`, deploy through Pages, and verify live assets.
