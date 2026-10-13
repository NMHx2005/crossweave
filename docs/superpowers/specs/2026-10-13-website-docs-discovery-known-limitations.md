# Website Docs and Changelog discovery — known limitations

## Shipped

- `/docs/` and `/vi/docs/` search their current documentation and the README snapshots published with stable release tags. Search runs in the browser against a same-origin, content-fingerprinted JSON index; there is no search service, server endpoint, or account data sent elsewhere.
- Search folds case and Vietnamese diacritics, requires every query term, and caps the visible results at 30. It searches rendered headings and article text; it does not rank by relevance, stem words, or search external GitHub issues, source files, or release notes outside the README snapshots.
- The release snapshots are English because the tagged releases contain English READMEs. The Vietnamese Docs page labels those historical results as English and retains its current Vietnamese docs independently.
- The Changelog filters its static release notes by text, version, and the categories present in each release's top-level headings. It shows three releases per page while JavaScript is active. All release notes and release anchors remain in the HTML when JavaScript is unavailable.

## Deliberately not included

- Search does not span multiple products or repositories and does not synchronize saved searches across devices.
- Archive pages cover stable tags with matching release notes only. Prereleases and repository history without published release notes are not listed.
- Changelog categories are heading-based. A release note without a recognized heading still appears in text/version filters but has no category for that type.
- Search and the interactive Changelog controls require JavaScript. The original static Docs links, archive links, complete release notes, and release navigation remain usable without it.

## Verification note

The deterministic UI tests and static production-domain build passed. This environment did not provide a Chrome DevTools/browser-tab provider, so this milestone's Docs and Changelog controls were not visually inspected in a live browser at desktop or mobile sizes. The localhost static routes returned HTTP 200; the browser visual review remains to be performed when an isolated browser session is available.
