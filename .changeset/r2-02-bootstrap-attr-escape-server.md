---
'@taujs/server': patch
---

R2-02 (SEC2): attribute-escape the bootstrap-module `src` at both server emission sites.

A new server-local `escapeHtmlAttribute` (the server is renderer-agnostic and does not import the
renderers' `escapeHtml`) now escapes the config-controlled bootstrap-module URL where it is
interpolated into a `<script … src="…">` tag — the SSR-path tag in `HandleRender` AND
`injectBootstrapModule` in `Templates` (used by the not-found path). Defence-in-depth: the value is
config-controlled, so a normal module URL is unchanged; this closes the raw-attribute interpolation.
`patch` per the versioning cap (no server major/minor for this).
