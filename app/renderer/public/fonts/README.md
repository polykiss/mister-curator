# IBM Plex (self-hosted)

These woff2 files are the Latin and Latin-Extended subsets of IBM Plex
Sans (variable, weights 400/500/600/700) and IBM Plex Mono (static,
weights 400/500/600), copied from the Google Fonts CDN.

We self-host because the renderer's CSP (`default-src 'self'`) does not
permit a `style-src` to `fonts.googleapis.com` or a `font-src` to
`fonts.gstatic.com`, and because the app should paint correctly when
the user is on a LAN-only network with no Internet access.

License: SIL Open Font License 1.1. © IBM. See
https://github.com/IBM/plex/blob/master/LICENSE.txt.

If a future PR needs additional subsets (Cyrillic, Greek, Vietnamese),
fetch them via the same `https://fonts.googleapis.com/css2?family=...`
URL with a modern `User-Agent`, then drop the woff2 files alongside
these and add matching `@font-face` rules in `app/renderer/src/index.css`.
