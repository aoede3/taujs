import React, { Suspense, useState, useCallback } from 'react';

import fastifyLogo from '@client/assets/images/fastify.svg';
import reactLogo from '@client/assets/images/react.svg';
import { useHydrationCheck } from '@client/utils/useHydrationCheck';

import '@client/assets/styling/App.scss';

const DataComponent = React.lazy(() => import('@client/components/DataComponent'));

export const App = () => {
  const [count, setCount] = useState(0);
  const isHydrated = useHydrationCheck();

  const handleClick = useCallback(() => {
    if (isHydrated) setCount((prevCount) => prevCount + 1);
  }, [isHydrated]);

  return (
    <>
      <div>
        <a href="https://taujs.io" target="_blank" title="taujs [ &tau;js ]" rel="noreferrer">
          <img src="/taujs.svg" className="logo &tau;js" alt="&tau;js logo" />
        </a>
        <h1 className="&tau;js">taujs [ &tau;js ]</h1>
      </div>
      <div>
        <a href="https://fastify.dev" target="_blank" title="Fastify: Fast and low overhead web framework, for Node.js" rel="noreferrer">
          <img src={fastifyLogo} className="logo" alt="Fastify logo" />
        </a>
        <a href="https://vitejs.dev" target="_blank" title="Vite: Next Generation Frontend Tooling" rel="noreferrer">
          <img src={'/vite.svg'} className="logo" alt="Vite logo" />
        </a>
        <a href="https://reactjs.org" target="_blank" title="React: The library for web and native user interfaces" rel="noreferrer">
          <img src={reactLogo} className="logo react" alt="React logo" />
        </a>
      </div>
      <p className="read-the-docs">Click on logos to learn more</p>
      <h2>Streaming SSR & Hydration (Fastify + React)</h2>
      <h3>
        Development:&nbsp;
        <a href="https://tsx.is/" target="_blank" title="A Node.js enhancement to run TypeScript">
          tsx (TS eXecute)
        </a>
        &nbsp;/&nbsp;(
        <a href="https://vitejs.dev/guide/ssr#setting-up-the-dev-server" target="_blank" title="Vite decoupled from the production environment">
          ViteDevServer HMR
        </a>
        &nbsp;+&nbsp;
        <a href="https://vitejs.dev/guide/api-vite-runtime" target="_blank" title="Low-level API precursor to Environment API">
          Vite Runtime API
        </a>
        )
      </h3>
      <h3>
        Build:&nbsp;client&nbsp; (
        <a href="https://vitejs.dev/guide/ssr#building-for-production" target="_blank" title="Next Generation Frontend Tooling">
          Vite
        </a>
        ) &nbsp;/ server&nbsp; (
        <a href="https://esbuild.github.io/" target="_blank" title="An extremely fast bundler for the web">
          ESBuild
        </a>
        &nbsp;+&nbsp;
        <a href="https://rollupjs.org/" target="_blank" title="The JavaScript module bundler">
          Rollup
        </a>
        )
      </h3>

      <Suspense fallback={<p className="fallback">Streaming Suspense & Hydrated Data Loading...</p>}>
        <DataComponent />
      </Suspense>

      <div className="card">
        <button type="button" onClick={handleClick}>
          count is {count}
        </button>
        <p>
          Edit <code>src/client/App.tsx</code> and save to test HMR
        </p>
      </div>
    </>
  );
};
