import React, { Suspense, useState, useCallback } from 'react';

import Header from '@client/components/Header';

import '@client/assets/styling/App.scss';

const DataComponent = React.lazy(() => import('@client/components/DataComponent'));

export const App = () => {
  const [count, setCount] = useState(0);
  const handleClick = useCallback(() => {
    setCount((prevCount) => prevCount + 1);
  }, []);

  return (
    <>
      <Header />

      <Suspense fallback={<p className="fallback">Streaming Suspense & Hydrated Data Loading...</p>}>
        <DataComponent />
      </Suspense>

      <div className="card">
        <button type="button" onClick={handleClick}>
          count is {count}
        </button>
        <a className="btn" href="/srr">
          SSR 1x param
        </a>
        <a className="btn" href="/streaming/srr">
          Streaming SSR 2x param
        </a>
        <p>
          Edit <code>src/client/App.tsx</code> and save to test HMR
        </p>
      </div>
    </>
  );
};
