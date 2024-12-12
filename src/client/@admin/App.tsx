import React from 'react';

import DataComponent from './components/DataComponent';
import Header from './components/Header';

import './assets/styling/App.scss';

export const App: React.FC = () => {
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
    </>
  );
};
