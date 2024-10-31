import React, { Suspense } from 'react';

const DataComponent = React.lazy(() => import('@client/components/DataComponent'));

const StreamingSSRPage = () => {
  return (
    <Suspense fallback={<p className="fallback">Streaming Suspense & Hydrated Data Loading 5s Delay...</p>}>
      <DataComponent />
    </Suspense>
  );
};

export default StreamingSSRPage;
