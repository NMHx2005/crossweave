# Website SVG stylesheet cache fix — known limitations

## What changed

- Each generated page now points to the existing `styles.css` path with a SHA-256 content fingerprint in its query string. Browsers treat a new stylesheet body as a new cache key even when GitHub Pages and its edge cache retain the same filename for hours.
- The fingerprint is built from the exact CSS bytes that the site emits, including the shared cockpit theme values.

## Limitations

- A page already open in a tab will not update until it is refreshed. Old cached HTML remains paired with the old stable stylesheet URL; newly built HTML requests the newly fingerprinted URL.
- This addresses CSS/HTML version skew. JavaScript, images and video retain their existing URL and cache behavior.
- The fingerprint is a cache invalidator, not an integrity or authenticity mechanism; HTTPS and the hosting platform provide transport integrity.
