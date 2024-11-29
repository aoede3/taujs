import React from 'react';
import { hydrateApp } from '@taujs/server/data';

import AppBootstrap from './AppBootstrap';

const adminHydrate = 'LOVE ME T';

const moob = adminHydrate;

hydrateApp({ appComponent: <AppBootstrap />, debug: true });
