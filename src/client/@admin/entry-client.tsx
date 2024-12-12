import React from 'react';
import { hydrateApp } from '@taujs/server/data';

import AppBootstrap from './AppBootstrap';

hydrateApp({ appComponent: <AppBootstrap />, debug: true });
