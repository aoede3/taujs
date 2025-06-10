import React from 'react';
import { hydrateApp } from '@taujs/react';

import AppBootstrap from './AppBootstrap';

hydrateApp({ appComponent: <AppBootstrap />, debug: true });
