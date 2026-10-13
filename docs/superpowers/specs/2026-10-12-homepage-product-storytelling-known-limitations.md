# Homepage product storytelling — known limitations

Records the first 2.5D homepage illustration trial, limited to the existing “How it works” diagram.

## What changed

- The flat branch diagram is now a layered SVG composition: one shared repository, three session worktrees, trial-merge evidence, two blocked outcomes, and one ready path that lands back into `main`.
- CSS keeps the scene flat and adds optional scroll-linked settling plus moving route dashes. The complete final composition remains in the SVG itself, so browsers without CSS view-timeline support still show the whole workflow.
- The diagram can be explored through hover, keyboard focus, or touch selection; a localized detail panel and native SVG titles explain each major part.
- The English and Vietnamese accessible descriptions now match the new composition.
- The page remains a static HTML build with no new dependencies, external assets or runtime service.

## Limitations

- Scroll-linked layer movement requires CSS `animation-timeline: view()` support; other browsers show the static final composition. Route dashes animate only when motion is allowed; reduced-motion users see complete, still routes.
- Motion and layout were inspected in desktop Chrome and a narrow Chrome window. Safari, Firefox, physical mobile devices, 200% zoom, and assistive-technology combinations were not checked in this milestone.
- Only the “How it works” diagram changed. The hero, the rest of the homepage, and other site pages retain their existing design and motion.
- The visual uses layered vector shapes for 2.5D depth; it is not a real-time 3D scene.
- Native tooltip appearance and delay vary by browser. The separate detail panel remains the consistent explanation surface, including on touch screens.
