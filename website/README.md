# taujs.dev website

The documentation site for **τjs**, built with [Astro](https://astro.build) and
[Starlight](https://starlight.astro.build). Published at <https://taujs.dev>.

It lives inside the τjs monorepo as a **self-contained, isolated pnpm project**:
it is deliberately *not* a root workspace member, so it never takes part in the
library build or `changeset publish`, and is never published to npm.

## Develop

```sh
cd website
pnpm install     # first time only
pnpm dev         # local dev server with hot reload
```

## Build

```sh
pnpm build       # static site -> dist/
pnpm preview     # serve the production build locally
```

## How it fits together

- **Package manager:** pnpm, pinned via `packageManager`. Isolation from the
  root workspace comes from this folder's own `pnpm-workspace.yaml`
  (`packages: []`), which makes it a separate workspace root.
- **Build scripts:** pnpm 10 blocks dependency lifecycle scripts by default; the
  approved native deps (`esbuild`, `sharp`) are listed under
  `pnpm.onlyBuiltDependencies` in `package.json`.
- **Content** lives in `src/content/docs/`; the sidebar/navigation is configured
  in `astro.config.mjs`.
- **Deploy** is currently a manual `pnpm build` followed by uploading `dist/`
  to the host over SFTP.
