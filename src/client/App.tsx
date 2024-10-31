import React, { useState, useCallback } from 'react';
import { Route, Routes, Link } from 'react-router-dom';

import Header from '@client/components/Header';
import PageSPA from '@client/pages/PageSPA';
import PageSSR from '@client/pages/PageSSR';
import PageStreamingSSR from '@client/pages/PageStreamingSSR';
import Page404 from '@client/pages/Page404';

import '@client/assets/styling/App.scss';

export const App: React.FC = () => {
  const [count, setCount] = useState(0);
  const handleClick = useCallback(() => {
    setCount((prevCount) => prevCount + 1);
  }, []);

  return (
    <>
      <Header />

      <div className="card">
        <nav className="navigation">
          <a className="btn" href="/">
            SPA
          </a>
          <a className="btn" href="/ssr">
            SSR{' '}
          </a>
          <a className="btn" href="/streaming/ssr">
            Streaming SSR
          </a>
        </nav>

        <div className="page__container">
          <Routes>
            <Route path="/" element={<PageSPA />} />
            <Route path="/ssr" element={<PageSSR />} />
            <Route path="/streaming/ssr" element={<PageStreamingSSR />} />
            <Route path="*" element={<Page404 />} />
          </Routes>
        </div>

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
