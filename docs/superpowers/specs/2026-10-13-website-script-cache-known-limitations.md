# Website script cache invalidation — known limitations

## What changed

- Generated pages append a SHA-256 content fingerprint to `/site.js`, so a page rebuilt after script changes asks for a distinct cache key even when the static host retains the stable asset path for hours.
- The emitted script path stays `/site.js`; only its URL in the generated HTML changes. A page already open, or cached HTML that still references the old key, must be refreshed to receive the new URL.

## Limitations

- This fixes stale JavaScript for newly delivered HTML, including the workflow diagram's hover explanation. It does not force-refresh HTML already stored by a browser or intermediary.
- Images and video still use stable asset URLs; their cache behavior has not been changed.
- The fingerprint is a cache invalidator, not an integrity or authenticity mechanism; HTTPS and the hosting platform provide transport integrity.
- Live pointer interaction is verified in Chromium after deployment; Safari and Firefox remain part of the broader open browser matrix.
