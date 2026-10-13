# Website stylesheet cache-key design

## Problem

The static site publishes updated HTML and `styles.css` at stable URLs. GitHub Pages/edge caching currently gives the CSS a four-hour lifetime, while HTML may refresh sooner. A browser can therefore combine new workflow SVG markup with CSS cached from before those SVG card and label classes existed. Unstyled SVG rectangles and text use black defaults, producing the black cards and unreadable labels in the reported screenshot.

## Decision

Keep the generated asset name and contents at `/styles.css`, but include a short SHA-256 fingerprint of the exact generated CSS contents in every page's stylesheet URL: `/styles.css?v=<fingerprint>`. Compute the fingerprint during the static build from the same string that is written to disk. Any CSS change then produces a new cache key, while unchanged builds stay deterministic. The change adds no runtime, dependency, native module, or server behavior.

The HTML continues to use same-origin external styles, so the current Content Security Policy remains valid. The site CSS itself is not duplicated or inlined.

## Verification contract

- A rendered page's CSS URL includes the fingerprint for the CSS bytes written by that build.
- Unchanged CSS produces the same fingerprint; changing CSS changes the URL.
- Both the default GitHub Pages base path and the custom domain build resolve the versioned stylesheet URL correctly.
- A browser loads the fingerprinted asset and the SVG card fill/text colors resolve to the theme tokens.

## Limitations

Already-open tabs keep their current document until refreshed. Existing cached HTML and its matching old stylesheet remain a consistent pair; refreshing obtains the new stylesheet URL. Other static assets keep their current cache behavior because this bug is specifically caused by CSS and SVG class changes.
