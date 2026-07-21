# @taujs/solid

`npm install @taujs/solid`

`yarn add @taujs/solid`

`pnpm add @taujs/solid`

# τjs

Solid Renderer: CSR, SSR, Streaming SSR

https://taujs.dev/

A lightweight, production-ready Solid SSR library with streaming capabilities, built for modern TypeScript applications. Designed as part of the taujs (τjs) ecosystem but fully standalone and runtime-agnostic.

> `solid-js` is a required peer. `vite`, `vite-plugin-solid` and `typescript` are optional peers, needed only when you consume `@taujs/solid/renderer` (the managed compiler) or `@taujs/solid/plugin`; the runtime author surface at `@taujs/solid` needs none of them.

> **Known limitation (solid-js 1.9.x):** interactions that occur before hydration completes may be lost. Solid captures the event but its later replay finds an expired event path, so no handler runs. See the renderer guide for detail.

https://taujs.dev/renderers/solid/
