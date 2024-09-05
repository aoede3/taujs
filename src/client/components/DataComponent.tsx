import React from 'react';
import { useSSRStore } from '@taujs/server/data-store';

const DataComponent = () => {
  const data = useSSRStore();

  return <pre>{JSON.stringify(data, null, 2)}</pre>;
};

export default DataComponent;
