import React from 'react';
import { useSSRStore } from '@taujs/react';

export const App = () => {
  const data = useSSRStore<Record<string, unknown>>();

  return (
    <main>
      <h1>τjs playground</h1>
      <p>Fixture app for the introspection substrate. Initial data below.</p>
      <pre id="initial-data">{JSON.stringify(data, null, 2)}</pre>
    </main>
  );
};
