import { useState, useEffect } from 'react';

export const useHydrationCheck = () => {
  const [isHydrated, setIsHydrated] = useState(false);

  useEffect(() => {
    if (isHydrated) return;

    const checkHydration = () => {
      if (window.__INITIAL_DATA__) {
        setIsHydrated(true);
      } else {
        setTimeout(checkHydration, 50);
      }
    };
    checkHydration();
  }, [isHydrated]);

  return isHydrated;
};
