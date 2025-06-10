import React from 'react';

import fastifyLogo from '@client/assets/images/fastify.svg';
import reactLogo from '@client/assets/images/react.svg';

const Header = () => {
  return (
    <>
      <div className="container__taujs">
        <div className="logo-wrapper">
          <a href="https://taujs.io" target="_blank" title="taujs [ &tau;js ]" rel="noreferrer">
            <img src="/taujs.svg" className="logo &tau;js" alt="&tau;js logo" />
          </a>
        </div>
        <h1 className="&tau;js">taujs [ &tau;js ]</h1>
        <h2 className="rendering">CSR; SSR; Streaming SSR; Hydration</h2>
        <h2 className="smpa">Single and or Multiple Page Application(s)</h2>
        <h2 className="">Flexible 'build-time' &amp; server orchestrated micro-frontend(s)</h2>
      </div>
      <div className="container__logos">
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

      <h3>
        Production:&nbsp;
        <a href="https://fastify.dev" target="_blank" title="Fastify: Fast and low overhead web framework, for Node.js" rel="noreferrer">
          Fastify
        </a>
        &nbsp;+&nbsp;
        <a href="https://reactjs.org" target="_blank" title="React: The library for web and native user interfaces" rel="noreferrer">
          React
        </a>
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
      <h3>
        Development:&nbsp;
        <a href="https://tsx.is/" target="_blank" title="A Node.js enhancement to run TypeScript">
          tsx (TS eXecute)
        </a>
        &nbsp;/&nbsp;(
        <a href="https://vitejs.dev/guide/ssr#setting-up-the-dev-server" target="_blank" title="Vite decoupled from the production environment">
          ViteDevServer HMR
        </a>
        )
      </h3>
    </>
  );
};

export default Header;
