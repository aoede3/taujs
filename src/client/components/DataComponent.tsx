import React from 'react';
import { useSSRStore } from '@taujs/react';

const DataComponent = () => {
  const data = useSSRStore();

  return <pre>{JSON.stringify(data, null, 2)}</pre>;
};

export default DataComponent;
