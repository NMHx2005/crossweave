# Full bilingual website — known limitations

## Shipped

- Every currently indexable site route has English and Vietnamese versions: home, download, eight documentation routes, and changelog. The 404 page presents both languages in one noindex page.
- Release notes v0.3.0 through v0.6.0 have Vietnamese counterparts. The build fails when English and Vietnamese release tag sets differ.
- Canonicals, reciprocal `hreflang`, language switching, navigation, footer links, sitemap entries and homepage release teasers follow the selected language.

## Remaining limits

- A separate human Vietnamese-fluent proofread is still outstanding. An independent AI copy review has corrected wording around trusted commands, stale check results, Land evidence, shared-file summaries, security response timelines, live drag previews and the product-name metaphor; that pass cannot establish publication-quality localization on its own.
- English README, `SECURITY.md`, CLI help and release notes remain the canonical sources. Vietnamese docs and releases are maintained counterparts; future source edits can make them drift until the matching translation is updated. The release tag parity check detects missing or extra versions, not prose drift.
- Machine checks verify route coverage, metadata and links, but cannot prove every translated sentence preserves nuance or technical meaning.
