import React, { useState, useCallback } from 'react';

import DataComponent from './components/DataComponent';
import Header from './components/Header';

import './assets/styling/App.scss';

export const App: React.FC = () => {
  const [count, setCount] = useState(0);
  const handleClick = useCallback(() => {
    setCount((prevCount) => prevCount + 1);
  }, []);
  return (
    <>
      <Header />
      <DataComponent />

      <p>Separate micro-frontend orchestrated and served from same server instance</p>
      <p>Production bundled via dynamic isolated Vite build process</p>
      <nav className="navigation">
        <a className="btn" href="/">
          CSR
        </a>
        <a className="btn" href="/ssr">
          SSR
        </a>
        <a className="btn" href="/streaming/ssr">
          Streaming SSR
        </a>
        <a className="btn" href="/mfe/3">
          MFE
        </a>
      </nav>

      <button type="button" onClick={handleClick}>
        count is {count}
      </button>

      <p>
        Edit <code>src/client/@admin/App.tsx</code> and save to test HMR
      </p>
    </>
  );
};
