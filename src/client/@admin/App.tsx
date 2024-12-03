import React from 'react';

import DataComponent from './components/DataComponent';
import Header from './components/Header';

import './assets/styling/App.scss';

export const App: React.FC = () => {
  return (
    <>
      <Header />
      <DataComponent />
      <a href="https://vite.dev/guide/build#multi-page-app" target="_blank">
        Vite MPA: Multi-Page Application
      </a>
      <p>Seperate application associated via seperate entry point.</p>
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
        <a className="btn" href="/mpa/3">
          MPA
        </a>
      </nav>
    </>
  );
};
